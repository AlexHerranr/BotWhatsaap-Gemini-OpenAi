import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot' // Si ลักษณะDB es el tipo real del estado, podrías re-añadirlo: import { MemoryDB, ลักษณะDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"

// --- Constantes ---
const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
const CHUNK_DELAY_MS = 150;
const OPENAI_COOLDOWN_MS = 3000;
const CLEAN_REGEX = /【.*?】[ ]?/g;
const USER_INACTIVITY_TIMEOUT_MS = 4000; // Nombre corregido y estándar
const ENCARGADO_SYNC_PREFIX = "[SYNC]";

// --- Almacenamiento para colas y bloqueos ---
const userQueues = new Map<string, Array<any>>();
const userLocks = new Map<string, boolean>();

// Interfaz para el buffer de mensajes del usuario
interface UserMessageBuffer {
    messages: string[];
    lastCtx: any;
    flowDynamic: any;
    state: any; // Usamos 'any' para flexibilidad con el estado de BuilderBot. Si tienes un tipo exacto (como ลักษณะDB), puedes usarlo.
    provider: any;
}
const userMessageBuffers = new Map<string, UserMessageBuffer>();
const userActivityTimers = new Map<string, NodeJS.Timeout>();


// --- Funciones de Logging Personalizadas ---
const getFormattedTimestamp = (): string => {
    const now = new Date();
    const dateOptions: Intl.DateTimeFormatOptions = { year: '2-digit', month: '2-digit', day: '2-digit' };
    const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    
    const date = now.toLocaleDateString('es-CO', dateOptions);
    const time = now.toLocaleTimeString('es-CO', timeOptions);
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${date} ${time}.${ms}`;
};

const customLog = (level: 'INFO' | 'WARN' | 'ERROR', context: string, ...messages: any[]) => {
    const timestamp = getFormattedTimestamp();
    const messageParts = messages.map(msg => {
        if (msg instanceof Error) return msg.stack || msg.message;
        if (typeof msg === 'object' && msg !== null) {
            try {
                return JSON.stringify(msg, null, 2);
            } catch (e) {
                return '[Objeto no serializable]';
            }
        }
        return String(msg);
    });
    const logLine = `[${timestamp}] [${level}] ${context}: ${messageParts.join(' ')}`;

    switch (level) {
        case 'INFO':
            console.log(logLine);
            break;
        case 'WARN':
            console.warn(logLine);
            break;
        case 'ERROR':
            console.error(logLine);
            break;
    }
};

// --- Funciones de Ayuda ---
const getShortUserId = (ctxOrUserId: any): string => {
    if (typeof ctxOrUserId === 'string') {
        return ctxOrUserId.split('@')[0] || ctxOrUserId;
    }
    return ctxOrUserId?.from?.split('@')[0] || ctxOrUserId?.from || 'unknownUser';
};

// --- Función de Typing ---
const typing = async (ctx: any, provider: any): Promise<void> => {
    const remoteJid = ctx.key?.remoteJid;
    const shortUserId = getShortUserId(ctx);
    const logContext = `TYPING [${shortUserId}]`;

    if (provider?.vendor?.sendPresenceUpdate && typeof provider.vendor.sendPresenceUpdate === 'function') {
        if (remoteJid) {
            try {
                await provider.vendor.sendPresenceUpdate('composing', remoteJid);
            } catch (e) {
                customLog('ERROR', logContext, `Error al enviar 'composing':`, e);
            }
        } else {
            customLog('WARN', logContext, `ctx.key.remoteJid no disponible.`);
        }
    }
};

/**
 * Procesa el mensaje del usuario interactuando con OpenAI y enviando la respuesta.
 */
const processUserMessage = async (ctx: any, { flowDynamic, state, provider }: any) => {
    const shortUserId = getShortUserId(ctx); // ctx.from es el ID del cliente
    const logContext = `PROCESS_MSG [${shortUserId}]`;
    let mensajeParaOpenAI = ctx.body;

    const esperandoEncargado = await state.get('esperando_respuesta_encargado');
    if (esperandoEncargado) {
        const temaConsulta = await state.get('tema_consulta_encargado') || 'un tema previo';
        const notaContextual = `[Nota para el Asistente: El usuario podría estar respondiendo a información proporcionada manualmente por un encargado sobre "${temaConsulta}". Por favor, ten esto en cuenta al generar tu respuesta.]\n\n`;
        mensajeParaOpenAI = notaContextual + ctx.body;
        customLog('INFO', logContext, `Añadiendo nota contextual para OpenAI sobre "${temaConsulta}".`);
        await state.update({ esperando_respuesta_encargado: false, tema_consulta_encargado: null });
    }

    customLog('INFO', logContext, `Iniciando procesamiento OpenAI para: "${mensajeParaOpenAI.substring(0,100)}..."`);
    await typing(ctx, provider);

    customLog('INFO', logContext, `Solicitando respuesta a OpenAI Assistant (${ASSISTANT_ID.substring(0,10)})...`);
    const response = await toAsk(ASSISTANT_ID, mensajeParaOpenAI, state);
    customLog('INFO', logContext, `Respuesta de OpenAI recibida: "${response.substring(0,50)}..."`);

    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(CLEAN_REGEX, "");
        if (cleanedChunk) {
            customLog('INFO', logContext, `Enviando chunk: "${cleanedChunk.substring(0, 50)}..."`);
            await flowDynamic([{ body: cleanedChunk }]);
            
            if (cleanedChunk.toLowerCase().includes("espere, me comunico con el encargado") || 
                cleanedChunk.toLowerCase().includes("confirmo con encargado") ||
                cleanedChunk.toLowerCase().includes("confirmo los precios en el sistema y le aviso")) {
                let tema = "información general";
                const originalUserQuery = ctx.body; 
                if (originalUserQuery.toLowerCase().includes("precio")) tema = "precios";
                if (originalUserQuery.toLowerCase().includes("disponibilidad")) tema = "disponibilidad";
                if (originalUserQuery.toLowerCase().includes("ubicado") || originalUserQuery.toLowerCase().includes("distancia")) tema = "ubicación";
                
                await state.update({ esperando_respuesta_encargado: true, tema_consulta_encargado: tema });
                customLog('INFO', logContext, `Bot indicó comunicación con encargado sobre tema "${tema}". Estado 'esperando_respuesta_encargado' activado para ${shortUserId}.`);
            }
            await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
        }
    }
    customLog('INFO', logContext, `Todos los chunks enviados para el mensaje original del cliente: "${ctx.body.substring(0,30)}..."`);
};

const handleQueue = async (userId: string) => {
    const queue = userQueues.get(userId);
    const shortUserId = getShortUserId(userId);
    const logContext = `HANDLE_QUEUE [${shortUserId}]`;

    if (!queue) {
        customLog('INFO', logContext, `No se encontró cola.`);
        userLocks.delete(userId);
        return;
    }
    
    if (userLocks.get(userId)) {
        customLog('INFO', logContext, `La cola está bloqueada.`);
        return;
    }

    while (queue.length > 0) {
        if (userLocks.get(userId)) {
            customLog('INFO', logContext, `Bloqueo activado en bucle.`);
            return;
        }
        userLocks.set(userId, true);
        customLog('INFO', logContext, `Bloqueo adquirido.`);
        const task = queue.shift();

        if (task) {
            const { ctx, flowDynamic, state, provider } = task; 
            customLog('INFO', logContext, `Procesando tarea. Restantes: ${queue.length}. Msg: "${ctx.body.substring(0,100)}..."`);
            try {
                await processUserMessage(ctx, { flowDynamic, state, provider });
                customLog('INFO', logContext, `Tarea completada.`);
            } catch (error: any) {
                const errorMessage = error.message || String(error);
                customLog('ERROR', logContext, `Error en tarea para msg "${ctx.body.substring(0,30)}...":`, error);
                if (errorMessage.includes("while a run") && errorMessage.includes("is active")) {
                    customLog('ERROR', logContext, `OpenAI Run activo. Cooldown actual: ${OPENAI_COOLDOWN_MS}ms.`);
                }
            } finally {
                userLocks.set(userId, false);
                customLog('INFO', logContext, `Bloqueo liberado.`);
                if (queue.length > 0) {
                    customLog('INFO', logContext, `${queue.length} en cola. Cooldown ${OPENAI_COOLDOWN_MS}ms.`);
                    await new Promise(resolve => setTimeout(resolve, OPENAI_COOLDOWN_MS));
                }
            }
        } else {
            userLocks.set(userId, false);
            customLog('WARN', logContext, `Bloqueo liberado (tarea nula).`);
            break; 
        }
    }

    if (queue.length === 0 && !userLocks.get(userId)) {
        userQueues.delete(userId);
        userLocks.delete(userId);
        customLog('INFO', logContext, `Cola vacía y desbloqueada. Limpiada.`);
    } else if (queue.length === 0 && userLocks.get(userId)) {
        customLog('WARN', logContext, `Cola vacía pero aún bloqueada.`);
    } else if (queue.length > 0 && !userLocks.get(userId)) {
        customLog('INFO', logContext, `${queue.length} en cola y desbloqueada. Siguiente handleQueue lo tomará.`);
    }
};

const mainFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, args) => {
        const { flowDynamic, state, provider } = args;
        const messageFrom = ctx.from;
        const messageTo = ctx.key.remoteJid;
        const isFromMe = ctx.key.fromMe;
        const currentMessageBody = ctx.body;

        if (isFromMe) {
            const recipientJid = messageTo; 
            const shortRecipientJid = getShortUserId(recipientJid);
            const logContextFromMe = `FROM_ME_HANDLER [to:${shortRecipientJid}]`;

            if (currentMessageBody.startsWith(ENCARGADO_SYNC_PREFIX)) {
                customLog('INFO', logContextFromMe, `Mensaje SYNC de ENCARGADO: "${currentMessageBody.substring(0, 60)}..."`);
                const encargadoMessageContent = currentMessageBody.substring(ENCARGADO_SYNC_PREFIX.length).trim();
                customLog('WARN', logContextFromMe, `ACCIÓN NECESARIA: Sincronizar mensaje del encargado ("${encargadoMessageContent.substring(0,50)}") con thread de OpenAI para cliente ${shortRecipientJid}. Funcionalidad no auto-implementada.`);
                return; 
            } else {
                customLog('INFO', logContextFromMe, `Mensaje saliente del bot (o encargado sin prefijo) ignorado: "${currentMessageBody.substring(0, 60)}..."`);
                return;
            }
        }

        const clientId = messageFrom;
        const shortClientId = getShortUserId(clientId);
        const logContextClient = `CLIENT_MSG_HANDLER [from:${shortClientId}]`;

        customLog('INFO', logContextClient, `Mensaje de cliente "${currentMessageBody.substring(0,30)}..." recibido.`);

        let userBuffer = userMessageBuffers.get(clientId);
        if (!userBuffer) {
            userBuffer = { messages: [], lastCtx: ctx, flowDynamic, state, provider };
            userMessageBuffers.set(clientId, userBuffer);
            customLog('INFO', logContextClient, `Nuevo buffer de mensajes creado.`);
        }
        
        userBuffer.messages.push(currentMessageBody);
        userBuffer.lastCtx = ctx;
        userBuffer.flowDynamic = flowDynamic;
        userBuffer.state = state; 
        userBuffer.provider = provider;

        customLog('INFO', logContextClient, `Mensaje añadido al buffer. Total: ${userBuffer.messages.length}.`);

        if (userActivityTimers.has(clientId)) {
            clearTimeout(userActivityTimers.get(clientId)!);
        }

        const timerId = setTimeout(async () => {
            const finalBuffer = userMessageBuffers.get(clientId); // Obtener el buffer más reciente
            if (finalBuffer && finalBuffer.messages.length > 0) {
                const combinedMessageBody = finalBuffer.messages.join('\n\n');
                // Usar una copia del último ctx, pero con el body combinado
                const taskCtx = { ...finalBuffer.lastCtx, body: combinedMessageBody };
                
                // El state que se pasa aquí es el del cliente, ya almacenado en finalBuffer.state
                const taskState = finalBuffer.state;

                if (!userQueues.has(clientId)) {
                    userQueues.set(clientId, []);
                }
                const queue = userQueues.get(clientId)!;
                queue.push({ 
                    ctx: taskCtx, 
                    flowDynamic: finalBuffer.flowDynamic, 
                    state: taskState, 
                    provider: finalBuffer.provider 
                });
                customLog('INFO', `USER_ACTIVITY_TIMEOUT [from:${shortClientId}]`, `${finalBuffer.messages.length} msgs combinados y encolados: "${combinedMessageBody.substring(0,100)}..."`);

                if (!userLocks.get(clientId)) {
                    customLog('INFO', `USER_ACTIVITY_TIMEOUT [from:${shortClientId}]`, `Cola principal no bloqueada. Iniciando handleQueue.`);
                    handleQueue(clientId);
                } else {
                    customLog('INFO', `USER_ACTIVITY_TIMEOUT [from:${shortClientId}]`, `Cola principal bloqueada. Msg combinado esperará.`);
                }
            }
            userMessageBuffers.delete(clientId); // Limpiar buffer después de procesar
            userActivityTimers.delete(clientId); // Limpiar timer
        }, USER_INACTIVITY_TIMEOUT_MS);

        userActivityTimers.set(clientId, timerId);
        customLog('INFO', logContextClient, `Temporizador de inactividad (${USER_INACTIVITY_TIMEOUT_MS / 1000}s) iniciado/reiniciado.`);
    });

const main = async () => {
    const logContext = `[MAIN_INIT]`;
    customLog('INFO', logContext, `Iniciando el bot en el puerto ${PORT}`);
    if (!ASSISTANT_ID) {
        customLog('ERROR', logContext, `CRITICAL: ASSISTANT_ID no configurado. Saliendo.`);
        process.exit(1);
    }
    customLog('INFO', logContext, `Usando Assistant ID: ${ASSISTANT_ID.substring(0,10)}...`);
    customLog('INFO', logContext, `OpenAI Cooldown: ${OPENAI_COOLDOWN_MS}ms.`);
    customLog('INFO', logContext, `User Inactivity Timeout (Msg Grouping): ${USER_INACTIVITY_TIMEOUT_MS}ms.`);
    customLog('INFO', logContext, `Encargado Sync Prefix: "${ENCARGADO_SYNC_PREFIX}"`);

    const adapterFlow = createFlow([mainFlow]);
    const adapterProvider = createProvider(BaileysProvider, { groupsIgnore: true, readStatus: false });
    const adapterDB = new MemoryDB();
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    if (adapterProvider.server && typeof httpInject === 'function') {
        httpInject(adapterProvider.server);
        customLog('INFO', logContext, `Inyección HTTP aplicada.`);
    } else {
        customLog('WARN', logContext, `No se pudo aplicar inyección HTTP.`);
    }

    if (httpServer && typeof httpServer === 'function') {
        httpServer(Number(PORT));
        customLog('INFO', logContext, `Llamada a httpServer(${PORT}) realizada.`);
    } else {
        customLog('ERROR', logContext, `httpServer no es una función o no se obtuvo.`);
    }
};

main().catch(err => {
    customLog('ERROR', `[MAIN_INIT]`, `Error fatal al iniciar bot:`, err);
    process.exit(1);
});