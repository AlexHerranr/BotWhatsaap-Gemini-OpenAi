import { GoogleGenerativeAI } from '@google/generative-ai';
import { AiHandler, AiResponse } from './ai_handler.interface';

export class GeminiHandler implements AiHandler {
  private genAI: GoogleGenerativeAI;
  private modelName: string;
  private systemInstructionParts: string[];
  private userChatSessions: Map<string, any> = new Map();

  constructor(apiKey: string, modelName: string = 'gemini-pro', systemInstructions: string[] = []) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
    this.systemInstructionParts = systemInstructions;
  }

  async initialize(): Promise<void> {
    try {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });
      await model.generateContent('test');
      console.log('✅ Conexión con Google Gemini establecida');
    } catch (error) {
      console.error('❌ Error al conectar con Google Gemini:', error);
      throw error;
    }
  }

  async processMessage(userId: string, message: string): Promise<AiResponse> {
    // Obtener o crear una sesión de chat para este usuario
    let chatSession = this.userChatSessions.get(userId);
    
    if (!chatSession) {
      const model = this.genAI.getGenerativeModel({ model: this.modelName });
      
      // Configurar el chat con instrucciones del sistema
      let chatOptions = {};
      if (this.systemInstructionParts.length > 0) {
        chatOptions = {
          systemInstruction: {
            parts: this.systemInstructionParts.map(text => ({ text }))
          }
        };
      }
      
      chatSession = model.startChat(chatOptions);
      this.userChatSessions.set(userId, chatSession);
    }

    try {
      // Enviar el mensaje y obtener la respuesta
      const result = await chatSession.sendMessage(message);
      const response = result.response;
      
      if (response.candidates && response.candidates.length > 0) {
        const text = response.candidates[0].content.parts
          .filter(part => part.text)
          .map(part => part.text)
          .join('\n');
        
        return { text };
      } else {
        return { text: "No obtuve una respuesta clara. Por favor, intenta de nuevo." };
      }
    } catch (error) {
      console.error('Error al procesar mensaje con Gemini:', error);
      return { text: "Lo siento, tuve un problema al procesar tu solicitud." };
    }
  }
}