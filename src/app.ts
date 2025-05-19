import "dotenv/config"
import OpenAI from 'openai';
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import fs from 'fs';

// --- Constantes ---
const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

const CHUNK_DELAY_MS = 150;
const OPENAI_COOLDOWN_MS = 3000;
const CLEAN_REGEX = /【.*?】[ ]?/g;
const USER_INACTIVITY_TIMEOUT_MS = 6000;
const DEBUG_MODE = true;
const DEBUG_LOG_PATH = './whatsapp-sync-debug.log';

// --- Mapeo de conversaciones ---
// Este mapa almacena los thread_ids de OpenAI por cada cliente
const clientThreadIds = new Map();

// --- SDK de OpenAI ---
let openai: OpenAI;
if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log("SDK de OpenAI inicializado correctamente");
} else {
    console.error("CRITICAL_ENV_ERROR: OPENAI_API_KEY no está configurada en el archivo .env.");
}

// --- Almacenamiento para mensajes del bot ---
const botSentMessages = new Set<string>();

// --- Otras estructuras de datos ---
const userQueues = new Map<string, Array<any>>();
const userLocks = new Map<string, boolean>();
const userMessageBuffers = new Map<string, any>();
const userActivityTimers = new Map<string, NodeJS.Timeout>();

// --- Funciones de utilidad ---
const getFormattedTimestamp = (): string => {
    const now = new Date();
    const dateOptions: Intl.DateTimeFormatOptions = { year: '2-digit', month: '2-digit', day: '2-digit' };
    const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const date = now.toLocaleDateString('es-CO', dateOptions);
    const time = now.toLocaleTimeString('es-CO', timeOptions);
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${date} ${time}.${ms}`;
};

const customLog = (level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', context: string, ...messages: any[]) => {
    const timestamp = getFormattedTimestamp();
    const messageParts = messages.map(msg => {
        if (msg instanceof Error) return msg.stack || msg.message;
        if (typeof msg === 'object' && msg !== null) {
            try { return JSON.stringify(msg, null, 2); } catch (e) { return '[Objeto no serializable]'; }
        }
        return String(msg);
    });
    const logLine = `[${timestamp}] [${level}] ${context}: ${messageParts.join(' ')}`;
    switch (level) {
        case 'INFO': console.log(logLine); break;
        case 'WARN': console.warn(logLine); break;
        case 'ERROR': console.error(logLine); break;
        case 'DEBUG': console.debug(logLine); break;
    }
    
    if (DEBUG_MODE && (level === 'ERROR' || level === 'WARN')) {
        try {
            fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] [${level}_${context}] ${messageParts.join(' ')}\n`);
        } catch (e) {
            console.error(`Error escribiendo al log: ${e.message}`);
        }
    }
};

const getShortUserId = (ctxOrUserId: any): string => {
    if (typeof ctxOrUserId === 'string') return ctxOrUserId.split('@')[0] || ctxOrUserId;
    return ctxOrUserId?.from?.split('@')[0] || ctxOrUserId?.from || ctxOrUserId?.key?.remoteJid?.split('@')[0] || 'unknownUser';
};

const extractTextFromMessage = (msg: any): string | null => {
    if (!msg || !msg.message) return null;
    return msg.message.conversation ||
           msg.message.extendedTextMessage?.text ||
           msg.message.imageMessage?.caption ||
           msg.message.videoMessage?.caption ||
           msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
           msg.message.ephemeralMessage?.message?.conversation ||
           null;
};

// --- Función para sincronizar mensajes manuales con OpenAI ---
async function syncManualMessageToOpenAI(jid: string, messageContent: string) {
    const shortJid = getShortUserId(jid);
    const logContext = `SYNC_MANUAL [${shortJid}]`;
    
    try {
        // Verificar si tenemos un thread_id guardado para este cliente
        const threadId = clientThreadIds.get(jid);
        
        if (!threadId) {
            customLog('WARN', logContext, `No se encontró thread_id en memoria para el cliente. No se puede sincronizar.`);
            return false;
        }
        
        customLog('INFO', logContext, `Thread ID encontrado en memoria: ${threadId}. Sincronizando mensaje manual...`);
        
        // Crear el mensaje en el thread de OpenAI con rol de asistente
        const result = await openai.beta.threads.messages.create(threadId, {
            role: 'assistant',
            content: messageContent
        });
        
        customLog('INFO', logContext, `Mensaje sincronizado con OpenAI exitosamente. Message ID: ${result.id}`);
        return true;
    } catch (error) {
        customLog('ERROR', logContext, `Error sincronizando mensaje con OpenAI:`, error);
        return false;
    }
}

// --- Función de typing ---
const typing = async (ctx: any, provider: any): Promise<void> => {
    const remoteJid = ctx.key?.remoteJid;
    if (provider?.vendor?.sendPresenceUpdate && typeof provider.vendor.sendPresenceUpdate === 'function' && remoteJid) {
        try {
            await provider.vendor.sendPresenceUpdate('composing', remoteJid);
        } catch (e) {
            customLog('ERROR', 'TYPING', `Error al enviar 'composing':`, e);
        }
    }
};

// --- Procesa mensajes del usuario ---
const processUserMessage = async (ctx: any, { flowDynamic, state, provider }: any) => {
    const shortUserId = getShortUserId(ctx.from);
    const logContext = `PROCESS_MSG [${shortUserId}]`;
    let mensajeParaOpenAI = ctx.body;
    const clientId = ctx.from;

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
    
    // IMPORTANTE: Extraer y guardar el thread_id del estado para este cliente
    // Usamos un pequeño retraso para asegurar que el estado se haya actualizado completamente
    setTimeout(async () => {
        try {
            const threadInfo = await state.get('openaiAssistant') || await state.get('openai') || {};
            const threadId = threadInfo.thread_id || threadInfo.threadId;
            
            if (threadId) {
                clientThreadIds.set(clientId, threadId);
                customLog('INFO', logContext, `Thread ID extraído y guardado para cliente ${shortUserId}: ${threadId}`);
            }
        } catch (e) {
            customLog('ERROR', logContext, `Error al extraer thread_id del estado:`, e);
        }
    }, 500);
    
    customLog('INFO', logContext, `Respuesta de OpenAI recibida: "${response.substring(0,50)}..."`);

    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(CLEAN_REGEX, "");
        if (cleanedChunk) {
            customLog('INFO', logContext, `Enviando chunk: "${cleanedChunk.substring(0, 50)}..."`);
            
            // Enviar el mensaje y registrar su ID
            const msgResult = await flowDynamic([{ body: cleanedChunk }]);
            
            // Registrar el ID del mensaje para saber que fue generado por el bot
            if (msgResult && msgResult.key && msgResult.key.id) {
                botSentMessages.add(msgResult.key.id);
                // Limpiar después de 5 minutos
                setTimeout(() => botSentMessages.delete(msgResult.key.id), 300000);
            }
            
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

// --- Manejo de Cola ---
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
            customLog('INFO', logContext, `Procesando tarea. Restantes: ${queue.length}. Msg: "${String(ctx.body).substring(0,100)}..."`);
            try {
                await processUserMessage(ctx, { flowDynamic, state, provider });
                customLog('INFO', logContext, `Tarea completada.`);
            } catch (error: any) {
                const errorMessage = error.message || String(error);
                customLog('ERROR', logContext, `Error en tarea para msg "${String(ctx.body).substring(0,30)}...":`, error);
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
    }
};

// --- Flujo Principal ---
const mainFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, args) => {
        if (ctx.key.fromMe) {
            return;
        }

        const { flowDynamic, state, provider } = args;
        const clientId = ctx.from;
        const shortClientId = getShortUserId(clientId);
        const currentMessageBody = ctx.body;
        const logContextClient = `CLIENT_MSG_HANDLER [from:${shortClientId}]`;

        customLog('INFO', logContextClient, `Mensaje de cliente "${currentMessageBody.substring(0,30)}..." recibido.`);

        let userBuffer = userMessageBuffers.get(clientId);
        if (!userBuffer) {
            userBuffer = { messages: [], lastCtx: ctx, flowDynamic, state, provider };
            userMessageBuffers.set(clientId, userBuffer);
            customLog('INFO', logContextClient, `Nuevo buffer de mensajes creado para cliente.`);
        }
        
        userBuffer.messages.push(currentMessageBody);
        userBuffer.lastCtx = ctx;
        userBuffer.flowDynamic = flowDynamic;
        userBuffer.state = state; 
        userBuffer.provider = provider;

        customLog('INFO', logContextClient, `Mensaje añadido al buffer del cliente. Total en buffer: ${userBuffer.messages.length}.`);

        if (userActivityTimers.has(clientId)) {
            clearTimeout(userActivityTimers.get(clientId)!);
        }

        const timerId = setTimeout(async () => {
            const finalBuffer = userMessageBuffers.get(clientId);
            if (finalBuffer && finalBuffer.messages.length > 0) {
                const combinedMessageBody = finalBuffer.messages.join('\n\n');
                const taskCtx = { ...finalBuffer.lastCtx, body: combinedMessageBody };
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
            userMessageBuffers.delete(clientId);
            userActivityTimers.delete(clientId);
        }, USER_INACTIVITY_TIMEOUT_MS);

        userActivityTimers.set(clientId, timerId);
        customLog('INFO', logContextClient, `Temporizador de inactividad (${USER_INACTIVITY_TIMEOUT_MS / 1000}s) iniciado/reiniciado para cliente.`);
    });

// --- Función Principal (main) ---
const main = async () => {
    const logContext = `[MAIN_INIT]`;
    customLog('INFO', logContext, `Iniciando el bot en el puerto ${PORT}`);
    
    if (!ASSISTANT_ID) {
        customLog('ERROR', logContext, `CRITICAL: La variable de entorno ASSISTANT_ID no está configurada. Saliendo.`);
        process.exit(1);
    }
    
    if (!OPENAI_API_KEY || !openai) {
        customLog('ERROR', logContext, `CRITICAL: OPENAI_API_KEY no configurada o SDK de OpenAI no inicializado. Sincronización no funcionará.`);
        process.exit(1);
    }
    
    customLog('INFO', logContext, `Usando Assistant ID: ${ASSISTANT_ID.substring(0,10)}...`);
    customLog('INFO', logContext, `OpenAI Cooldown: ${OPENAI_COOLDOWN_MS}ms.`);
    customLog('INFO', logContext, `User Inactivity Timeout: ${USER_INACTIVITY_TIMEOUT_MS}ms.`);
    
    // Inicializar el archivo de log
    if (DEBUG_MODE) {
        try {
            fs.writeFileSync(DEBUG_LOG_PATH, `--- Nuevo log de diagnóstico ${new Date().toISOString()} ---\n`);
        } catch (e) {
            console.error(`Error creando archivo de diagnóstico: ${e.message}`);
        }
    }

    const adapterFlow = createFlow([mainFlow]);
    const adapterDB = new MemoryDB();
    const adapterProvider = createProvider(BaileysProvider, { groupsIgnore: true, readStatus: false });

    // Crear el bot
    const { httpServer, provider } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Configurar la detección de mensajes manuales
    provider.on('ready', () => {
        customLog('INFO', logContext, "Bot en estado 'ready'. Configurando detección de mensajes manuales.");
        
        // Acceder al socket de Baileys
        const socket = provider.socket || provider.vendor;
        
        if (!socket?.ev?.on) {
            customLog('ERROR', logContext, "No se pudo acceder al socket de Baileys. No se detectarán mensajes manuales.");
            return;
        }
        
        // Registrar una función para cuando lleguen mensajes nuevos
        socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
            customLog('DEBUG', "MESSAGES_UPSERT", `Evento recibido: tipo=${type}, mensajes=${messages?.length || 0}`);
            
            if (!messages || !Array.isArray(messages)) return;
            
            for (const msg of messages) {
                if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
                
                const messageBody = extractTextFromMessage(msg);
                if (!messageBody) continue;
                
                // Solo procesamos mensajes salientes (del bot o manuales)
                if (msg.key.fromMe === true) {
                    const messageId = msg.key.id;
                    const jid = msg.key.remoteJid;
                    const shortJid = getShortUserId(jid);
                    
                    // Verificar si este mensaje lo envió el bot
                    if (botSentMessages.has(messageId)) {
                        customLog('DEBUG', "BOT_MESSAGE", `Mensaje ${messageId} generado por el bot, ignorando.`);
                        continue;
                    }
                    
                    // Si llegamos aquí, es un mensaje manual
                    customLog('INFO', `MANUAL_MSG [to:${shortJid}]`, `Mensaje manual detectado: "${messageBody.substring(0, 60)}..."`);
                    
                    // Solo sincronizar si tenemos un thread_id para este cliente
                    if (clientThreadIds.has(jid)) {
                        await syncManualMessageToOpenAI(jid, messageBody);
                    } else {
                        customLog('WARN', `MANUAL_MSG [to:${shortJid}]`, `No hay thread_id disponible. El cliente debe enviar al menos un mensaje primero.`);
                    }
                }
            }
        });
        
        customLog('INFO', logContext, "Listener para mensajes de Baileys configurado con éxito.");
    });

    // También configurar a través de connection.update por si acaso
    provider.on('connection.update', (update: any) => {
        const { connection } = update || {};
        
        if (connection === 'open') {
            customLog('INFO', logContext, "Conexión 'open' detectada");
            
            // Intentar configurar el listener nuevamente
            setTimeout(() => {
                const socket = provider.socket || provider.vendor;
                
                if (!socket?.ev?.on) return;
                
                socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
                    if (!messages || !Array.isArray(messages)) return;
                    
                    for (const msg of messages) {
                        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
                        
                        const messageBody = extractTextFromMessage(msg);
                        if (!messageBody) continue;
                        
                        if (msg.key.fromMe === true) {
                            const messageId = msg.key.id;
                            const jid = msg.key.remoteJid;
                            
                            if (botSentMessages.has(messageId)) continue;
                            
                            const shortJid = getShortUserId(jid);
                            customLog('INFO', `MANUAL_MSG [connection.update] [to:${shortJid}]`, 
                                `Mensaje manual detectado: "${messageBody.substring(0, 60)}..."`);
                            
                            // Solo sincronizar si tenemos un thread_id para este cliente
                            if (clientThreadIds.has(jid)) {
                                await syncManualMessageToOpenAI(jid, messageBody);
                            } else {
                                customLog('WARN', `MANUAL_MSG [to:${shortJid}]`, `No hay thread_id disponible. El cliente debe enviar al menos un mensaje primero.`);
                            }
                        }
                    }
                });
                
                customLog('INFO', logContext, "Listener configurado a través de connection.update");
            }, 3000);
        }
    });

    // httpInject para el proveedor
    if (adapterProvider.server && typeof httpInject === 'function') {
        httpInject(adapterProvider.server);
        customLog('INFO', logContext, `Inyección HTTP para el proveedor aplicada.`);
    } else {
        customLog('WARN', logContext, `No se pudo aplicar inyección HTTP al proveedor.`);
    }

    // Iniciar el servidor HTTP
    if (httpServer && typeof httpServer === 'function') {
        httpServer(Number(PORT));
        customLog('INFO', logContext, `Servidor HTTP iniciado en puerto ${PORT}.`);
    } else {
        customLog('ERROR', logContext, `httpServer no es una función.`);
    }
};

main().catch(err => {
    customLog('ERROR', `[MAIN_INIT]`, `Error fatal al iniciar bot:`, err);
    process.exit(1);
});