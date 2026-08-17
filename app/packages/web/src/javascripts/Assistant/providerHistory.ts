import { ChatMessage } from './types'

/**
 * Roughly 6k tokens, leaving room for the system prompt, selected note context,
 * current user request, tools, and output on providers with modest windows.
 */
export const DEFAULT_PROVIDER_HISTORY_CHARACTER_BUDGET = 24_000

const TRUNCATION_MARKER = '\n…[earlier content truncated]…\n'

export function providerHistoryCharacterCost(messages: readonly ChatMessage[]): number {
  return JSON.stringify(messages).length
}

function truncateMiddle(value: string, targetLength: number): string {
  if (value.length <= targetLength) {
    return value
  }
  if (targetLength <= TRUNCATION_MARKER.length) {
    return value.slice(0, Math.max(0, targetLength))
  }
  const remaining = targetLength - TRUNCATION_MARKER.length
  const headLength = Math.ceil(remaining / 2)
  const tailLength = Math.floor(remaining / 2)
  return `${value.slice(0, headLength)}${TRUNCATION_MARKER}${value.slice(value.length - tailLength)}`
}

function fitNewestTurn(turn: ChatMessage[], budget: number): ChatMessage[] {
  const fitted = turn.map((message) => ({ ...message }))
  while (fitted.length > 0 && providerHistoryCharacterCost(fitted) > budget) {
    let longestIndex = -1
    let longestLength = 0
    for (let index = 0; index < fitted.length; index++) {
      if (fitted[index].content.length > longestLength) {
        longestLength = fitted[index].content.length
        longestIndex = index
      }
    }
    if (longestIndex < 0 || longestLength === 0) {
      return []
    }
    const overflow = providerHistoryCharacterCost(fitted) - budget
    const nextLength = Math.max(0, longestLength - Math.max(1, overflow))
    fitted[longestIndex] = {
      ...fitted[longestIndex],
      content: truncateMiddle(fitted[longestIndex].content, nextLength),
    }
  }
  return fitted
}

/**
 * Return a cloned, contiguous suffix of persisted user/assistant turns that
 * fits the exact serialized-character budget. Tool/system/replay records are
 * intentionally excluded: persisted chat history is narrative context, while
 * live tool protocol is valid only inside its current agent run.
 */
export function boundProviderHistory(
  messages: readonly ChatMessage[],
  maxCharacters = DEFAULT_PROVIDER_HISTORY_CHARACTER_BUDGET,
): ChatMessage[] {
  const budget = Number.isFinite(maxCharacters) ? Math.max(0, Math.floor(maxCharacters)) : 0
  if (budget === 0) {
    return []
  }

  const turns: ChatMessage[][] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const narrativeMessage: ChatMessage = { role: message.role, content: message.content }
    if (message.role === 'user' || turns.length === 0) {
      turns.push([narrativeMessage])
    } else {
      turns[turns.length - 1].push(narrativeMessage)
    }
  }

  let retained: ChatMessage[] = []
  for (let index = turns.length - 1; index >= 0; index--) {
    const candidate = [...turns[index], ...retained]
    if (providerHistoryCharacterCost(candidate) <= budget) {
      retained = candidate
      continue
    }
    if (retained.length === 0) {
      retained = fitNewestTurn(turns[index], budget)
    }
    break
  }
  return retained
}
