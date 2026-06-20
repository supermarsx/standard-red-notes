// Pure formatting + threshold helpers for the footer AI-usage chip. Kept free of
// React / app / storage so they can be unit-tested in isolation.

/** Server-enforced request cap (the proxy meters REQUESTS per day, not tokens). */
export interface ServerCap {
  /** Requests used today, as reported by GET /v1/assistant/usage. */
  used: number
  /** Daily request limit. 0 means "no cap configured". */
  limit: number
}

/**
 * Compact human token count: 12345 -> "12.3k", 1500000 -> "1.5M", < 1000 -> exact.
 * Always 1 decimal place above the threshold, trailing ".0" trimmed.
 */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) {
    return `${n}`
  }
  if (n < 1_000_000) {
    return `${trimDecimal(n / 1000)}k`
  }
  return `${trimDecimal(n / 1_000_000)}M`
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1)
}

/**
 * Fraction (0..1, clamped) of a server request cap that has been consumed.
 * Returns undefined when there is no cap to measure against.
 */
export function capFraction(cap: ServerCap | null | undefined): number | undefined {
  if (!cap || cap.limit <= 0) {
    return undefined
  }
  return Math.min(1, Math.max(0, cap.used / cap.limit))
}

/** Default fraction at/above which the chip turns to a near-limit warning color. */
export const NEAR_LIMIT_THRESHOLD = 0.8

/**
 * Whether the chip should show a near-limit warning. Only meaningful when a
 * server cap is configured; a token-only chip (no cap) never warns.
 */
export function isNearLimit(cap: ServerCap | null | undefined, threshold = NEAR_LIMIT_THRESHOLD): boolean {
  const fraction = capFraction(cap)
  return fraction !== undefined && fraction >= threshold
}

/** Whether the cap has been fully reached/exceeded. */
export function isAtLimit(cap: ServerCap | null | undefined): boolean {
  return !!cap && cap.limit > 0 && cap.used >= cap.limit
}

export interface ChipModel {
  /** Short label rendered in the footer, e.g. "AI: 12.3k" or "AI: 8 / 100". */
  label: string
  /** Whether the chip should be rendered at all. */
  visible: boolean
  /** Near-limit warning styling should be applied. */
  warn: boolean
}

/**
 * Resolve what the chip displays from (a) session token totals and (b) the
 * optional server request cap. The chip is hidden only when the user hasn't used
 * the AI this session AND no cap is configured.
 */
export function buildChipModel(totalTokens: number, requests: number, cap: ServerCap | null | undefined): ChipModel {
  const hasCap = !!cap && cap.limit > 0
  const used = hasCap || requests > 0 || totalTokens > 0

  if (!used) {
    return { label: '', visible: false, warn: false }
  }

  // When a server request cap exists, lead with used/limit requests since that is
  // what is actually enforced; otherwise show session token consumption.
  let label: string
  if (hasCap) {
    label = `AI: ${cap!.used} / ${cap!.limit}`
  } else {
    label = `AI: ${formatTokens(totalTokens)} tokens`
  }

  return { label, visible: true, warn: isNearLimit(cap) }
}
