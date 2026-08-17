// Browser-side mirror of the openclaw provider/agent contracts. The agent loop
// and all tool execution run in the browser because Standard Red Notes notes are
// end-to-end encrypted and decryption keys only exist on the client. The server
// is only a stateless LLM streaming proxy.

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
  toolCallId?: string
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
  /** Per-run cancellation boundary; overrides a provider constructor signal. */
  signal?: AbortSignal
  maxOutputTokens?: number
  /** Narrow server-recognized purpose; never a caller-selected backend profile. */
  purpose?: 'safety-review'
  stop?: string[]
}

export type ProviderStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop' | 'error'

export type ProviderEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'finish'; stopReason: ProviderStopReason; providerReplay?: ProviderReplayState }
  | { kind: 'error'; message: string }
  // Token usage reported by the endpoint when a completion finishes. Best-effort:
  // emitted only when the provider's response carries a `usage` object (OpenAI
  // non-streaming responses, or streaming with stream_options.include_usage).
  | { kind: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }

export interface Provider {
  readonly id: string
  send(req: ProviderRequest): AsyncIterable<ProviderEvent>
}

/** A browser tool that the agent can execute against the application. */
export interface ToolDefinition {
  name: string
  description: string
  /** True if the tool mutates state and should be gated by the confirm toggle. */
  mutating: boolean
  inputSchema: unknown
}

/** Mirrors openclaw's McpSession surface used by the agent loop. */
export interface ToolSession {
  tools(): ToolDefinition[]
  /** The opaque call id is for local audit/UI correlation only. */
  call(name: string, args: unknown, callId?: string): Promise<unknown>
}

export type ToolExecutionOutcome = 'succeeded' | 'failed' | 'denied' | 'interrupted'
