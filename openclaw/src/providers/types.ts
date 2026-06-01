// Provider abstraction. Every concrete provider (anthropic, openai, ollama,
// mock) implements this single interface so the agent loop doesn't know which
// backend is in use.

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** For tool messages, the originating tool call id. */
  toolCallId?: string;
  /** For assistant messages, any tool calls the model wants to make. */
  toolCalls?: AssistantToolCall[];
  name?: string;
}

export interface AssistantToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ProviderRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDescriptor[];
  maxOutputTokens?: number;
  stop?: string[];
}

export type ProviderEvent =
  | { kind: "text-delta"; delta: string }
  | { kind: "tool-call"; id: string; name: string; args: unknown }
  | {
      kind: "finish";
      stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop" | "error";
    }
  | { kind: "error"; message: string };

export interface Provider {
  readonly id: string;
  send(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}
