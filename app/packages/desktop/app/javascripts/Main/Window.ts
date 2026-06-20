import { clearSensitiveDirectories } from '@standardnotes/electron-clear-data'
import { BrowserWindow, Rectangle, screen, Shell } from 'electron'
import fs from 'fs'
import { debounce } from 'lodash'
import path from 'path'
import { AppMessageType, MessageType } from '../../../test/TestIpcMessage'
import { AppState } from '../../AppState'
import { MessageToWebApp } from '../Shared/IpcMessages'
import { FilesBackupManager } from './FileBackups/FileBackupsManager'
import { Keychain } from './Keychain/Keychain'
import { MediaManager } from './Media/MediaManager'
import { MenuManagerInterface } from './Menus/MenuManagerInterface'
import { buildContextMenu, createMenuManager } from './Menus/Menus'
import { initializePackageManager } from './Packages/PackageManager'
import { RemoteBridge } from './Remote/RemoteBridge'
import { initializeSearchManager } from './Search/SearchManager'
import { createSpellcheckerManager } from './SpellcheckerManager'
import { Store } from './Store/Store'
import { StoreKeys } from './Store/StoreKeys'
import { createTrayManager, TrayManager } from './TrayManager'
import { Paths } from './Types/Paths'
import { isMac, isWindows } from './Types/Platforms'
import { checkForUpdate, setupUpdates } from './UpdateManager'
import { handleTestMessage, send } from './Utils/Testing'
import { isTesting, lowercaseDriveLetter } from './Utils/Utils'
import { initializeZoomManager } from './ZoomManager'
import { HomeServerManager } from './HomeServer/HomeServerManager'
import { FilesManager } from './File/FilesManager'
import { DirectoryManager } from './Directory/DirectoryManager'

const WINDOW_DEFAULT_WIDTH = 1100
const WINDOW_DEFAULT_HEIGHT = 800
const WINDOW_MIN_WIDTH = 300
const WINDOW_MIN_HEIGHT = 400

export interface WindowState {
  window: Electron.BrowserWindow
  menuManager: MenuManagerInterface
  trayManager: TrayManager
}

function hideWindowsTaskbarPreviewThumbnail(window: BrowserWindow) {
  if (isWindows()) {
    window.setThumbnailClip({ x: 0, y: 0, width: 1, height: 1 })
  }
}

export async function createWindowState({
  shell,
  appState,
  appLocale,
  teardown,
  onNewWindow,
}: {
  shell: Shell
  appLocale: string
  appState: AppState
  teardown: () => void
  /** Invoked when the user requests a new window (e.g. from the menu). */
  onNewWindow?: () => void
}): Promise<WindowState> {
  const window = await createWindow(appState.store)

  const services = await createWindowServices(window, appState, appLocale, onNewWindow)

  require('@electron/remote/main').enable(window.webContents)
  /**
   * The RemoteBridge is exposed to renderers as a single `global.RemoteBridge`
   * that every window's preload reads via `getGlobal('RemoteBridge')`. With
   * multiple windows we therefore cannot hardcode the bridge to a single
   * BrowserWindow: window-control calls (close/minimize/maximize) must act on
   * the window the call came from. The bridge resolves that window at call time
   * via `BrowserWindow.getFocusedWindow()` (the window the user is interacting
   * with), falling back to the most-recently-created window passed here.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(global as any).RemoteBridge = new RemoteBridge(
    window,
    Keychain,
    services.packageManager,
    services.searchManager,
    {
      destroySensitiveDirectories: () => {
        const restart = true
        clearSensitiveDirectories(restart)
      },
    },
    services.menuManager,
    services.fileBackupsManager,
    services.mediaManager,
    services.homeServerManager,
    services.directoryManager,
    services.spellcheckerManager,
  )

  const shouldOpenUrl = (url: string) => url.startsWith('http') || url.startsWith('mailto')

  const windowState: WindowState = {
    window,
    ...services,
  }

  appState.windows.add(windowState)
  appState.windowState = windowState

  window.on('closed', () => {
    appState.windows.delete(windowState)
    if (appState.windowState === windowState) {
      /** Hand "active window" off to any remaining window. */
      appState.windowState = appState.windows.values().next().value
    }
    teardown()
  })

  window.on('show', () => {
    void checkForUpdate(appState, appState.updates, false)
    hideWindowsTaskbarPreviewThumbnail(window)
  })

  window.on('focus', () => {
    /** Track the most-recently-focused window as the "active" one. */
    appState.windowState = windowState
    window.webContents.send(MessageToWebApp.WindowFocused, null)
    /**
     * Cross-window live sync (sync-mediated, not shared memory): notify every
     * OTHER open window that focus moved so they pull the latest state from the
     * server. The renderer maps WindowFocused -> windowGainedFocus() ->
     * WebAppEvent.WindowDidFocus, which the web app already handles by running
     * application.sync.sync(). This means an edit made in window A is persisted
     * + synced to the server, and switching to window B nudges B to sync and
     * pick up A's change. See the storage-sharing note below.
     */
    notifyOtherWindowsOfChange(appState, window)
  })

  window.on('blur', () => {
    window.webContents.send(MessageToWebApp.WindowBlurred, null)
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('close', (event) => {
    if (!appState.willQuitApp && (isMac() || services.trayManager.shouldMinimizeToTray())) {
      /**
       * On MacOS, closing a window does not quit the app. On Window and Linux,
       * it only does if you haven't enabled minimize to tray.
       */
      event.preventDefault()
      /**
       * Handles Mac full screen issue where pressing close results
       * in a black screen.
       */
      if (window.isFullScreen()) {
        window.setFullScreen(false)
      }
      window.hide()
    }
  })

  window.webContents.session.setSpellCheckerDictionaryDownloadURL('https://dictionaries.standardnotes.org/9.4.4/')

  /** handle link clicks */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  /**
   * handle link clicks (this event is fired instead of 'new-window' when
   * target is not set to _blank, such as with window.location.assign)
   */
  window.webContents.on('will-navigate', (event, url) => {
    /** Check for windowUrl equality in the case of window.reload() calls. */
    if (fileUrlsAreEqual(url, appState.startUrl)) {
      return
    }
    if (shouldOpenUrl(url)) {
      void shell.openExternal(url)
    }
    event.preventDefault()
  })

  window.webContents.on('context-menu', (_event, params) => {
    buildContextMenu(window.webContents, params).popup()
  })

  return windowState
}

/**
 * Broadcasts a "data may have changed elsewhere" nudge to every open window
 * except `source`. Each receiving renderer reacts by running a server sync, so
 * the change becomes visible across windows.
 *
 * STORAGE / CORRECTNESS NOTE: all app windows share the same Electron session
 * (same `userData`, same IndexedDB + localStorage). Each window still runs its
 * own independent snjs application instance against that shared local database.
 * We therefore deliberately do NOT attempt shared-memory "live" co-editing of
 * the local DB across windows -- two instances mutating the same IndexedDB
 * concurrently would race and risk corruption. Instead, cross-window sync is
 * SYNC-MEDIATED: the server (and the existing websocket gateway) is the source
 * of truth. A window persists + syncs its change, and the other windows are
 * nudged to sync and pull it down. Latency is therefore "as fast as a sync
 * round-trip" (near-real-time on focus / on demand), not instantaneous shared
 * state.
 */
export function notifyOtherWindowsOfChange(appState: AppState, source: Electron.BrowserWindow): void {
  for (const other of appState.windows) {
    if (other.window === source || other.window.isDestroyed()) {
      continue
    }
    other.window.webContents.send(MessageToWebApp.WindowFocused, null)
  }
}

async function createWindow(store: Store): Promise<Electron.BrowserWindow> {
  const useSystemMenuBar = store.get(StoreKeys.UseSystemMenuBar)
  const position = await getPreviousWindowPosition()
  const window = new BrowserWindow({
    ...position.bounds,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    icon: path.join(__dirname, '/icon/Icon-512x512.png'),
    titleBarStyle: isMac() || useSystemMenuBar ? 'hiddenInset' : undefined,
    frame: isMac() ? false : useSystemMenuBar,
    webPreferences: {
      spellcheck: true,
      nodeIntegration: isTesting(),
      contextIsolation: true,
      sandbox: true,
      preload: Paths.preloadJs,
    },
  })
  if (position.isFullScreen) {
    window.setFullScreen(true)
  }

  if (position.isMaximized) {
    window.maximize()
  }
  persistWindowPosition(window)

  if (isTesting()) {
    /**
     * These register global (per-message-type) IPC handlers, so they must only
     * be registered once even though createWindow can now run multiple times.
     * Tests only ever drive a single window, so binding them to the first
     * window created is correct.
     */
    if (!testMessageHandlersRegistered) {
      testMessageHandlersRegistered = true
      handleTestMessage(MessageType.SpellCheckerLanguages, () => window.webContents.session.getSpellCheckerLanguages())
      handleTestMessage(MessageType.SetLocalStorageValue, async (key, value) => {
        await window.webContents.executeJavaScript(`localStorage.setItem("${key}", "${value}")`)
        window.webContents.session.flushStorageData()
      })
      handleTestMessage(MessageType.SignOut, () =>
        window.webContents.executeJavaScript('window.device.onSignOut(false)'),
      )
    }
    window.webContents.once('did-finish-load', () => {
      send(AppMessageType.WindowLoaded)
    })
  }

  return window
}

let testMessageHandlersRegistered = false

async function createWindowServices(
  window: Electron.BrowserWindow,
  appState: AppState,
  appLocale: string,
  onNewWindow?: () => void,
) {
  const packageManager = await initializePackageManager(window.webContents)
  const searchManager = initializeSearchManager(window.webContents)
  initializeZoomManager(window, appState.store)

  const updateManager = setupUpdates(window, appState)
  const trayManager = createTrayManager(window, appState.store)
  const spellcheckerManager = createSpellcheckerManager(appState.store, window.webContents, appLocale)
  const mediaManager = new MediaManager()

  const filesManager = new FilesManager()
  const directoryManager = new DirectoryManager(filesManager)

  const homeServerManager = new HomeServerManager(window.webContents, filesManager)

  if (isTesting()) {
    handleTestMessage(MessageType.SpellCheckerManager, () => spellcheckerManager)
  }

  const menuManager = createMenuManager({
    appState,
    window,
    trayManager,
    store: appState.store,
    spellcheckerManager,
    onNewWindow,
  })

  const fileBackupsManager = new FilesBackupManager(appState, window.webContents, filesManager)

  return {
    updateManager,
    trayManager,
    spellcheckerManager,
    menuManager,
    packageManager,
    searchManager,
    fileBackupsManager,
    mediaManager,
    homeServerManager,
    directoryManager,
  }
}

/**
 * Check file urls for equality by decoding components
 * In packaged app, spaces in navigation events urls can contain %20
 * but not in windowUrl.
 */
function fileUrlsAreEqual(a: string, b: string): boolean {
  /** Catch exceptions in case of malformed urls. */
  try {
    /**
     * Craft URL objects to eliminate production URL values that can
     * contain "#!/" suffixes (on Windows)
     */
    let aPath = new URL(decodeURIComponent(a)).pathname
    let bPath = new URL(decodeURIComponent(b)).pathname
    if (isWindows()) {
      /** On Windows, drive letter casing is inconsistent */
      aPath = lowercaseDriveLetter(aPath)
      bPath = lowercaseDriveLetter(bPath)
    }
    return aPath === bPath
  } catch (error) {
    return false
  }
}

interface WindowPosition {
  bounds: Rectangle
  isMaximized: boolean
  isFullScreen: boolean
}

async function getPreviousWindowPosition() {
  let position: WindowPosition
  try {
    position = JSON.parse(await fs.promises.readFile(path.join(Paths.userDataDir, 'window-position.json'), 'utf8'))
  } catch (e) {
    return {
      bounds: {
        width: WINDOW_DEFAULT_WIDTH,
        height: WINDOW_DEFAULT_HEIGHT,
      },
    }
  }

  const options: Partial<Rectangle> = {}
  const bounds = position.bounds
  if (bounds) {
    /** Validate coordinates. Keep them if the window can fit on a screen */
    const area = screen.getDisplayMatching(bounds).workArea
    if (
      bounds.x >= area.x &&
      bounds.y >= area.y &&
      bounds.x + bounds.width <= area.x + area.width &&
      bounds.y + bounds.height <= area.y + area.height
    ) {
      options.x = bounds.x
      options.y = bounds.y
    }
    if (bounds.width <= area.width || bounds.height <= area.height) {
      options.width = bounds.width
      options.height = bounds.height
    }
  }

  return {
    isMaximized: position.isMaximized,
    isFullScreen: position.isFullScreen,
    bounds: {
      width: WINDOW_DEFAULT_WIDTH,
      height: WINDOW_DEFAULT_HEIGHT,
      ...options,
    },
  }
}

function persistWindowPosition(window: BrowserWindow) {
  let writingToDisk = false

  const saveWindowBounds = debounce(async () => {
    const position: WindowPosition = {
      bounds: window.getNormalBounds(),
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
    }

    if (writingToDisk) {
      return
    }

    writingToDisk = true
    try {
      await fs.promises.writeFile(Paths.windowPositionJson, JSON.stringify(position), 'utf-8')
    } catch (error) {
      console.error('Could not write to window-position.json', error)
    } finally {
      writingToDisk = false
    }
  }, 500)

  window.on('resize', saveWindowBounds)
  window.on('move', saveWindowBounds)
}
