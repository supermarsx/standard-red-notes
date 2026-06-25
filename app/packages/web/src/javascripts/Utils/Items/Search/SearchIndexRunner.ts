import { action, makeObservable, observable, runInAction } from 'mobx'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  DEFAULT_SEARCH_INDEX_SETTINGS,
  normalizeSearchIndexSettings,
  SearchIndexRunnerStatus,
  SearchIndexSchedulerMode,
  SearchIndexSettings,
  SearchIndexSettingsKey,
} from './searchIndexSettings'

/**
 * Standard Red Notes: imperative runner for the background search indexer.
 *
 * Owns the runtime controls the settings UI exposes:
 *  - enable/disable the background indexer (master on/off, persisted);
 *  - start()/stop() the runner imperatively;
 *  - a scheduler (schedulerMode 'off' | 'interval') that periodically re-indexes
 *    so a large account stays warm, with the interval cleared on stop/disable.
 *
 * The heavy work itself runs OFF the main thread inside ThreadedSearchIndex (the
 * ItemListController owns that instance); this runner just drives WHEN a rebuild
 * happens. When disabled or stopped, search transparently falls back to the
 * existing on-demand index/substring path in the controller.
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

  /** Update the scheduler mode (off / interval) and (re)arm the scheduler. */
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

  /** Stop the runner: clear the scheduler interval and go disabled/idle. */
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

  // --- scheduler -----------------------------------------------------------

  private armScheduler(): void {
    this.clearScheduler()
    if (this.settings.schedulerMode !== 'interval') {
      return
    }
    const periodMs = this.settings.intervalMinutes * 60 * 1000
    this.intervalHandle = setInterval(() => {
      void this.rebuildNow()
    }, periodMs)
  }

  private clearScheduler(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /** Release timers; call when the owning application is torn down. */
  deinit(): void {
    this.clearScheduler()
  }
}
