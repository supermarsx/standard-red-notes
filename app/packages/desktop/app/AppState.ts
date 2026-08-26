import { Store } from './javascripts/Main/Store/Store'
import { StoreKeys } from './javascripts/Main/Store/StoreKeys'
import { Paths, Urls } from './javascripts/Main/Types/Paths'
import { UpdateState } from './javascripts/Main/UpdateManager'
import { WindowState } from './javascripts/Main/Window'
import { SecondInstancePayload } from './javascripts/Shared/SecondInstance'

export class AppState {
  readonly version: string
  readonly store: Store
  readonly startUrl = Urls.indexHtml
  readonly isPrimaryInstance: boolean
  public willQuitApp = false
  /**
   * All currently open app windows. Multi-window support means there can be
   * more than one. The most-recently-focused window is tracked separately via
   * `windowState` for operations that target a single "active" window (deep
   * links, dev tools, etc.).
   */
  public readonly windows = new Set<WindowState>()
  public windowState?: WindowState
  public deepLinkUrl?: string
  public readonly updates: UpdateState
  public lastRunVersion: string

  constructor(app: Electron.App) {
    this.version = app.getVersion()
    this.store = new Store(Paths.userDataDir)
    /**
     * The single-instance lock is unchanged — it still decides whether this
     * process is allowed to run. The payload only rides along so the instance
     * that ALREADY holds the lock can say which build tried to join it. Without
     * it, launching a newer build over a running older one looks identical to
     * launching the same build twice: the window focuses and nothing hints that
     * the code you just built is not the code on screen.
     */
    const secondInstancePayload: SecondInstancePayload = { version: this.version }
    this.isPrimaryInstance = app.requestSingleInstanceLock(secondInstancePayload)

    this.lastRunVersion = this.store.get(StoreKeys.LastRunVersion) || 'unknown'
    this.store.set(StoreKeys.LastRunVersion, this.version)

    this.updates = new UpdateState(this)
  }

  public isRunningVersionForFirstTime(): boolean {
    return this.lastRunVersion !== this.version
  }
}
