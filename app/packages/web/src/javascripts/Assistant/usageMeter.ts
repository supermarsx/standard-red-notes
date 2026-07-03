// Pure, React-free helpers backing the in-chat AI token-usage meter. Kept out of
// the component (and free of app/storage/DOM) so the window math, colour/label
// thresholds and reset-time formatting can be unit-tested in isolation.

import { formatTokens } from '@/Components/Footer/assistantUsageFormat'

/** One rolling window as returned by GET /v1/assistant/usage. */
export interface TokenWindowUsage {
  usedTokens: number
  /** 0 (or unset) means the window is UNLIMITED. */
  limitTokens: number
  /** ISO-8601 instant when the window's oldest tokens roll off. */
  resetsAt: string
  /** True when the server could not read this window (Redis error): fails open. */
  unavailable?: boolean
}

/** The full usage payload (back-compat daily fields + the two token windows). */
export interface AssistantUsageResponse {
  used: number
  limit: number
  resetsAt: string
  daily?: { usedRequests: number; limitRequests: number; resetsAt: string }
  tokens?: { fiveHour: TokenWindowUsage; weekly: TokenWindowUsage }
}

export type MeterState = 'unlimited' | 'ok' | 'warn' | 'over' | 'unavailable'

/** Fraction of a limit at/above which the meter turns amber (near the cap). */
export const WARN_FRACTION = 0.8

export interface MeterModel {
  /** No cap configured for this window. */
  unlimited: boolean
  /** Usage couldn't be read from the server (window shown muted). */
  unavailable: boolean
  /** Consumed fraction, clamped to 0..1. 0 when unlimited/unavailable. */
  fraction: number
  /** Whole-number percent (0..100). */
  percent: number
  /** "42%" — empty string when there is nothing meaningful to show. */
  percentLabel: string
  state: MeterState
  /** "12.3k" — compact used-token count. */
  usedLabel: string
  /** "50k" or "∞" (unlimited). */
  limitLabel: string
  /** "12.3k / 50k" or, when unlimited, "12.3k". */
  valueLabel: string
  /** Tailwind/stylekit class for the filled portion of the bar. */
  barColorClass: string
  /** Tailwind/stylekit text colour class matching the state. */
  textColorClass: string
}

/** Consumed fraction of a window (0..1), or undefined when there is no cap. */
export function windowFraction(window: TokenWindowUsage): number | undefined {
  if (!window || window.limitTokens <= 0) {
    return undefined
  }
  return Math.min(1, Math.max(0, window.usedTokens / window.limitTokens))
}

function stateColorClasses(state: MeterState): { bar: string; text: string } {
  switch (state) {
    case 'over':
      return { bar: 'bg-danger', text: 'text-danger' }
    case 'warn':
      return { bar: 'bg-warning', text: 'text-warning' }
    case 'ok':
      return { bar: 'bg-success', text: 'text-success' }
    case 'unavailable':
      return { bar: 'bg-passive-2', text: 'text-passive-1' }
    case 'unlimited':
    default:
      return { bar: 'bg-info', text: 'text-passive-0' }
  }
}

/**
 * Resolve everything the meter component renders for one window: fill fraction,
 * headroom-based colour (green -> amber near the cap -> red at/over it), compact
 * used/limit labels, and the "unlimited"/"unavailable" states.
 */
export function buildMeterModel(window: TokenWindowUsage | undefined): MeterModel {
  if (!window || window.unavailable) {
    const colors = stateColorClasses('unavailable')
    return {
      unlimited: false,
      unavailable: true,
      fraction: 0,
      percent: 0,
      percentLabel: '',
      state: 'unavailable',
      usedLabel: window ? formatTokens(window.usedTokens) : '0',
      limitLabel: '—',
      valueLabel: 'Usage unavailable',
      barColorClass: colors.bar,
      textColorClass: colors.text,
    }
  }

  const usedLabel = formatTokens(window.usedTokens)
  const fractionOrUndef = windowFraction(window)

  if (fractionOrUndef === undefined) {
    // Unlimited: no cap to fill, just show consumption.
    const colors = stateColorClasses('unlimited')
    return {
      unlimited: true,
      unavailable: false,
      fraction: 0,
      percent: 0,
      percentLabel: '',
      state: 'unlimited',
      usedLabel,
      limitLabel: '∞',
      valueLabel: usedLabel,
      barColorClass: colors.bar,
      textColorClass: colors.text,
    }
  }

  const fraction = fractionOrUndef
  const percent = Math.round(fraction * 100)
  const state: MeterState = fraction >= 1 ? 'over' : fraction >= WARN_FRACTION ? 'warn' : 'ok'
  const colors = stateColorClasses(state)

  return {
    unlimited: false,
    unavailable: false,
    fraction,
    percent,
    percentLabel: `${percent}%`,
    state,
    usedLabel,
    limitLabel: formatTokens(window.limitTokens),
    valueLabel: `${usedLabel} / ${formatTokens(window.limitTokens)}`,
    barColorClass: colors.bar,
    textColorClass: colors.text,
  }
}

/**
 * Compact "time until this window frees up" label from an ISO reset instant.
 * "2d 3h", "3h 20m", "45m", "30s", or "now" when already elapsed. Returns ''
 * for an unparseable/empty input so the caller can simply omit it.
 */
export function formatResetDuration(resetsAt: string | undefined, now: number = Date.now()): string {
  if (!resetsAt) {
    return ''
  }
  const target = new Date(resetsAt).getTime()
  if (!Number.isFinite(target)) {
    return ''
  }
  let remainingMs = target - now
  if (remainingMs <= 0) {
    return 'now'
  }

  const days = Math.floor(remainingMs / 86_400_000)
  remainingMs -= days * 86_400_000
  const hours = Math.floor(remainingMs / 3_600_000)
  remainingMs -= hours * 3_600_000
  const minutes = Math.floor(remainingMs / 60_000)
  remainingMs -= minutes * 60_000
  const seconds = Math.floor(remainingMs / 1000)

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (minutes > 0) {
    return `${minutes}m`
  }
  return `${seconds}s`
}
