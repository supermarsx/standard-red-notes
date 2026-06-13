// Browser-side mirror of the openclaw provider/agent contracts. The agent loop
// and all tool execution run in the browser because Standard Red Notes notes are
// end-to-end encrypted and decryption keys only exist on the client. The server
// is only a stateless LLM streaming proxy.

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
  toolCallId?: string
  toolCalls?: AssistantToolCall[]
  name?: string
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
  maxOutputTokens?: number
  stop?: string[]
}

export type ProviderStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop' | 'error'

export type ProviderEvent =
  | { kind: 'text-delta'; delta: string }
  | { kind: 'tool-call'; id: string; name: string; args: unknown }
  | { kind: 'finish'; stopReason: ProviderStopReason }
  | { kind: 'error'; message: string }

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
  call(name: string, args: unknown): Promise<unknown>
}
