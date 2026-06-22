import { compareVersions } from 'compare-versions'
import { autoUpdater, BrowserWindow, dialog, Notification, shell } from 'electron'
import electronLog from 'electron-log'
import https from 'https'
import { updateElectronApp, UpdateSourceType } from 'update-electron-app'
import { action, computed, makeObservable, observable } from 'mobx'
import { MessageType } from '../../../test/TestIpcMessage'
import { AppState } from '../../AppState'
import { MessageToWebApp } from '../Shared/IpcMessages'
import { StoreKeys } from './Store/StoreKeys'
import { updates as str } from './Strings'
import {
  autoUpdatingAvailable,
  UpdateRepo,
  UpdateRepoLatestReleaseApiUrl,
  UpdateRepoReleasesUrl,
} from './Types/Constants'
import { handleTestMessage } from './Utils/Testing'
import { isTesting } from './Utils/Utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logError(...message: any) {
  console.error('updateManager:', ...message)
}

if (isTesting()) {
  // eslint-disable-next-line no-var
  var notifiedStateUpdate = false
}

/**
 * Poll interval for the lightweight "notify me about updates" check. Kept
 * deliberately slow (a few hours) so we don't hammer the GitHub API. A check
 * also runs once on launch.
 */
const UPDATE_NOTIFY_INTERVAL_MS = 1000 * 60 * 60 * 4 // 4 hours

/**
 * Normalize a GitHub release tag (which can carry a `v` prefix or, for the
 * monorepo, a scoped `@scope/pkg@x.y.z` form) down to a comparable semver-ish
 * version string. Returns null when no version could be extracted.
 */
export function parseVersionFromTag(tag: string | null | undefined): string | null {
  if (!tag) {
    return null
  }
  // Grab the last `x.y.z`(.w...) sequence in the tag.
  const match = tag.match(/(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)\s*$/)
  if (match) {
    return match[1]
  }
  // Fall back to stripping a leading `v`.
  const stripped = tag.replace(/^v/i, '').trim()
  return stripped.length > 0 ? stripped : null
}

/**
 * Pure, testable helper: is `remoteVersion` strictly newer than
 * `currentVersion`? Returns false on any unparseable/invalid input so callers
 * never alert or update on garbage.
 */
export function isRemoteVersionNewer(currentVersion: string, remoteTagOrVersion: string | null | undefined): boolean {
  const remote = parseVersionFromTag(remoteTagOrVersion)
  const current = parseVersionFromTag(currentVersion)
  if (!remote || !current) {
    return false
  }
  try {
    return compareVersions(remote, current) === 1
  } catch (_error) {
    return false
  }
}

/**
 * Fetch the latest release tag from the fork's public GitHub releases. No token
 * required. Resolves to null on any failure (offline, rate-limited, etc.) so
 * callers degrade gracefully without crashing.
 */
export function fetchLatestReleaseTag(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const request = https.get(
        UpdateRepoLatestReleaseApiUrl,
        {
          headers: {
            'User-Agent': `${UpdateRepo.repo}-desktop`,
            Accept: 'application/vnd.github+json',
          },
          timeout: 15000,
        },
        (response) => {
          if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) {
            response.resume()
            resolve(null)
            return
          }
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () => {
            try {
              const parsed = JSON.parse(body)
              const tag = typeof parsed?.tag_name === 'string' ? parsed.tag_name : null
              resolve(tag)
            } catch (_error) {
              resolve(null)
            }
          })
        },
      )
      request.on('error', () => resolve(null))
      request.on('timeout', () => {
        request.destroy()
        resolve(null)
      })
    } catch (_error) {
      resolve(null)
    }
  })
}

export class UpdateState {
  latestVersion: string | null = null
  enableAutoUpdate: boolean
  notifyUpdates: boolean
  checkingForUpdate = false
  autoUpdateDownloaded = false
  lastCheck: Date | null = null

  constructor(private appState: AppState) {
    this.enableAutoUpdate = autoUpdatingAvailable && appState.store.get(StoreKeys.EnableAutoUpdate)
    this.notifyUpdates = appState.store.get(StoreKeys.NotifyUpdates)
    makeObservable(this, {
      latestVersion: observable,
      enableAutoUpdate: observable,
      notifyUpdates: observable,
      checkingForUpdate: observable,
      autoUpdateDownloaded: observable,
      lastCheck: observable,

      updateNeeded: computed,

      toggleAutoUpdate: action,
      toggleNotifyUpdates: action,
      setCheckingForUpdate: action,
      autoUpdateHasBeenDownloaded: action,
      checkedForUpdate: action,
    })

    if (isTesting()) {
      handleTestMessage(MessageType.UpdateState, () => ({
        lastCheck: this.lastCheck,
      }))
    }
  }

  get updateNeeded(): boolean {
    if (this.latestVersion) {
      return isRemoteVersionNewer(this.appState.version, this.latestVersion)
    } else {
      return false
    }
  }

  toggleAutoUpdate(): void {
    this.enableAutoUpdate = !this.enableAutoUpdate
    this.appState.store.set(StoreKeys.EnableAutoUpdate, this.enableAutoUpdate)
    // The background updater (update.electronjs.org via Squirrel) is wired once
    // at launch when enabled; a mid-session toggle takes effect on next launch.
  }

  toggleNotifyUpdates(): void {
    this.notifyUpdates = !this.notifyUpdates
    this.appState.store.set(StoreKeys.NotifyUpdates, this.notifyUpdates)
  }

  setCheckingForUpdate(checking: boolean): void {
    this.checkingForUpdate = checking
  }

  autoUpdateHasBeenDownloaded(version: string | null): void {
    this.autoUpdateDownloaded = true
    this.latestVersion = version
  }

  checkedForUpdate(latestVersion: string | null): void {
    this.lastCheck = new Date()
    this.latestVersion = latestVersion
  }
}

let updatesSetup = false

export function setupUpdates(window: BrowserWindow, appState: AppState): void {
  if (!autoUpdatingAvailable) {
    return
  }
  if (updatesSetup) {
    throw Error('Already set up updates.')
  }
  const { store } = appState
  const updateState = appState.updates

  /**
   * When Squirrel (macOS/Windows) finishes pulling an update in the background,
   * surface it through our existing UI + the web app instead of letting
   * update-electron-app pop its own dialog (we pass notifyUser:false below).
   * `releaseName` carries the version/tag, which we normalize for display.
   */
  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName) => {
    window.webContents.send(MessageToWebApp.UpdateAvailable, null)
    updateState.autoUpdateHasBeenDownloaded(parseVersionFromTag(releaseName))
  })
  autoUpdater.on('error', logError)

  /**
   * Background auto-update via update.electronjs.org. SAFETY: only started when
   * the user has explicitly opted in (defaults off). This service serves macOS
   * and Windows (Squirrel) only — Linux is not covered and relies on the
   * cross-platform notify poll below. It throws on an unpackaged/unsigned app
   * (e.g. local dev), so we swallow that to degrade gracefully.
   */
  if (updateState.enableAutoUpdate) {
    try {
      updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: `${UpdateRepo.owner}/${UpdateRepo.repo}`,
        },
        updateInterval: '4 hours',
        logger: electronLog,
        notifyUser: false,
      })
    } catch (error) {
      logError('Failed to start background auto-update', error)
    }
  }

  updatesSetup = true

  if (isTesting()) {
    handleTestMessage(MessageType.AutoUpdateEnabled, () => store.get(StoreKeys.EnableAutoUpdate))
    handleTestMessage(MessageType.CheckForUpdate, () => checkForUpdate(appState, updateState))
    // eslint-disable-next-line block-scoped-var
    handleTestMessage(MessageType.UpdateManagerNotifiedStateChange, () => notifiedStateUpdate)
  } else {
    // Auto-update check (only acts when enabled).
    void checkForUpdate(appState, updateState)
    // Lightweight notify-only poll (independent of auto-update), on launch and
    // then on a slow interval.
    void checkForUpdateNotification(appState, updateState)
    setInterval(() => {
      void checkForUpdateNotification(appState, updateState)
    }, UPDATE_NOTIFY_INTERVAL_MS)
  }
}

let lastNotifiedVersion: string | null = null

function maybeNotifyUpdateAvailable(state: UpdateState, version: string): void {
  // Avoid re-notifying for the same version within a session.
  if (lastNotifiedVersion === version) {
    return
  }
  lastNotifiedVersion = version
  state.checkedForUpdate(version)

  if (!Notification.isSupported()) {
    return
  }

  try {
    const notification = new Notification({
      title: str().updateNotification.title,
      body: str().updateNotification.body(version),
    })
    notification.on('click', () => {
      openChangelog(state)
    })
    notification.show()
  } catch (error) {
    logError('Failed to show update notification', error)
  }
}

/**
 * Notify-only check: hits the fork's GitHub releases API directly and, if a
 * newer version exists and the user opted into notifications, shows a
 * non-intrusive system notification. Independent of auto-update; never
 * downloads or installs anything. Fails quietly when offline.
 */
export async function checkForUpdateNotification(appState: AppState, state: UpdateState): Promise<void> {
  if (!state.notifyUpdates) {
    return
  }

  const tag = await fetchLatestReleaseTag()
  if (!tag) {
    // Offline / failed lookup: degrade quietly.
    return
  }

  const version = parseVersionFromTag(tag)
  state.checkedForUpdate(version)

  if (version && isRemoteVersionNewer(appState.version, version)) {
    maybeNotifyUpdateAvailable(state, version)
  }
}

export function openChangelog(state: UpdateState): void {
  const url = UpdateRepoReleasesUrl
  const latestVersion = state.latestVersion
  if (latestVersion) {
    void shell.openExternal(`${url}/tag/v${latestVersion}`)
  } else {
    void shell.openExternal(url)
  }
}

function quitAndInstall(window: BrowserWindow) {
  setTimeout(() => {
    // index.js prevents close event on some platforms
    window.removeAllListeners('close')
    window.close()
    autoUpdater.quitAndInstall()
  }, 0)
}

export async function showUpdateInstallationDialog(parentWindow: BrowserWindow, appState: AppState): Promise<void> {
  if (!appState.updates.latestVersion) {
    return
  }

  const result = await dialog.showMessageBox(parentWindow, {
    type: 'info',
    title: str().updateReady.title,
    message: str().updateReady.message(appState.updates.latestVersion),
    buttons: [str().updateReady.installLater, str().updateReady.quitAndInstall],
    cancelId: 0,
  })

  const buttonIndex = result.response
  if (buttonIndex === 1) {
    quitAndInstall(parentWindow)
  }
}

export async function checkForUpdate(appState: AppState, state: UpdateState, userTriggered = false): Promise<void> {
  if (!autoUpdatingAvailable) {
    return
  }

  if (!state.enableAutoUpdate && !userTriggered) {
    return
  }

  state.setCheckingForUpdate(true)

  try {
    // The actual download/install runs in the background via update.electronjs.org
    // (macOS/Windows). A check — automatic or user-triggered — resolves the
    // latest published version from the fork's GitHub releases, which also works
    // on Linux where the update service does not serve binaries.
    const tag = await fetchLatestReleaseTag()
    const version = parseVersionFromTag(tag)
    state.checkedForUpdate(version)

    if (userTriggered) {
      const message =
        state.updateNeeded && state.latestVersion
          ? str().finishedChecking.updateAvailable(state.latestVersion)
          : str().finishedChecking.noUpdateAvailable(appState.version)

      void dialog.showMessageBox({
        title: str().finishedChecking.title,
        message,
      })
    }
  } catch (error) {
    if (userTriggered) {
      void dialog.showMessageBox({
        title: str().finishedChecking.title,
        message: str().finishedChecking.error(JSON.stringify(error)),
      })
    }
  } finally {
    state.setCheckingForUpdate(false)
  }
}
