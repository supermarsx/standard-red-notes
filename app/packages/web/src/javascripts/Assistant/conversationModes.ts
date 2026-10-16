export type AssistantConversationMode = 'chat' | 'agent' | 'plan' | 'research' | 'deep-research'

export const DEFAULT_ASSISTANT_CONVERSATION_MODE: AssistantConversationMode = 'agent'

export function isAssistantConversationMode(value: unknown): value is AssistantConversationMode {
  return typeof value === 'string' && ['chat', 'agent', 'plan', 'research', 'deep-research'].includes(value)
}

/** UI fallback only; persisted data must use the strict validator above. */
export function normalizeAssistantConversationMode(value: unknown): AssistantConversationMode {
  return isAssistantConversationMode(value) ? value : DEFAULT_ASSISTANT_CONVERSATION_MODE
}
