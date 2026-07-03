/**
 * Standard Red Notes: per-user AI TOKEN metering over two ROLLING windows — a
 * 5-hour window and a weekly (7-day) window.
 *
 * This module holds the PURE window math (sum-in-window, reset-time, over-limit,
 * text -> token estimation). It never touches Redis or Express, so every branch
 * is unit-testable in isolation. The Redis-backed counter that persists the
 * {timestamp, tokens} entries lives in {@link RedisTokenUsageStore}; the
 * enforcement + recording wiring lives in the AssistantController.
 *
 * TOKEN SOURCE: when the upstream provider returns a `usage` object (OpenAI with
 * stream_options.include_usage, Gemini, Cohere) we record the REAL token counts.
 * Anthropic/Ollama (and any provider that omits usage) fall back to an ESTIMATE
 * from text length (~4 chars/token), flagged `estimated` so the UI can label it.
 */

/** A single recorded completion: when it happened + how many tokens it spent. */
export interface TokenUsageEntry {
  /** Unix epoch milliseconds. */
  ts: number
  /** Total tokens (prompt + completion) attributed to the request. */
  tokens: number
}

export type TokenWindowId = 'fiveHour' | 'weekly'

export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function windowMsFor(id: TokenWindowId): number {
  return id === 'fiveHour' ? FIVE_HOUR_WINDOW_MS : WEEKLY_WINDOW_MS
}

/** Human name of a window, used in the over-limit rejection message. */
export function windowLabel(id: TokenWindowId): string {
  return id === 'fiveHour' ? 'rolling 5-hour' : 'weekly'
}

/** Approximate tokens for a character count (~4 characters per token). */
export function estimateTokensFromChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0
}

/** Approximate tokens for a piece of text (~4 characters per token). */
export function estimateTokensFromText(text: string): number {
  return estimateTokensFromChars(text ? text.length : 0)
}

/**
 * Sum the tokens of every entry whose timestamp falls inside the rolling window
 * [now - windowMs, now]. Entries older than the window are ignored (they have
 * rolled off); entries with a future timestamp (clock skew) are still counted.
 */
export function sumTokensInWindow(entries: TokenUsageEntry[], now: number, windowMs: number): number {
  const cutoff = now - windowMs
  let total = 0
  for (const entry of entries) {
    if (entry.ts >= cutoff) {
      total += entry.tokens > 0 ? entry.tokens : 0
    }
  }
  return total
}

/** The earliest in-window entry timestamp, or undefined when the window is empty. */
export function oldestTimestampInWindow(
  entries: TokenUsageEntry[],
  now: number,
  windowMs: number,
): number | undefined {
  const cutoff = now - windowMs
  let oldest: number | undefined
  for (const entry of entries) {
    if (entry.ts >= cutoff && (oldest === undefined || entry.ts < oldest)) {
      oldest = entry.ts
    }
  }
  return oldest
}

/**
 * When the window's used tokens next drop — i.e. when the OLDEST in-window entry
 * ages out (oldest + windowMs). When the window is empty there is nothing to
 * reset, so `now` is returned (the widget shows "resets now / no usage").
 */
export function windowResetsAt(entries: TokenUsageEntry[], now: number, windowMs: number): number {
  const oldest = oldestTimestampInWindow(entries, now, windowMs)
  return oldest === undefined ? now : oldest + windowMs
}

/** A positive limit is exceeded once used tokens reach or pass it. 0 = unlimited. */
export function isOverTokenLimit(usedTokens: number, limitTokens: number): boolean {
  return limitTokens > 0 && usedTokens >= limitTokens
}

/** The per-window usage shape returned by GET /v1/assistant/usage. */
export interface TokenWindowUsage {
  usedTokens: number
  /** Effective limit; 0 = unlimited. */
  limitTokens: number
  /** ISO-8601 timestamp when the window's oldest tokens roll off. */
  resetsAt: string
  /** True when usage could not be read (Redis error): the window fails OPEN. */
  unavailable?: boolean
}

/** Build the usage summary for one window from its entries + configured limit. */
export function buildWindowUsage(
  entries: TokenUsageEntry[],
  now: number,
  windowMs: number,
  limitTokens: number,
): TokenWindowUsage {
  return {
    usedTokens: sumTokensInWindow(entries, now, windowMs),
    limitTokens: limitTokens > 0 ? limitTokens : 0,
    resetsAt: new Date(windowResetsAt(entries, now, windowMs)).toISOString(),
  }
}

/** A window whose usage is unknown (Redis unavailable): reports 0 used, fails open. */
export function unavailableWindowUsage(now: number, windowMs: number, limitTokens: number): TokenWindowUsage {
  return {
    usedTokens: 0,
    limitTokens: limitTokens > 0 ? limitTokens : 0,
    resetsAt: new Date(now + windowMs).toISOString(),
    unavailable: true,
  }
}
