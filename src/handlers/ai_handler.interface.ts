export interface AiResponse {
  text: string;
}

export interface AiHandler {
  initialize(): Promise<void>;
  processMessage(userId: string, message: string): Promise<AiResponse>;
}