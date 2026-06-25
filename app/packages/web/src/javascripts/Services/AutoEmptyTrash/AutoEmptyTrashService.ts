import { ApplicationEvent, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { achievements, METRICS } from '@/Achievements'

/**
 * Standard Red Notes: Auto-empty trash.
 *
 * Permanently deletes notes that have been sitting in the Trash longer than a
 * user-configured age. Because notes are end-to-end encrypted, the server cannot
 * decide what to delete — the CLIENT must perform the permanent deletion. This is
 * irreversible, so the feature is opt-out friendly ("Never" disables it) and only
 * ever acts on items that are actually trashed (`item.trashed === true`).
 *
 * Storage: the chosen interval lives in localStorage (web-only), deliberately NOT
 * in the published `@standardnotes/models` PrefKey enum, so this stays a web-only
 * change (no build:snjs / models edits). It is therefore per-device, which is the
 * right scope for a destructive maintenance action.
 *
 * Timestamp proxy: there is no explicit "trashedAt" on items, so we age each note
 * against `item.userModifiedDate` (trashing a note updates it). Honest limitations:
 *   - An item edited and THEN trashed ages from (approximately) the trash time. Good.
 *   - An item trashed long ago and never touched again ages correctly. Good.
 *   - Editing a note while it is in the trash resets its clock, delaying deletion.
 * This is a conservative bias (we keep things a bit longer rather than delete early),
 * which is the safe direction for a destructive action.
 */

const STORAGE_KEY = 'sn-auto-empty-trash-interval-ms'

/** How often the cleanup pass may run while the app is open. */
const CLEANUP_THROTTLE_MS = 60 * 60 * 1000 // 1 hour

/** Max items to permanently delete per pass, to keep sync payloads reasonable. */
const MAX_DELETES_PER_PASS = 100

const DAY_MS = 24 * 60 * 60 * 1000

/** "Never" — the feature is disabled. */
export const AUTO_EMPTY_TRASH_NEVER = 0

/**
 * Selectable intervals (ms). 30 days is the default (see DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS).
 * "1 month" is offered as the 30-day option, matching the product default.
 */
export const AutoEmptyTrashInterval = {
  Never: AUTO_EMPTY_TRASH_NEVER,
  OneDay: 1 * DAY_MS,
  ThreeDays: 3 * DAY_MS,
  OneWeek: 7 * DAY_MS,
  OneMonth: 30 * DAY_MS,
  SixMonths: 182 * DAY_MS,
  OneYear: 365 * DAY_MS,
  FiveYears: 5 * 365 * DAY_MS,
  TenYears: 10 * 365 * DAY_MS,
  TwentyYears: 20 * 365 * DAY_MS,
} as const

export type AutoEmptyTrashIntervalValue = (typeof AutoEmptyTrashInterval)[keyof typeof AutoEmptyTrashInterval]

/** Default: permanently delete trashed notes after 30 days. */
export const DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS: number = AutoEmptyTrashInterval.OneMonth

export const AUTO_EMPTY_TRASH_OPTIONS: { value: number; label: string }[] = [
  { value: AutoEmptyTrashInterval.Never, label: 'Never (off)' },
  { value: AutoEmptyTrashInterval.OneDay, label: '1 day' },
  { value: AutoEmptyTrashInterval.ThreeDays, label: '3 days' },
  { value: AutoEmptyTrashInterval.OneWeek, label: '1 week' },
  { value: AutoEmptyTrashInterval.OneMonth, label: '1 month' },
  { value: AutoEmptyTrashInterval.SixMonths, label: '6 months' },
  { value: AutoEmptyTrashInterval.OneYear, label: '1 year' },
  { value: AutoEmptyTrashInterval.FiveYears, label: '5 years' },
  { value: AutoEmptyTrashInterval.TenYears, label: '10 years' },
  { value: AutoEmptyTrashInterval.TwentyYears, label: '20 years' },
]

const VALID_INTERVALS = new Set<number>(AUTO_EMPTY_TRASH_OPTIONS.map((o) => o.value))

/**
 * Read the configured interval (ms) from localStorage. Returns the 30-day default
 * when nothing valid is stored. Exported as a free function so the preferences UI
 * and the service share one source of truth without needing a service instance.
 */
export function readAutoEmptyTrashInterval(): number {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS
    }
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && VALID_INTERVALS.has(parsed)) {
      return parsed
    }
    return DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS
  } catch {
    return DEFAULT_AUTO_EMPTY_TRASH_INTERVAL_MS
  }
}

/** Persist the configured interval (ms). Best-effort; ignores storage failures. */
export function writeAutoEmptyTrashInterval(intervalMs: number): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(intervalMs))
  } catch {
    /* storage may be unavailable; the setting display is best-effort */
  }
}

/**
 * PURE selector — the heart of the feature, kept side-effect-free so it can be
 * unit-tested exhaustively. Given a list of items, the configured interval, and a
 * reference "now", returns exactly the trashed notes that are due for permanent
 * deletion.
 *
 * Rules:
 *   - intervalMs <= 0 ("Never") returns an empty array (feature disabled).
 *   - Only items with `trashed === true` are ever considered.
 *   - An item is due when (now - userModifiedDate) >= intervalMs.
 */
export function selectTrashedItemsDueForDeletion(
  items: SNNote[],
  intervalMs: number,
  now: number,
): SNNote[] {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return []
  }

  return items.filter((item) => {
    if (!item.trashed) {
      return false
    }
    const modified = item.userModifiedDate?.getTime()
    if (typeof modified !== 'number' || !Number.isFinite(modified)) {
      return false
    }
    return now - modified >= intervalMs
  })
}

export class AutoEmptyTrashService {
  private lastRunAt = 0
  private hasRunInitialPass = false
  private running = false
  private disposer?: () => void

  constructor(private application: WebApplication) {
    this.disposer = this.application.addEventObserver(async (event) => {
      // Run after the first full sync so the trash list reflects the server,
      // then opportunistically on later full syncs subject to the throttle.
      if (event === ApplicationEvent.CompletedFullSync) {
        void this.runCleanupIfDue()
      }
    })
  }

  deinit(): void {
    this.disposer?.()
    this.disposer = undefined
    ;(this.application as unknown) = undefined
  }

  /** Throttled entry point. Safe to call as often as syncs occur. */
  async runCleanupIfDue(): Promise<void> {
    const now = Date.now()

    // Always allow the first pass after startup; afterwards honor the throttle.
    if (this.hasRunInitialPass && now - this.lastRunAt < CLEANUP_THROTTLE_MS) {
      return
    }

    await this.runCleanup(now)
  }

  /**
   * Perform one cleanup pass. Guards against offline/no-session and overlapping
   * runs, batches deletes, and catches errors per item so one bad item can't abort
   * the whole pass. Returns the number of items permanently deleted (for tests).
   */
  async runCleanup(now = Date.now()): Promise<number> {
    if (this.running) {
      return 0
    }

    const intervalMs = readAutoEmptyTrashInterval()
    if (intervalMs <= 0) {
      // "Never" — feature disabled. Still mark the initial pass as done so the
      // throttle behaves consistently if the user later enables it.
      this.hasRunInitialPass = true
      this.lastRunAt = now
      return 0
    }

    // Offline guard: there is no point attempting destructive deletes + sync while
    // offline. navigator.onLine is a best-effort hint; a signed-out local-only
    // session is still allowed (deletes persist to local storage and sync later).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 0
    }

    this.running = true
    this.hasRunInitialPass = true
    this.lastRunAt = now

    try {
      const trashed = this.application.items.trashedItems
      const due = selectTrashedItemsDueForDeletion(trashed, intervalMs, now).slice(0, MAX_DELETES_PER_PASS)

      if (due.length === 0) {
        return 0
      }

      let deleted = 0
      for (const item of due) {
        try {
          await this.application.mutator.deleteItem(item)
          deleted++
          achievements.increment(METRICS.itemsDeletedTotal)
        } catch (error) {
          console.error('[AutoEmptyTrash] Failed to permanently delete trashed item', error)
        }
      }

      if (deleted > 0) {
        this.application.sync.sync().catch(console.error)
        // eslint-disable-next-line no-console
        console.log(`[AutoEmptyTrash] Permanently deleted ${deleted} trashed note(s) older than the configured age.`)
      }

      return deleted
    } finally {
      this.running = false
    }
  }
}
