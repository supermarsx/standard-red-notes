/**
 * Standard Red Notes: AchievementsService — web-local (localStorage) gamification.
 *
 * This is a module singleton (no DI; instrumentation calls it as fire-and-forget).
 * It deliberately does NOT use snjs PrefKeys / synced settings — those live in
 * off-limits packages. State and config are persisted to localStorage, mirroring
 * the autoMoveSetting.ts pattern (localStorage + a CustomEvent for same-tab
 * subscribers, plus the native `storage` event for other tabs).
 *
 * EVERY localStorage access is guarded (private mode / non-DOM environments), and
 * NOTHING here ever throws into a caller — achievement instrumentation must never
 * break the feature it is observing.
 */

import { addToast, ToastType } from '@standardnotes/toast'

import {
  ACHIEVEMENTS,
  AchievementDefinition,
  CATEGORY_COMPLETION_ACHIEVEMENTS,
  METRICS,
  definitionsForMetric,
} from './achievementDefinitions'

const STATE_STORAGE_KEY = 'sn_achievements_state'
const CONFIG_STORAGE_KEY = 'sn_achievements_config'
const CHANGE_EVENT = 'sn-achievements-changed'

export type AchievementUnlock = { at?: string }

export type AchievementsState = {
  metrics: Record<string, number>
  unlocked: Record<string, AchievementUnlock>
}

export type AchievementsConfig = {
  enabled: boolean
  perAchievement: Record<string, boolean>
  recordTimestamps: boolean
  /** Show a toast notification when an achievement unlocks (default true). */
  showUnlockToasts: boolean
}

export type AchievementProgressEntry = {
  def: AchievementDefinition
  current: number
  unlocked: boolean
  unlockedAt?: string
}

const defaultState = (): AchievementsState => ({ metrics: {}, unlocked: {} })

const defaultConfig = (): AchievementsConfig => ({
  enabled: true,
  perAchievement: {},
  recordTimestamps: true,
  showUnlockToasts: true,
})

class AchievementsServiceImpl {
  private state: AchievementsState = defaultState()
  private config: AchievementsConfig = defaultConfig()
  private loaded = false

  // -- persistence ---------------------------------------------------------

  private ensureLoaded(): void {
    if (this.loaded) {
      return
    }
    this.loaded = true
    this.state = this.readJson(STATE_STORAGE_KEY, defaultState)
    this.config = this.readJson(CONFIG_STORAGE_KEY, defaultConfig)
    // Normalize shape in case of partial/legacy data.
    if (!this.state.metrics || typeof this.state.metrics !== 'object') {
      this.state.metrics = {}
    }
    if (!this.state.unlocked || typeof this.state.unlocked !== 'object') {
      this.state.unlocked = {}
    }
    if (!this.config.perAchievement || typeof this.config.perAchievement !== 'object') {
      this.config.perAchievement = {}
    }
    if (typeof this.config.enabled !== 'boolean') {
      this.config.enabled = true
    }
    if (typeof this.config.recordTimestamps !== 'boolean') {
      this.config.recordTimestamps = true
    }
    if (typeof this.config.showUnlockToasts !== 'boolean') {
      this.config.showUnlockToasts = true
    }
  }

  private readJson<T>(key: string, fallback: () => T): T {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) {
        return fallback()
      }
      const parsed = JSON.parse(raw) as T
      return parsed ?? fallback()
    } catch {
      return fallback()
    }
  }

  private persistState(): void {
    try {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // Ignore — toggle/counter simply won't persist (private mode).
    }
  }

  private persistConfig(): void {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config))
    } catch {
      // Ignore.
    }
  }

  private notify(): void {
    try {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
    } catch {
      // Ignore (non-DOM environments / SSR).
    }
  }

  // -- enablement checks ---------------------------------------------------

  /** True when the master switch is on AND this achievement is individually enabled. */
  private isAchievementEnabled(def: AchievementDefinition): boolean {
    if (!this.config.enabled) {
      return false
    }
    const per = this.config.perAchievement[def.id]
    return per !== false // default true
  }

  /**
   * Evaluate every definition tied to `metric` and unlock any newly-met ones.
   * Returns true if anything changed so the caller can decide whether to persist
   * and notify in one batch.
   */
  private evaluateMetric(metric: string): boolean {
    let changed = false
    for (const def of definitionsForMetric(metric)) {
      if (this.state.unlocked[def.id]) {
        continue
      }
      if (!this.isAchievementEnabled(def)) {
        continue
      }
      const current = this.state.metrics[metric] ?? 0
      if (current >= def.threshold) {
        this.unlock(def)
        changed = true
      }
    }
    return changed
  }

  private unlock(def: AchievementDefinition): void {
    this.state.unlocked[def.id] = this.config.recordTimestamps ? { at: new Date().toISOString() } : {}
    // Notify the user via the app's standard toast system. The achievement is now
    // unlocked, so revealing a previously-hidden name here is intentional/fine.
    // Only when the master switch AND the per-feature toast flag are both on.
    if (this.config.enabled && this.config.showUnlockToasts) {
      try {
        addToast({ type: ToastType.Success, message: `Achievement unlocked: ${def.name}` })
      } catch {
        // Fire-and-forget: a toast failure must never break instrumentation.
      }
    }
    // Maintain the meta "unlockedCount" counter, then re-evaluate the meta
    // achievements that depend on it (Pin Collector, Completionist). We guard
    // against infinite recursion: the meta achievements only ever raise the
    // count, and once unlocked they're skipped.
    const newCount = Object.keys(this.state.unlocked).length
    if (def.metric !== METRICS.unlockedCount) {
      const prev = this.state.metrics[METRICS.unlockedCount] ?? 0
      if (newCount > prev) {
        this.state.metrics[METRICS.unlockedCount] = newCount
        // Re-evaluate meta achievements (without re-persisting yet).
        this.evaluateMetric(METRICS.unlockedCount)
      }
    }

    // After any unlock, check whether a whole category is now complete (which
    // unlocks its "category master"). Bounded recursion: each master's metric is
    // set once and then skipped on re-entry.
    this.evaluateCategoryCompletions()
  }

  /**
   * For each "category master", set its boolean metric (and unlock it) once every
   * NON-HIDDEN achievement in that category — other than the master — is unlocked.
   */
  private evaluateCategoryCompletions(): void {
    for (const { metric, category } of CATEGORY_COMPLETION_ACHIEVEMENTS) {
      if ((this.state.metrics[metric] ?? 0) >= 1) {
        continue
      }
      const targets = ACHIEVEMENTS.filter(
        (a) => a.category === category && !a.hidden && a.metric !== metric,
      )
      if (targets.length === 0) {
        continue
      }
      if (targets.every((a) => this.state.unlocked[a.id])) {
        this.state.metrics[metric] = 1
        this.evaluateMetric(metric)
      }
    }
  }

  // -- public mutation API -------------------------------------------------

  /** Add `by` to a counter, then unlock any newly-met achievements for it. */
  increment(metric: string, by = 1): void {
    try {
      this.ensureLoaded()
      const current = this.state.metrics[metric] ?? 0
      this.state.metrics[metric] = current + by
      this.evaluateMetric(metric)
      this.persistState()
      this.notify()
    } catch {
      // Fire-and-forget: never throw into instrumentation callers.
    }
  }

  /** Set a counter to max(current, value) — used for per-note max edits, ages, etc. */
  setAtLeast(metric: string, value: number): void {
    try {
      this.ensureLoaded()
      const current = this.state.metrics[metric] ?? 0
      if (value <= current) {
        return
      }
      this.state.metrics[metric] = value
      this.evaluateMetric(metric)
      this.persistState()
      this.notify()
    } catch {
      // Fire-and-forget.
    }
  }

  /** Convenience for boolean "did this once" achievements. */
  markEvent(metric: string): void {
    this.setAtLeast(metric, 1)
  }

  // -- read API ------------------------------------------------------------

  getMetric(metric: string): number {
    try {
      this.ensureLoaded()
      return this.state.metrics[metric] ?? 0
    } catch {
      return 0
    }
  }

  /** Per-achievement progress snapshot for the UI / assistant. */
  getProgress(): AchievementProgressEntry[] {
    try {
      this.ensureLoaded()
      return ACHIEVEMENTS.map((def) => {
        const unlock = this.state.unlocked[def.id]
        return {
          def,
          current: this.state.metrics[def.metric] ?? 0,
          unlocked: Boolean(unlock),
          unlockedAt: unlock?.at,
        }
      })
    } catch {
      return ACHIEVEMENTS.map((def) => ({ def, current: 0, unlocked: false }))
    }
  }

  // -- config API ----------------------------------------------------------

  getConfig(): AchievementsConfig {
    try {
      this.ensureLoaded()
      return {
        enabled: this.config.enabled,
        recordTimestamps: this.config.recordTimestamps,
        showUnlockToasts: this.config.showUnlockToasts,
        perAchievement: { ...this.config.perAchievement },
      }
    } catch {
      return defaultConfig()
    }
  }

  setConfig(config: Partial<AchievementsConfig>): void {
    try {
      this.ensureLoaded()
      if (typeof config.enabled === 'boolean') {
        this.config.enabled = config.enabled
      }
      if (typeof config.recordTimestamps === 'boolean') {
        this.config.recordTimestamps = config.recordTimestamps
      }
      if (typeof config.showUnlockToasts === 'boolean') {
        this.config.showUnlockToasts = config.showUnlockToasts
      }
      if (config.perAchievement && typeof config.perAchievement === 'object') {
        this.config.perAchievement = { ...this.config.perAchievement, ...config.perAchievement }
      }
      this.persistConfig()
      this.notify()
    } catch {
      // Ignore.
    }
  }

  setAchievementEnabled(id: string, enabled: boolean): void {
    try {
      this.ensureLoaded()
      this.config.perAchievement[id] = enabled
      this.persistConfig()
      this.notify()
    } catch {
      // Ignore.
    }
  }

  setMasterEnabled(enabled: boolean): void {
    try {
      this.ensureLoaded()
      this.config.enabled = enabled
      this.persistConfig()
      this.notify()
    } catch {
      // Ignore.
    }
  }

  setRecordTimestamps(enabled: boolean): void {
    try {
      this.ensureLoaded()
      this.config.recordTimestamps = enabled
      this.persistConfig()
      this.notify()
    } catch {
      // Ignore.
    }
  }

  setShowUnlockToasts(enabled: boolean): void {
    try {
      this.ensureLoaded()
      this.config.showUnlockToasts = enabled
      this.persistConfig()
      this.notify()
    } catch {
      // Ignore.
    }
  }

  /** Wipe all metrics and unlocks (config is preserved). */
  resetAll(): void {
    try {
      this.ensureLoaded()
      this.state = defaultState()
      this.persistState()
      this.notify()
    } catch {
      // Ignore.
    }
  }

  // -- subscription --------------------------------------------------------

  /** Subscribe to any state/config change (same-tab CustomEvent + cross-tab storage). */
  subscribe(callback: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STATE_STORAGE_KEY || event.key === CONFIG_STORAGE_KEY) {
        // Cross-tab change — drop our cached copy so the next read reloads it.
        this.loaded = false
        callback()
      }
    }
    try {
      window.addEventListener(CHANGE_EVENT, callback)
      window.addEventListener('storage', onStorage)
    } catch {
      return () => {}
    }
    return () => {
      try {
        window.removeEventListener(CHANGE_EVENT, callback)
        window.removeEventListener('storage', onStorage)
      } catch {
        // Ignore.
      }
    }
  }
}

/** The module singleton. Import this everywhere instrumentation is emitted. */
export const achievements = new AchievementsServiceImpl()

export type AchievementsService = AchievementsServiceImpl
