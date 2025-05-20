import "dotenv/config";
import OpenAI from 'openai';
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { MemoryDB as BuilderMemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import fs from 'fs';

// --- Configuración Inicial ---
const PORT = process.env.PORT ?? 3008;
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const DEBUG_LOG_PATH = './whatsapp-sync-debug.log';
const DEBUG_MODE = true;

// --- Constantes de Tiempo ---
const CHUNK_DELAY_MS = 150;
const USER_INACTIVITY_TIMEOUT_MS = 6000; // 6 segundos para agrupar mensajes del usuario
const MANUAL_INACTIVITY_TIMEOUT_MS = 6000; // 6 segundos para agrupar mensajes manuales

// --- Inicialización OpenAI ---
let openai;
if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log("SDK de OpenAI inicializado correctamente");
} else {
    console.error("CRITICAL_ENV_ERROR: OPENAI_API_KEY no está configurada en el archivo .env.");
    process.exit(1);
}

// --- Funciones de Logging ---
const getFormattedTimestamp = () => {
    const now = new Date();
    const dateOptions = { year: '2-digit', month: '2-digit', day: '2-digit' };
    const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    const date = now.toLocaleDateString('es-CO', dateOptions);
    const time = now.toLocaleTimeString('es-CO', timeOptions);
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${date} ${time}.${ms}`;
};

const log = (context, level, message) => {
    const timestamp = getFormattedTimestamp();
    const logLine = `[${timestamp}] [${level}] ${context}: ${message}`;
    
    console.log(logLine);
    
    if (DEBUG_MODE) {
        try {
            fs.appendFileSync(DEBUG_LOG_PATH, logLine + '\n');
        } catch (e) {
            console.error(`Error escribiendo al log: ${e.message}`);
        }
    }
};

// --- Utilidades ---
const getShortUserId = (jid) => {
    if (typeof jid === 'string') return jid.split('@')[0] || jid;
    return 'unknown';
};

const extractTextFromMessage = (msg) => {
    if (!msg || !msg.message) return null;
    return msg.message.conversation ||
           msg.message.extendedTextMessage?.text ||
           msg.message.imageMessage?.caption ||
           msg.message.videoMessage?.caption ||
           msg.message.ephemeralMessage?.message?.extendedTextMessage?.text ||
           msg.message.ephemeralMessage?.message?.conversation ||
           null;
};

// --- Estado global ---
// Mapa simple en memoria para almacenar thread_ids por número de cliente
const clientThreadMap = {};

// Función para guardar thread_id en el mapa
const saveThreadId = (jid, threadId) => {
    if (!jid || !threadId) return false;
    
    const clientPhone = getShortUserId(jid);
    clientThreadMap[clientPhone] = threadId;
    
    log('THREAD_SAVE', 'INFO', `Thread ID ${threadId} guardado para ${clientPhone}`);
    return true;
};

// Función para obtener thread_id del mapa
const getThreadId = (jid) => {
    if (!jid) return null;
    
    const clientPhone = getShortUserId(jid);
    return clientThreadMap[clientPhone] || null;
};

const userMessageBuffers = new Map();
const userActivityTimers = new Map();
const manualMessageBuffers = new Map();
const manualActivityTimers = new Map();

// --- Indicador de escritura ---
const typing = async (ctx, provider) => {
    const remoteJid = ctx.key?.remoteJid || ctx.from;
    const shortUserId = getShortUserId(remoteJid);
    
    if (provider?.vendor?.sendPresenceUpdate && typeof provider.vendor.sendPresenceUpdate === 'function' && remoteJid) {
        try {
            await provider.vendor.sendPresenceUpdate('composing', remoteJid);
            log(`TYPING [${shortUserId}]`, 'DEBUG', 'Indicador de escritura enviado');
        } catch (e) {
            log(`TYPING [${shortUserId}]`, 'ERROR', `Error al enviar 'composing': ${e.message}`);
        }
    }
};

// --- Sincronización de mensajes manuales con OpenAI ---
async function syncManualMessageToOpenAI(jid, messageContent) {
    const shortJid = getShortUserId(jid);
    const logContext = `SYNC_MANUAL [${shortJid}]`;
    
    if (!openai) {
        log(logContext, 'ERROR', `SDK de OpenAI no inicializado. No se puede sincronizar.`);
        return false;
    }
    
    try {
        const threadId = getThreadId(jid);
        
        if (!threadId) {
            log(logContext, 'WARN', `No se encontró thread_id para ${shortJid}. No se puede sincronizar mensaje manual.`);
            return false;
        }
        
        log(logContext, 'INFO', `Thread ID encontrado: ${threadId}. Sincronizando mensaje manual.`);
        
        // Enviar una anotación como mensaje de usuario para hacer saber al sistema
        // que un operador humano intervino
        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: `[NOTA DEL SISTEMA: Un operador humano ha respondido directamente al cliente con el siguiente mensaje]`
        });
        
        // Luego enviar el mensaje manual como respuesta del asistente (simulando que el asistente respondió)
        const result = await openai.beta.threads.messages.create(threadId, {
            role: 'assistant',
            content: messageContent
        });
        
        log(logContext, 'INFO', `Mensaje manual sincronizado con OpenAI exitosamente. Message ID: ${result.id}`);
        return true;
    } catch (error) {
        log(logContext, 'ERROR', `Error sincronizando mensaje manual con OpenAI: ${error.message}`);
        return false;
    }
}

// --- Manejo de mensajes manuales ---
function handleManualMessage(jid, messageBody) {
    const shortJid = getShortUserId(jid);
    
    if (!manualMessageBuffers.has(jid)) {
        manualMessageBuffers.set(jid, []);
    }
    
    const buffer = manualMessageBuffers.get(jid);
    buffer.push(messageBody);
    
    log(`MANUAL_MSG_BUFFER [to:${shortJid}]`, 'INFO', `Mensaje manual añadido al buffer. Total: ${buffer.length}.`);
    
    if (manualActivityTimers.has(jid)) {
        clearTimeout(manualActivityTimers.get(jid));
    }
    
    const timerId = setTimeout(async () => {
        const messages = manualMessageBuffers.get(jid);
        if (messages && messages.length > 0) {
            const combinedMessage = messages.join('\n\n');
            
            log(`MANUAL_MSG_TIMEOUT [to:${shortJid}]`, 'INFO', 
                `Enviando ${messages.length} mensajes manuales combinados a OpenAI.`);
            
            await syncManualMessageToOpenAI(jid, combinedMessage);
        }
        
        manualMessageBuffers.delete(jid);
        manualActivityTimers.delete(jid);
    }, MANUAL_INACTIVITY_TIMEOUT_MS);
    
    manualActivityTimers.set(jid, timerId);
}

// --- Procesamiento de mensajes del usuario ---
async function processUserMessage(ctx, { flowDynamic, state, provider }) {
    const shortUserId = getShortUserId(ctx.from);
    const logContext = `PROCESS_MSG [${shortUserId}]`;
    
    log(logContext, 'INFO', `Iniciando procesamiento OpenAI para: "${ctx.body.substring(0,50)}..."`);
    await typing(ctx, provider);
    
    log(logContext, 'INFO', `Solicitando respuesta a OpenAI Assistant (${ASSISTANT_ID.substring(0,10)})...`);
    
    try {
        const response = await toAsk(ASSISTANT_ID, ctx.body, state);
        
        // Extraer y guardar thread_id
        try {
            const threadFromState = await state.get('thread');
            
            if (threadFromState && typeof threadFromState === 'string' && threadFromState.startsWith('thread_')) {
                // Guardar en el mapa de memoria
                saveThreadId(ctx.from, threadFromState);
                log(logContext, 'INFO', `Thread ID guardado: ${threadFromState}`);
            } else {
                // Intentar otras ubicaciones posibles
                const openaiAssistant = await state.get('openaiAssistant');
                if (openaiAssistant && openaiAssistant.thread_id) {
                    saveThreadId(ctx.from, openaiAssistant.thread_id);
                    log(logContext, 'INFO', `Thread ID guardado desde openaiAssistant: ${openaiAssistant.thread_id}`);
                } else {
                    const openaiState = await state.get('openai');
                    if (openaiState && openaiState.thread_id) {
                        saveThreadId(ctx.from, openaiState.thread_id);
                        log(logContext, 'INFO', `Thread ID guardado desde openai: ${openaiState.thread_id}`);
                    }
                }
            }
        } catch (e) {
            log(logContext, 'ERROR', `Error al extraer thread_id: ${e.message}`);
        }
        
        log(logContext, 'INFO', `Respuesta de OpenAI recibida: "${response.substring(0,50)}..."`);
        
        // Enviar respuesta en chunks
        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim();
            if (cleanedChunk) {
                log(logContext, 'INFO', `Enviando chunk: "${cleanedChunk.substring(0, 50)}..."`);
                await flowDynamic([{ body: cleanedChunk }]);
                await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
            }
        }
        
        log(logContext, 'INFO', `Todos los chunks enviados`);
    } catch (error) {
        log(logContext, 'ERROR', `Error en procesamiento: ${error.message}`);
        await flowDynamic([{ body: "Lo siento, hubo un problema al procesar tu mensaje. Por favor, intenta nuevamente." }]);
    }
}

// --- Flujo Principal ---
const mainFlow = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, args) => {
        // Ignorar mensajes salientes
        if (ctx.key?.fromMe) {
            log(`MAIN_FLOW_IGNORE`, 'DEBUG', `Mensaje ignorado porque es fromMe`);
            return;
        }
        
        const { flowDynamic, state, provider } = args;
        const clientId = ctx.from;
        const shortClientId = getShortUserId(clientId);
        const currentMessageBody = ctx.body;
        
        log(`CLIENT_MSG [${shortClientId}]`, 'INFO', `Mensaje recibido: "${currentMessageBody.substring(0,50)}..."`);
        
        // Gestionar buffer de mensajes para agruparlos
        if (!userMessageBuffers.has(clientId)) {
            userMessageBuffers.set(clientId, {
                messages: [],
                lastCtx: ctx,
                flowDynamic,
                state,
                provider
            });
            log(`CLIENT_MSG [${shortClientId}]`, 'INFO', `Nuevo buffer creado`);
        }
        
        const userBuffer = userMessageBuffers.get(clientId);
        userBuffer.messages.push(currentMessageBody);
        userBuffer.lastCtx = ctx;
        userBuffer.flowDynamic = flowDynamic;
        userBuffer.state = state;
        userBuffer.provider = provider;
        
        log(`CLIENT_MSG [${shortClientId}]`, 'INFO', `Mensaje añadido al buffer. Total: ${userBuffer.messages.length}`);
        
        // Reiniciar el temporizador de inactividad
        if (userActivityTimers.has(clientId)) {
            clearTimeout(userActivityTimers.get(clientId));
        }
        
        // Establecer nuevo temporizador
        const timerId = setTimeout(async () => {
            const buffer = userMessageBuffers.get(clientId);
            
            if (buffer && buffer.messages.length > 0) {
                // Combinar todos los mensajes en el buffer
                const combinedMessage = buffer.messages.join('\n\n');
                
                // Crear un nuevo contexto con el mensaje combinado
                const newCtx = { ...buffer.lastCtx, body: combinedMessage };
                
                log(`TIMEOUT [${shortClientId}]`, 'INFO', 
                    `Procesando ${buffer.messages.length} mensajes combinados: "${combinedMessage.substring(0,50)}..."`);
                
                await processUserMessage(newCtx, {
                    flowDynamic: buffer.flowDynamic,
                    state: buffer.state,
                    provider: buffer.provider
                });
            }
            
            userMessageBuffers.delete(clientId);
            userActivityTimers.delete(clientId);
        }, USER_INACTIVITY_TIMEOUT_MS);
        
        userActivityTimers.set(clientId, timerId);
        log(`CLIENT_MSG [${shortClientId}]`, 'INFO', `Temporizador de inactividad (${USER_INACTIVITY_TIMEOUT_MS/1000}s) iniciado`);
    });

// --- Función Principal (main) ---
const main = async () => {
    try {
        // Inicializar archivo de log
        if (DEBUG_MODE) {
            fs.writeFileSync(DEBUG_LOG_PATH, `--- Nuevo log iniciado ${new Date().toISOString()} ---\n`);
        }
        
        log('MAIN', 'INFO', `Iniciando bot en puerto ${PORT}`);
        
        if (!ASSISTANT_ID) {
            log('MAIN', 'ERROR', `Variable ASSISTANT_ID no configurada. Saliendo.`);
            process.exit(1);
        }
        
        const adapterFlow = createFlow([mainFlow]);
        const adapterDB = new BuilderMemoryDB();
        const adapterProvider = createProvider(BaileysProvider, { 
            gruposIgnore: true, 
            readStatus: false 
        });
        
        const { httpServer, provider } = await createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });
        
        // Configurar detección de mensajes manuales
        provider.on('ready', () => {
            log('MAIN', 'INFO', 'Bot en estado ready. Configurando detección de mensajes manuales.');
            
            provider.vendor.ev.on('messages.upsert', async ({ messages, type }) => {
                if (!messages || !Array.isArray(messages)) return;
                
                for (const msg of messages) {
                    if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
                    
                    const messageBody = extractTextFromMessage(msg);
                    if (!messageBody) continue;
                    
                    // Detectar mensajes manuales (enviados por el operador)
                    if (msg.key.fromMe === true && type !== 'append') {
                        const jid = msg.key.remoteJid;
                        const shortJid = getShortUserId(jid);
                        
                        log(`MANUAL_DETECT [${shortJid}]`, 'INFO', 
                            `Mensaje manual detectado: "${messageBody.substring(0,50)}..."`);
                        
                        // Verificar el thread_id usando la función getThreadId
                        const threadId = getThreadId(jid);
                        
                        if (threadId) {
                            log(`MANUAL_DETECT [${shortJid}]`, 'INFO', 
                                `Thread ID encontrado: ${threadId}`);
                            handleManualMessage(jid, messageBody);
                        } else {
                            log(`MANUAL_DETECT [${shortJid}]`, 'WARN', 
                                `No hay thread_id para este cliente. El cliente debe interactuar primero.`);
                        }
                    }
                }
            });
            
            log('MAIN', 'INFO', 'Detección de mensajes manuales configurada.');
        });
        
        if (adapterProvider.server && typeof httpInject === 'function') {
            httpInject(adapterProvider.server);
            log('MAIN', 'INFO', 'HTTP Inject aplicado correctamente.');
        }
        
        if (httpServer && typeof httpServer === 'function') {
            httpServer(Number(PORT));
            log('MAIN', 'INFO', `Servidor HTTP iniciado en puerto ${PORT}.`);
        }
    } catch (error) {
        log('MAIN', 'ERROR', `Error fatal al iniciar: ${error.message}`);
        process.exit(1);
    }
};

// Iniciar el bot
main();