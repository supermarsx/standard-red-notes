import type { Provider, ProviderEvent } from './types'

export interface CallTokenUsage {
  input?: number
  output?: number
  contextLimit?: number
}

export interface ChatTokenUsage {
  calls: number
  reportedCalls: number
  input?: number
  output?: number
  last?: CallTokenUsage
}

export const EMPTY_CHAT_TOKEN_USAGE: ChatTokenUsage = { calls: 0, reportedCalls: 0 }

const tokenCount = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function normalizeCallTokenUsage(event: Extract<ProviderEvent, { kind: 'usage' }>): CallTokenUsage {
  const limit = tokenCount(event.contextWindowTokens)
  return {
    input: tokenCount(event.promptTokens),
    output: tokenCount(event.completionTokens),
    contextLimit: limit && limit > 0 ? limit : undefined,
  }
}

export function accumulateChatTokenUsage(current: ChatTokenUsage, last: CallTokenUsage): ChatTokenUsage {
  const sum = (previous: number | undefined, next: number | undefined) => {
    return next === undefined ? previous : Math.min(Number.MAX_SAFE_INTEGER, (previous ?? 0) + next)
  }
  return {
    calls: current.calls + 1,
    reportedCalls: current.reportedCalls + (last.input !== undefined || last.output !== undefined ? 1 : 0),
    input: sum(current.input, last.input),
    output: sum(current.output, last.output),
    last,
  }
}

/** Observe one final usage snapshot per send, retaining provider execution/cancellation unchanged. */
export function observeProviderTokenUsage(provider: Provider, report: (usage: CallTokenUsage) => void): Provider {
  return {
    id: provider.id,
    async *send(request) {
      let usage: CallTokenUsage = {}
      let observed = false
      try {
        for await (const event of provider.send(request)) {
          observed = true
          if (event.kind === 'usage') {
            // Providers can send cumulative usage more than once. Merge the
            // latest supplied fields, then count the request exactly once.
            const next = normalizeCallTokenUsage(event)
            usage = {
              input: next.input ?? usage.input,
              output: next.output ?? usage.output,
              contextLimit: next.contextLimit ?? usage.contextLimit,
            }
          }
          yield event
        }
      } finally {
        if (observed) {
          // A display observer must never change provider success/failure.
          try {
            report(usage)
          } catch {
            // Best-effort telemetry only.
          }
        }
      }
    },
  }
}
