// Provider abstraction ported from the openclaw CLI agent. Every concrete
// provider (anthropic, openai, ollama) implements this single interface so the
// streaming proxy doesn't know which backend is in use.

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ProviderReplayState {
  protocol: 'openai-responses'
  version: 1
  /** Base64url UTF-8 JSON. Transport-opaque, but not encryption. */
  encodedOutput: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** For tool messages, the originating tool call id. */
  toolCallId?: string
  /** For assistant messages, any tool calls the model wants to make. */
  toolCalls?: AssistantToolCall[]
  name?: string
  /** Opaque provider continuation data retained only inside the current agent run. */
  providerReplay?: ProviderReplayState
}

export interface AssistantToolCall {
  id: string
  name: string
  args: unknown
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
}

export interface ProviderRequest {
  system: string
  messages: ChatMessage[]
  tools: ToolDescriptor[]
  /** Request-scoped cancellation propagated from the proxy client connection. */
  signal?: AbortSignal
  maxOutputTokens?: number
  /** Optional server-owned sampling controls. Omitted means provider default. */
  temperature?: number
  topP?: number
  stop?: string[]
}

export type ProviderStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop' | 'error'

export type ProviderEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'finish'; stopReason: ProviderStopReason; providerReplay?: ProviderReplayState }
  | { kind: 'error'; message: string }
  // Token usage reported by the upstream LLM, forwarded to the browser so the
  // client can surface consumption. Best-effort: emitted only when the upstream
  // response includes a usage object.
  | { kind: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }

export interface Provider {
  readonly id: string
  send(req: ProviderRequest): AsyncIterable<ProviderEvent>
}
