import { action, makeObservable, observable, runInAction } from 'mobx'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  DEFAULT_SEARCH_INDEX_SETTINGS,
  normalizeSearchIndexSettings,
  SearchIndexRunnerStatus,
  SearchIndexSchedulerMode,
  SearchIndexScope,
  SearchIndexScopeMode,
  SearchIndexSettings,
  SearchIndexSettingsKey,
} from './searchIndexSettings'

/** Polyfill-ish handles so we work whether or not requestIdleCallback exists. */
type IdleHandle = number | ReturnType<typeof setTimeout>

/**
 * Standard Red Notes: imperative runner for the background search indexer.
 *
 * Owns the runtime controls the Search & Indexing settings pane exposes:
 *  - enable/disable the background indexer (master on/off, persisted);
 *  - start()/stop() the runner imperatively;
 *  - a scheduler with several modes:
 *      'on-change' — keep the index live via the controller's incremental
 *                    collectIndexUpdates path (no scheduled full rebuild);
 *      'idle'      — refresh on app idle via requestIdleCallback (timer fallback);
 *      'interval'  — periodic full re-index every intervalMinutes;
 *      'manual'    — only rebuild on an explicit rebuildNow() call;
 *  - a scope (whitelist/blacklist by tag) controlling WHICH notes get indexed;
 *  - a manual purge that clears the index and resets status.
 *
 * The heavy work itself runs OFF the main thread inside ThreadedSearchIndex (the
 * ItemListController owns that instance); this runner just drives WHEN a rebuild
 * happens and WHAT the scope is. When disabled or stopped, search transparently
 * falls back to the existing on-demand index/substring path in the controller.
 *
 * Settings persist via the app-storage K/V (no @standardnotes/models changes).
 */
export class SearchIndexRunner {
  settings: SearchIndexSettings = DEFAULT_SEARCH_INDEX_SETTINGS
  status: SearchIndexRunnerStatus = 'disabled'
  /** True while a rebuild is in flight (drives the "indexing…" UI state). */
  isIndexing = false
  /** True once start() has been called and the runner is active. */
  isRunning = false

  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private idleHandle: IdleHandle | null = null
  /** Re-arm cadence for the idle scheduler's timer fallback / re-scheduling. */
  private static readonly IDLE_RESCHEDULE_MS = 5 * 60 * 1000

  constructor(private application: WebApplication) {
    makeObservable(this, {
      settings: observable,
      status: observable,
      isIndexing: observable,
      isRunning: observable,
      setSettings: action,
      setStatus: action,
      setIsIndexing: action,
      setIsRunning: action,
    })

    this.settings = this.readSettings()
    this.status = this.settings.enabled ? 'idle' : 'disabled'

    // Push the persisted scope into the controller before any (re)build so the
    // very first index respects the configured whitelist/blacklist.
    this.syncScopeToController()

    // Auto-start the scheduler on launch when the user left it enabled.
    if (this.settings.enabled) {
      this.start()
    }
  }

  // --- persistence ---------------------------------------------------------

  private readSettings(): SearchIndexSettings {
    try {
      const raw = this.application.getValue<Partial<SearchIndexSettings> | undefined>(SearchIndexSettingsKey)
      return normalizeSearchIndexSettings(raw)
    } catch {
      return normalizeSearchIndexSettings(undefined)
    }
  }

  private persist(settings: SearchIndexSettings): void {
    try {
      this.application.setValue(SearchIndexSettingsKey, settings)
    } catch {
      // Storage may be unavailable (e.g. before launch); in-memory state still applies.
    }
  }

  // --- mobx action setters -------------------------------------------------

  setSettings = (settings: SearchIndexSettings): void => {
    this.settings = settings
  }

  setStatus = (status: SearchIndexRunnerStatus): void => {
    this.status = status
  }

  setIsIndexing = (value: boolean): void => {
    this.isIndexing = value
  }

  setIsRunning = (value: boolean): void => {
    this.isRunning = value
  }

  // --- public controls -----------------------------------------------------

  /** Current inclusion/exclusion scope (read by the controller's index build). */
  get scope(): SearchIndexScope {
    return this.settings.scope
  }

  /** Master enable/disable. Disabling stops the runner; enabling starts it. */
  setEnabled(enabled: boolean): void {
    const next = normalizeSearchIndexSettings({ ...this.settings, enabled })
    this.setSettings(next)
    this.persist(next)
    // Keep the existing query-time fast path in lockstep with the master toggle.
    void this.application.setPreference(PrefKey.SearchIndexEnabled, enabled)
    if (enabled) {
      this.start()
    } else {
      this.stop()
    }
  }

  /** Update the scheduler mode and (re)arm the scheduler. */
  setSchedulerMode(mode: SearchIndexSchedulerMode): void {
    const next = normalizeSearchIndexSettings({ ...this.settings, schedulerMode: mode })
    this.setSettings(next)
    this.persist(next)
    if (this.isRunning) {
      this.armScheduler()
    }
  }

  /** Update the re-index interval (minutes) and re-arm if running on interval mode. */
  setIntervalMinutes(minutes: number): void {
    const next = normalizeSearchIndexSettings({ ...this.settings, intervalMinutes: minutes })
    this.setSettings(next)
    this.persist(next)
    if (this.isRunning && next.schedulerMode === 'interval') {
      this.armScheduler()
    }
  }

  /** Replace the whole inclusion/exclusion scope and rebuild so it takes effect. */
  setScope(scope: SearchIndexScope): void {
    const next = normalizeSearchIndexSettings({ ...this.settings, scope })
    this.setSettings(next)
    this.persist(next)
    this.syncScopeToController()
    // The scope changes WHICH notes belong in the index, so a full rebuild is the
    // only way to apply it (incremental updates only react to item changes).
    if (this.settings.enabled) {
      void this.rebuildNow()
    }
  }

  /** Mirror the runner's scope into the controller that owns the index build. */
  private syncScopeToController(): void {
    try {
      this.application.itemListController.setSearchIndexScope(this.settings.scope)
    } catch {
      // Controller may not be constructed yet during early launch; the constructor
      // re-syncs and rebuildNow() reads the scope again, so this is best-effort.
    }
  }

  /** Convenience: change just the scope mode, keeping the selected tags. */
  setScopeMode(mode: SearchIndexScopeMode): void {
    this.setScope({ ...this.settings.scope, mode })
  }

  /** Convenience: change just the scope tag set, keeping the mode. */
  setScopeTagIds(tagIds: string[]): void {
    this.setScope({ ...this.settings.scope, tagIds })
  }

  /**
   * Start the background indexer: mark running, do an initial rebuild, and arm the
   * scheduler if configured. No-op when disabled or already running.
   */
  start(): void {
    if (!this.settings.enabled || this.isRunning) {
      return
    }
    this.setIsRunning(true)
    this.setStatus('idle')
    void this.rebuildNow()
    this.armScheduler()
  }

  /** Stop the runner: clear all schedulers and go disabled/idle. */
  stop(): void {
    this.clearScheduler()
    this.setIsRunning(false)
    this.setStatus(this.settings.enabled ? 'idle' : 'disabled')
  }

  /**
   * Force a fresh rebuild now (manual "Rebuild now" button or a scheduler tick).
   * Drives the indexing status and never overlaps two builds.
   */
  async rebuildNow(): Promise<void> {
    if (this.isIndexing) {
      return
    }
    this.setIsIndexing(true)
    this.setStatus('indexing')
    try {
      await this.application.itemListController.rebuildSearchIndex()
    } catch {
      // Swallow: the controller falls back to on-demand/substring search on failure.
    } finally {
      runInAction(() => {
        this.setIsIndexing(false)
        this.setStatus(this.settings.enabled ? 'idle' : 'disabled')
      })
    }
  }

  /**
   * Manual purge: clear the in-memory/worker index (and any lazily-cached query
   * results) and reset the runner status. The next query/rebuild repopulates it.
   */
  purgeIndex(): void {
    this.application.itemListController.flushSearchIndex()
    this.setIsIndexing(false)
    this.setStatus(this.settings.enabled ? 'idle' : 'disabled')
  }

  // --- scheduler -----------------------------------------------------------

  private armScheduler(): void {
    this.clearScheduler()
    switch (this.settings.schedulerMode) {
      case 'interval': {
        const periodMs = this.settings.intervalMinutes * 60 * 1000
        this.intervalHandle = setInterval(() => {
          void this.rebuildNow()
        }, periodMs)
        break
      }
      case 'idle':
        this.scheduleIdleRebuild()
        break
      // 'on-change' relies on the controller's incremental collectIndexUpdates path
      // (kept live by the initial rebuild in start()); 'manual'/'off' arm nothing.
      case 'on-change':
      case 'manual':
      case 'off':
        break
    }
  }

  /**
   * Schedule a one-shot idle rebuild. Uses requestIdleCallback when available so
   * the full rebuild runs while the app is otherwise idle; falls back to a timer
   * elsewhere (jsdom/older browsers). Re-arms itself so the index keeps refreshing.
   */
  private scheduleIdleRebuild(): void {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback
    const run = () => {
      void this.rebuildNow().finally(() => {
        // Only re-arm while still running in idle mode.
        if (this.isRunning && this.settings.schedulerMode === 'idle') {
          this.scheduleIdleRebuild()
        }
      })
    }
    if (typeof ric === 'function') {
      this.idleHandle = ric(run, { timeout: SearchIndexRunner.IDLE_RESCHEDULE_MS })
    } else {
      this.idleHandle = setTimeout(run, SearchIndexRunner.IDLE_RESCHEDULE_MS)
    }
  }

  private clearScheduler(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.idleHandle !== null) {
      const cic = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback
      if (typeof cic === 'function' && typeof this.idleHandle === 'number') {
        cic(this.idleHandle)
      } else {
        clearTimeout(this.idleHandle as ReturnType<typeof setTimeout>)
      }
      this.idleHandle = null
    }
  }

  /** Release timers; call when the owning application is torn down. */
  deinit(): void {
    this.clearScheduler()
  }
}
