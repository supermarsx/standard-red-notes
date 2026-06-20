import { App, Shell, Event } from 'electron'
import { AppState } from './AppState'
import { createExtensionsServer } from './javascripts/Main/ExtensionsServer'
import { Keychain } from './javascripts/Main/Keychain/Keychain'
import { StoreKeys } from './javascripts/Main/Store/StoreKeys'
import { AppName, initializeStrings } from './javascripts/Main/Strings'
import { isLinux, isMac, isWindows } from './javascripts/Main/Types/Platforms'
import { isDev } from './javascripts/Main/Utils/Utils'
import { createWindowState, WindowState } from './javascripts/Main/Window'

const deepLinkScheme = 'standardnotes'

export function initializeApplication(args: { app: Electron.App; ipcMain: Electron.IpcMain; shell: Shell }): void {
  const { app } = args

  app.name = AppName

  const state = new AppState(app)

  void setupDeepLinking(app)

  registerSingleInstanceHandler(app, state)

  registerAppEventListeners({
    ...args,
    state,
  })

  if (isDev()) {
    /** Expose the app's state as a global variable. Useful for debugging */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global as any).appState = state

    setTimeout(() => {
      state.windowState?.window.webContents.openDevTools()
    }, 500)
  }
}

function focusWindow(appState: AppState) {
  const window = appState.windowState?.window

  if (window) {
    if (!window.isVisible()) {
      window.show()
    }
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()
  }
}

/**
 * Creates an additional app window loading the same renderer entry. Used both
 * for the initial window and for the "New Window" menu command. Each window is
 * an independent renderer/snjs instance; they coordinate via server sync (see
 * notifyOtherWindowsOfChange in Window.ts), not shared local state.
 */
export async function openNewWindow(args: { app: App; shell: Shell; state: AppState }): Promise<WindowState> {
  const { app, shell, state } = args

  const windowState = await createWindowState({
    shell,
    appState: state,
    appLocale: app.getLocale(),
    teardown() {
      /**
       * `teardown` runs on window 'closed'. The Window module already removed
       * this window from state.windows and reassigned state.windowState; nothing
       * further is required here, but the hook is kept for parity/extension.
       */
    },
    onNewWindow() {
      void openNewWindow(args)
    },
  })

  await windowState.window.loadURL(state.startUrl)

  return windowState
}

function registerSingleInstanceHandler(app: Electron.App, appState: AppState) {
  app.on('second-instance', (_event: Event, argv: string[], _workingDirectory: string, _additionalData: unknown) => {
    if (isWindows()) {
      appState.deepLinkUrl = argv.find((arg) => arg.startsWith(deepLinkScheme))
    }

    /* Someone tried to run a second instance, we should focus our window. */
    focusWindow(appState)
  })
}

function registerAppEventListeners(args: {
  app: Electron.App
  ipcMain: Electron.IpcMain
  shell: Shell
  state: AppState
}) {
  const { app, state } = args

  app.on('window-all-closed', () => {
    /**
     * Only quit once every window is gone. On macOS the app conventionally
     * stays alive with no windows. On other platforms, closing the last window
     * quits (modulo minimize-to-tray, which preventDefaults the close so the
     * window never reaches 'closed'/'window-all-closed').
     */
    if (!isMac()) {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    state.willQuitApp = true
  })

  app.on('activate', () => {
    /**
     * macOS: clicking the dock icon. If any windows exist, surface the active
     * one; if none remain (all were closed), open a fresh window.
     */
    if (state.windows.size === 0) {
      void openNewWindow({ app: args.app, shell: args.shell, state })
      return
    }

    const windowState = state.windowState ?? state.windows.values().next().value
    windowState?.window.show()
  })

  app.on('open-url', (_event, url) => {
    state.deepLinkUrl = url
    focusWindow(state)
  })

  app.on('ready', () => {
    if (!state.isPrimaryInstance) {
      console.warn('Quiting app and focusing existing instance.')
      app.quit()
      return
    }

    void finishApplicationInitialization(args)
  })
}

async function setupDeepLinking(app: Electron.App) {
  if (!app.isDefaultProtocolClient(deepLinkScheme)) {
    app.setAsDefaultProtocolClient(deepLinkScheme)
  }
}

async function finishApplicationInitialization({ app, shell, state }: { app: App; shell: Shell; state: AppState }) {
  const keychainWindow = await Keychain.ensureKeychainAccess(state.store)

  initializeStrings(app.getLocale())

  const windowState = await createWindowState({
    shell,
    appState: state,
    appLocale: app.getLocale(),
    teardown() {
      /**
       * Window tracking (removal from state.windows and reassignment of the
       * active state.windowState) is handled by the Window module's 'closed'
       * handler, so nothing is needed here for the first window either.
       */
    },
    onNewWindow() {
      void openNewWindow({ app, shell, state })
    },
  })

  if (state.isRunningVersionForFirstTime()) {
    await windowState.window.webContents.session.clearCache()
  }

  const host = createExtensionsServer()
  state.store.set(StoreKeys.ExtServerHost, host)

  /**
   * Close the keychain window after the main window is created, otherwise the
   * app will quit automatically
   */
  keychainWindow?.close()

  if ((isWindows() || isLinux()) && windowState.trayManager.shouldMinimizeToTray()) {
    windowState.trayManager.createTrayIcon()
  }

  void windowState.window.loadURL(state.startUrl)
}
