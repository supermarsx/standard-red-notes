// Session AI-usage accumulator. Providers (Direct/Proxy) report the token usage
// that the LLM endpoint returns at the end of each completion into this shared
// store, and the footer chip reads it. This is intentionally a tiny module-level
// singleton (not a synced PrefKey) so EVERY assistant request path — the one-shot
// selection/narration completions AND the agentic ConversationPanel run, which
// builds its own provider instances — feeds the same counters without any of them
// having to know about the footer.
//
// Honesty note: token counts come from the provider's reported `usage` object and
// are therefore approximate / provider-dependent. Some endpoints (notably local
// LM Studio / Ollama builds, or providers that omit `usage`) report nothing, in
// which case only the request count advances.

const STORAGE_KEY = 'sn-assistant-usage'

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

function loadPersisted(): AssistantUsage {
  if (typeof localStorage === 'undefined') {
    return { ...EMPTY_USAGE }
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...EMPTY_USAGE }
    }
    const parsed = JSON.parse(raw) as Partial<AssistantUsage>
    return {
      promptTokens: numberOr(parsed.promptTokens),
      completionTokens: numberOr(parsed.completionTokens),
      totalTokens: numberOr(parsed.totalTokens),
      requests: numberOr(parsed.requests),
      requestsWithTokens: numberOr(parsed.requestsWithTokens),
    }
  } catch {
    return { ...EMPTY_USAGE }
  }
}

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

class AssistantUsageService {
  private usage: AssistantUsage = loadPersisted()
  private listeners = new Set<Listener>()

  get(): AssistantUsage {
    return this.usage
  }

  /** Record one completed completion's usage and notify subscribers. */
  record(report: UsageReport): void {
    this.usage = accumulateUsage(this.usage, report)
    this.persist()
    this.emit()
  }

  /** Reset the session counters (e.g. a "clear usage" affordance). */
  reset(): void {
    this.usage = { ...EMPTY_USAGE }
    this.persist()
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') {
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.usage))
    } catch {
      /* storage may be full or unavailable; usage display is best-effort */
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.usage)
    }
  }
}

/** Process-wide singleton shared by every provider and the footer chip. */
export const assistantUsageService = new AssistantUsageService()
