import { Store } from './javascripts/Main/Store/Store'
import { StoreKeys } from './javascripts/Main/Store/StoreKeys'
import { Paths, Urls } from './javascripts/Main/Types/Paths'
import { UpdateState } from './javascripts/Main/UpdateManager'
import { WindowState } from './javascripts/Main/Window'

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
    this.isPrimaryInstance = app.requestSingleInstanceLock()

    this.lastRunVersion = this.store.get(StoreKeys.LastRunVersion) || 'unknown'
    this.store.set(StoreKeys.LastRunVersion, this.version)

    this.updates = new UpdateState(this)
  }

  public isRunningVersionForFirstTime(): boolean {
    return this.lastRunVersion !== this.version
  }
}
