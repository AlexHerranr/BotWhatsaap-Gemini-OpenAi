import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"

// --- Funciones typing y stopTyping (como las tienes ahora, con ctx.key.remoteJid y logs) ---
const typing = async (ctx: any, provider: any): Promise<void> => {
    console.log(`DEBUG: Intentando iniciar typing para JID (via ctx.key.remoteJid): ${ctx.key?.remoteJid || 'JID no encontrado en ctx.key'}`);
    if (provider && provider.vendor && typeof provider.vendor.sendPresenceUpdate === 'function') {
        const remoteJid = ctx.key?.remoteJid;
        if (remoteJid) {
            try {
                await provider.vendor.sendPresenceUpdate('composing', remoteJid);
                console.log(`DEBUG: 'composing' presence enviado para ${remoteJid}`);
            } catch (e) {
                console.error("Error al enviar 'composing' presence:", e instanceof Error ? e.message : String(e));
            }
        } else {
            console.warn("DEBUG: ctx.key.remoteJid no está disponible. No se puede enviar 'composing'.");
        }
    } else {
        console.warn("DEBUG: Provider, provider.vendor, o sendPresenceUpdate no disponible para 'typing'");
    }
};

const stopTyping = async (ctx: any, provider: any): Promise<void> => {
    console.log(`DEBUG: Intentando detener typing para JID (via ctx.key.remoteJid): ${ctx.key?.remoteJid || 'JID no encontrado en ctx.key'}`);
    if (provider && provider.vendor && typeof provider.vendor.sendPresenceUpdate === 'function') {
        const remoteJid = ctx.key?.remoteJid;
        if (remoteJid) {
            try {
                await provider.vendor.sendPresenceUpdate('paused', remoteJid);
                console.log(`DEBUG: 'paused' presence enviado para ${remoteJid}`);
            } catch (e) {
                console.error("Error al enviar 'paused' presence:", e instanceof Error ? e.message : String(e));
            }
        } else {
            console.warn("DEBUG: ctx.key.remoteJid no está disponible. No se puede enviar 'paused'.");
        }
    } else {
        console.warn("DEBUG: Provider, provider.vendor, o sendPresenceUpdate no disponible para 'stopTyping'");
    }
}
// --- Fin de funciones typing y stopTyping ---

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008;
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
// ... (resto de constantes CLEAN_REGEX, API_TIMEOUT, etc. permanecen igual)
const API_TIMEOUT = 60000;
const MAX_RETRIES = 3;
const MAX_QUEUE_SIZE = 10;
const CLEAN_REGEX = /【.*?】[ ]?/g;
const MIN_INITIAL_WAIT = 2000;
const MAX_INITIAL_WAIT = 5000;
const MIN_MESSAGE_DELAY = 1500;
const MAX_MESSAGE_DELAY = 4000;
const TYPING_SPEED = 1200;
const MAX_LINES_PER_MESSAGE = 4;
const MAX_MESSAGE_LENGTH = 250;
const CHARS_PER_LINE_ESTIMATE = 60;

const userQueues = new Map<string, Array<any>>();
const userLocks = new Map<string, boolean>();
const responseCache = new Map<string, string>();
const userDailyUsage = new Map<string, number>();

const randomDelay = async (min: number, max: number): Promise<void> => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
};

const calculateTypingTime = (text: string): number => { // No se usará en PUM simplificado
    const charCount = text.length;
    const msPerChar = 60000 / TYPING_SPEED;
    const variability = 0.8 + (Math.random() * 0.4);
    return Math.max(1000, Math.floor(charCount * msPerChar * variability));
};

const splitIntoHumanChunks = (text: string): string[] => { // No se usará en PUM simplificado
    text = text.trim().replace(CLEAN_REGEX, "");
    if (!text) return [];
    const chunks: string[] = [];
    const majorParagraphs = text.split(/[\n\r]{2,}/);
    for (const p of majorParagraphs) {
        const paragraphContent = p.trim();
        if (!paragraphContent) continue;
        const estimatedLinesInParagraph = Math.ceil(paragraphContent.length / CHARS_PER_LINE_ESTIMATE);
        if (paragraphContent.length <= MAX_MESSAGE_LENGTH && estimatedLinesInParagraph <= MAX_LINES_PER_MESSAGE) {
            chunks.push(paragraphContent);
            continue;
        }
        const sentences = paragraphContent.match(/[^.!?]+(?:[.!?]+["']?\s*|$)/g) || [paragraphContent];
        let currentChunk = "";
        for (const sentenceRaw of sentences) {
            const sentence = sentenceRaw.trim();
            if (!sentence) continue;
            const sentenceEstimatedLines = Math.ceil(sentence.length / CHARS_PER_LINE_ESTIMATE);
            if (currentChunk === "") {
                if (sentence.length > MAX_MESSAGE_LENGTH || sentenceEstimatedLines > MAX_LINES_PER_MESSAGE) {
                    chunks.push(sentence);
                } else {
                    currentChunk = sentence;
                }
                continue;
            }
            const potentialChunk = currentChunk + " " + sentence;
            const potentialChunkEstimatedLines = Math.ceil(potentialChunk.length / CHARS_PER_LINE_ESTIMATE);
            if (potentialChunk.length <= MAX_MESSAGE_LENGTH && potentialChunkEstimatedLines <= MAX_LINES_PER_MESSAGE) {
                currentChunk = potentialChunk;
            } else {
                chunks.push(currentChunk);
                if (sentence.length > MAX_MESSAGE_LENGTH || sentenceEstimatedLines > MAX_LINES_PER_MESSAGE) {
                    chunks.push(sentence);
                    currentChunk = "";
                } else {
                    currentChunk = sentence;
                }
            }
        }
        if (currentChunk) {
            chunks.push(currentChunk);
        }
    }
    return chunks.filter(chunk => chunk.length > 0);
};

const trackUserUsage = (userId: string): void => {
    const today = new Date().toISOString().split('T')[0];
    const key = `${userId}-${today}`;
    const currentUsage = userDailyUsage.get(key) || 0;
    userDailyUsage.set(key, currentUsage + 1);
    console.log(`Usuario ${userId.split('@')[0]}: ${userDailyUsage.get(key)} solicitudes hoy`);
};

const getAssistantResponse = async (assistantId: string, message: string, state: any): Promise<string> => {
    // ... (esta función permanece igual)
    const cacheKey = `${assistantId}-${message}`;
    if (responseCache.has(cacheKey)) {
        console.log("Respuesta obtenida de caché");
        return responseCache.get(cacheKey) as string;
    }
    let lastError: any;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const responsePromise = toAsk(assistantId, message, state);
            const timeoutPromise = new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error("Timeout esperando respuesta de OpenAI")), API_TIMEOUT)
            );
            const response = await Promise.race([responsePromise, timeoutPromise]);
            if (typeof response === 'string') {
                if (message.length < 100 && response.length < 1000) {
                    responseCache.set(cacheKey, response);
                    if (responseCache.size > 100) {
                        const oldestKey = responseCache.keys().next().value;
                        if (oldestKey) responseCache.delete(oldestKey);
                    }
                }
                return response;
            } else {
                console.error("Respuesta de toAsk no es un string:", response);
                throw new Error("Formato de respuesta inesperado de OpenAI");
            }
        } catch (error) {
            console.error(`Intento ${attempt}/${MAX_RETRIES} fallido para OpenAI:`, error instanceof Error ? error.message : String(error));
            lastError = error;
            if (attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`Reintentando en ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError || new Error("No se pudo obtener respuesta de OpenAI después de varios reintentos.");
};

// --- VERSIÓN SIMPLIFICADA DE processUserMessage PARA PRUEBA ---
const processUserMessage = async (ctx: any, { flowDynamic, state, provider }: any): Promise<void> => {
    const userId = ctx.key?.remoteJid || ctx.from; // Usamos remoteJid consistentemente si está disponible
    console.log(`SIMPLIFIED PUM: Procesando mensaje para ${userId.split('@')[0]}`);
    trackUserUsage(userId);

    try {
        console.log("SIMPLIFIED PUM: Llamando a typing(ctx, provider) al inicio.");
        await typing(ctx, provider); // Llamar a typing una vez al inicio

        // PAUSA DELIBERADA para observar el indicador "escribiendo..."
        const DURATION_TO_TEST_TYPING_MS = 5000; // 5 segundos
        console.log(`SIMPLIFIED PUM: Pausando por ${DURATION_TO_TEST_TYPING_MS / 1000}s para observar el indicador "escribiendo..."`);
        await new Promise(resolve => setTimeout(resolve, DURATION_TO_TEST_TYPING_MS));

        const rawResponse = await getAssistantResponse(ASSISTANT_ID, ctx.body, state);
        console.log("SIMPLIFIED PUM: Respuesta obtenida de OpenAI.");

        // Lógica de envío simplificada, similar a tu código viejo
        const responseChunks = rawResponse.split(/\n\n+/); // Dividir por doble salto de línea
        for (const chunk of responseChunks) {
            const cleanedChunk = chunk.trim().replace(CLEAN_REGEX, "");
            if (cleanedChunk) { // Solo enviar si el chunk no está vacío después de limpiar
                console.log(`SIMPLIFIED PUM: Enviando chunk: "${cleanedChunk.substring(0, 50)}..."`);
                await flowDynamic([{ body: cleanedChunk }]);
                // Pequeño retraso fijo entre estos chunks simples para esta prueba
                await new Promise(resolve => setTimeout(resolve, 300)); // 0.3 segundos
            }
        }
        console.log("SIMPLIFIED PUM: Todos los chunks enviados.");

    } catch (error) {
        console.error(`SIMPLIFIED PUM: Error procesando mensaje para ${userId.split('@')[0]}:`, error instanceof Error ? error.message : String(error));
        await randomDelay(1000, 2000); 
        await flowDynamic([{
            body: "Ups, algo no salió como esperaba (prueba simplificada). ¿Podrías intentarlo de nuevo?"
        }]);
    } finally {
        console.log("SIMPLIFIED PUM: Llamando a stopTyping(ctx, provider) en el bloque finally.");
        await stopTyping(ctx, provider); // Llamar a stopTyping al final
    }
};
// --- FIN DE VERSIÓN SIMPLIFICADA ---

// ... (handleQueue, welcomeFlow, main permanecen IGUAL que en tu última versión funcional)
const handleQueue = async (userId: string): Promise<void> => {
    const queue = userQueues.get(userId);
    if (!queue || userLocks.get(userId)) {
        return;
    }
    userLocks.set(userId, true);
    console.log(`Procesando cola para ${userId.split('@')[0]}. Mensajes pendientes: ${queue.length}`);
    while (queue.length > 0) {
        const task = queue.shift();
        if (task) {
            const { ctx, flowDynamic, state, provider } = task;
            try {
                await processUserMessage(ctx, { flowDynamic, state, provider });
            } catch (error) {
                console.error(`Error grave procesando item de la cola para ${userId.split('@')[0]}, continuando.`);
            }
            if (queue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }
    userLocks.delete(userId);
    console.log(`Cola para ${userId.split('@')[0]} procesada.`);
};

const welcomeFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; 
        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }
        const queue = userQueues.get(userId);
        if (queue && queue.length >= MAX_QUEUE_SIZE) {
            console.log(`Cola para ${userId.split('@')[0]} llena. Mensaje rechazado temporalmente.`);
            await flowDynamic([{
                body: "Estoy procesando varios de tus mensajes anteriores. Dame un momentito, por favor."
            }]);
            return;
        }
        console.log(`Nuevo mensaje de ${userId.split('@')[0]} añadido a la cola. Cuerpo: "${ctx.body}"`);
        if (queue) queue.push({ ctx, flowDynamic, state, provider });
        if (!userLocks.get(userId)) {
            handleQueue(userId);
        }
    });

const main = async (): Promise<void> => {
    console.log(`Iniciando WhatsApp AI Assistant Bot en puerto ${PORT}`);
    if (!ASSISTANT_ID) {
        console.error("ERROR: ASSISTANT_ID no está configurado en las variables de entorno.");
        process.exit(1);
    }
    console.log(`Usando ID de asistente: ${ASSISTANT_ID.substring(0, 10)}...`);
    const adapterFlow = createFlow([welcomeFlow]);
    const adapterProvider = createProvider(BaileysProvider); 
    const adapterDB = new MemoryDB();
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });
    const httpServerFn = httpServer; 
    if (adapterProvider.server && typeof httpInject === 'function') {
        httpInject(adapterProvider.server);
         console.log("Servicio httpInject aplicado al provider.");
    } else {
        console.warn("httpInject no se pudo aplicar.");
    }
    if (httpServerFn && typeof httpServerFn === 'function') {
        httpServerFn(Number(PORT));
    } else {
        console.error("La función para iniciar el servidor HTTP (httpServer) no se pudo obtener o no es una función.");
    }
};

main().catch(err => {
    console.error("Error fatal al iniciar el bot:", err);
});