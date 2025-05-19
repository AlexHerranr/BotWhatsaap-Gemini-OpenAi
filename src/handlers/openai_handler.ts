import { OpenAI } from 'openai';
import { AiHandler, AiResponse } from './ai_handler.interface';

export class OpenAiHandler implements AiHandler {
  private openai: OpenAI;
  private assistantId: string;
  private userThreadMap: Map<string, string> = new Map();

  constructor(apiKey: string, assistantId: string) {
    this.openai = new OpenAI({ apiKey });
    this.assistantId = assistantId;
  }

  async initialize(): Promise<void> {
    try {
      await this.openai.models.list();
      console.log('✅ Conexión con OpenAI establecida');
    } catch (error) {
      console.error('❌ Error al conectar con OpenAI:', error);
      throw error;
    }
  }

  async processMessage(userId: string, message: string): Promise<AiResponse> {
    // Obtener o crear un thread para este usuario
    let threadId = this.userThreadMap.get(userId);
    
    if (!threadId) {
      const thread = await this.openai.beta.threads.create();
      threadId = thread.id;
      this.userThreadMap.set(userId, threadId);
    }

    // Añadir mensaje al thread
    await this.openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message
    });

    // Ejecutar el asistente
    const run = await this.openai.beta.threads.runs.create(threadId, {
      assistant_id: this.assistantId
    });

    // Esperar a que termine
    let runStatus = await this.openai.beta.threads.runs.retrieve(threadId, run.id);
    
    while (runStatus.status !== 'completed' && runStatus.status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await this.openai.beta.threads.runs.retrieve(threadId, run.id);
    }

    if (runStatus.status === 'failed') {
      return { text: "Lo siento, tuve un problema al procesar tu solicitud." };
    }

    // Obtener los mensajes más recientes
    const messages = await this.openai.beta.threads.messages.list(threadId);
    const assistantMessages = messages.data.filter(m => m.role === 'assistant');
    
    if (assistantMessages.length === 0) {
      return { text: "No obtuve una respuesta clara. Por favor, intenta de nuevo." };
    }

    // Extraer el texto de la respuesta
    const responseContent = assistantMessages[0].content[0];
    
    if ('text' in responseContent) {
      return { text: responseContent.text.value };
    } else {
      return { text: "Recibí una respuesta en un formato no soportado." };
    }
  }
}