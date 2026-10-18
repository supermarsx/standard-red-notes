import { captureAssistantSessionPrincipal } from './assistantSessionPrincipal'
import type { WebApplication } from '@/Application/WebApplication'

// Local display counters belong to this application/account for this page lifetime.
// Server rolling windows remain authoritative across browsers and devices.

export interface AssistantUsage {
  /** Total prompt (input) tokens reported across the session. */
  promptTokens: number
  /** Total completion (output) tokens reported across the session. */
  completionTokens: number
  /** Total tokens (prompt + completion). Falls back to the provider's own total. */
  totalTokens: number
  /** Number of completed requests, whether or not they reported token usage. */
  requests: number
  /** Number of requests that actually reported token usage (for honesty in UI). */
  requestsWithTokens: number
}

/** A single completion's reported usage. All fields optional/best-effort. */
export interface UsageReport {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export const EMPTY_USAGE: AssistantUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  requests: 0,
  requestsWithTokens: 0,
}

type Listener = (usage: AssistantUsage) => void

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Fold one completion's reported usage into the running totals. PURE so the
 * accumulation math can be unit-tested without storage or the DOM.
 */
export function accumulateUsage(current: AssistantUsage, report: UsageReport): AssistantUsage {
  const prompt = numberOr(report.promptTokens)
  const completion = numberOr(report.completionTokens)
  // Prefer an explicit provider total; otherwise derive from prompt+completion.
  const reportedTotal = numberOr(report.totalTokens)
  const total = reportedTotal > 0 ? reportedTotal : prompt + completion
  const hadTokens = prompt > 0 || completion > 0 || total > 0

  return {
    promptTokens: current.promptTokens + prompt,
    completionTokens: current.completionTokens + completion,
    totalTokens: current.totalTokens + total,
    requests: current.requests + 1,
    requestsWithTokens: current.requestsWithTokens + (hadTokens ? 1 : 0),
  }
}

export class AssistantUsageService {
  private usage: AssistantUsage = { ...EMPTY_USAGE }
  private listeners = new Set<Listener>()

  get(): AssistantUsage {
    return this.usage
  }

  /** Record one completed completion's usage and notify subscribers. */
  record(report: UsageReport): void {
    this.usage = accumulateUsage(this.usage, report)
    this.emit()
  }

  /** Reset the session counters (e.g. a "clear usage" affordance). */
  reset(): void {
    this.usage = { ...EMPTY_USAGE }
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.usage)
      } catch {
        // Telemetry observers must never abort a completion or other observers.
      }
    }
  }
}

/** Compatibility fallback for standalone providers without an application binding. */
export const assistantUsageService = new AssistantUsageService()

const applicationCounters = new WeakMap<WebApplication, Map<string, AssistantUsageService>>()

/** Capture this service when creating a provider; late replies retain their account. */
export function getAssistantUsageService(application: WebApplication): AssistantUsageService {
  const principal = captureAssistantSessionPrincipal(application.sessions)
  const scope = principal.valid ? (principal.userUuid ?? 'anonymous') : 'unavailable'
  let counters = applicationCounters.get(application)
  if (!counters) {
    counters = new Map()
    applicationCounters.set(application, counters)
  }
  let service = counters.get(scope)
  if (!service) {
    service = new AssistantUsageService()
    counters.set(scope, service)
  }
  return service
}
