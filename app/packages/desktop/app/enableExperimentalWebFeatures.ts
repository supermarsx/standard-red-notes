import { Session } from 'electron'

/**
 * File System Access API permissions (replaces the old experimental-features fix).
 *
 * HISTORY: Electron <30 had a bug (https://github.com/electron/electron/issues/28422)
 * where downloading a file via the File System Access API failed with
 * "The request is not allowed by the user agent or the platform in the current
 * context." The previous workaround was the process-wide command-line switch
 * `enable-experimental-web-platform-features`, which globally granted ALL
 * requested permissions and enabled every experimental Chromium web feature.
 *
 * That bug was fixed upstream by https://github.com/electron/electron/pull/41419
 * (native File System API support brokered through the session permission
 * handlers), shipped in Electron 30+. This app runs Electron 42, so the
 * process-wide experimental switch is no longer needed and has been removed.
 *
 * In its place we install SCOPED session permission handlers that approve only
 * the specific permissions THIS app actually uses and deny everything else by
 * default. This is strictly tighter than the old global flag (which both
 * granted every permission and turned on every experimental Chromium feature).
 *
 * The renderer only ever loads our own trusted, locally-bundled app from a
 * file:// origin (remote/web-embed content lives in CSP-sandboxed sub-frames),
 * so granting these specific requests to the app is safe.
 *
 * Allowlisted permissions and why each is needed:
 *  - fileSystem    File System Access API downloads/exports (showSaveFilePicker,
 *                  showDirectoryPicker, createWritable) -- the original fix.
 *  - media         getUserMedia for the "Moments" camera/microphone feature and
 *                  audio/video recorders.
 *  - notifications Reminder notifications (notificationService).
 *  - clipboard-read / clipboard-sanitized-write
 *                  navigator.clipboard read/write used by the editor + copy UI.
 *
 * Any permission not in this set (geolocation, midi, usb, serial, hid,
 * openExternal, pointerLock, etc.) is denied.
 */

/** Permissions the desktop renderer is allowed to use. */
const ALLOWED_PERMISSIONS = new Set([
  'fileSystem',
  'media',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
])

export function configureFileSystemAccessPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })

  session.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission)
  })
}
