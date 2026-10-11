import { ElementIds } from './Constants/ElementIDs'
import { reloadApplicationClearingCaches, type AppCacheResetEnvironment } from './Utils/AppCacheReset'
import { reloadPage } from './Components/ComponentErrorBoundary/reloadPage'

/**
 * Standard Red Notes — bug fix: the blank-page recovery used to live inside the
 * inline bootstrap `<script>` in index.html, which is the one script the app's
 * Content-Security-Policy pins by sha256. So in the situation it exists for most
 * urgently — a pin that no longer authorises the served document — the recovery
 * was refused along with the script it lived in, and the only mechanism that can
 * evict a poisoned app shell from inside the page could not run.
 *
 * Observed on a live deployment: the served CSP pinned
 * `sha256-xID6fEWgsorVtRLS9JyZ4UM2VxGeHC8bfPA0i0IYNaM=` while the browser's
 * digest of the served script was
 * `yv4R3vTpb7KN7vGWFNuIPiKgZBQ2ZGuccBvDiUDHPZs=`, so the bootstrap never ran,
 * `window.defaultSyncServer` was `undefined`, sync had no host — and the
 * recovery that would have fixed it was blocked too. The mechanism that gets a
 * page into that state is documented in service-worker.js:52-59: a previous
 * release's cached shell served under this release's per-deploy pin.
 *
 * `app.js` carries it instead. `<script src="./app.js">` is authorised by
 * `script-src 'self'` with no hash at all, so it runs whether or not the inline
 * pin matches. That removes a dependency on the pin rather than adding one.
 *
 * WHAT NO LONGER REACHES IT. `service-worker.js` serves the app bundle
 * network-first, so a stale cached `app.js` is only served when the network is
 * unreachable — a case a reload cannot fix either. The one shape this gives up
 * is a cached `app.js` from a release PREDATING this module, for the single
 * deploy that introduces it: the inline copy covered that, and nothing can,
 * from inside a bundle that does not contain the code.
 *
 * ORDERING. The inline version registered its `load` listener before `app.js`
 * was even fetched. This module is imported for its side effect ABOVE
 * `import './App'` in index.ts, and ES module imports evaluate in order before
 * the importing module's body, so the listener is armed before the application
 * evaluates — and stays armed if that evaluation throws, which is one of the
 * ways the page ends up blank.
 *
 * The eviction itself is `reloadApplicationClearingCaches`, which already
 * existed as this path's twin and is better than what was inline: it
 * unregisters the worker BEFORE purging the caches, so the still-controlling
 * worker cannot re-populate a cache that was just emptied. The inline version
 * did both at once.
 */

/** How long after `load` the React root is given to mount something. */
export const BLANK_SHELL_GRACE_MS = 10_000

/**
 * One attempt per tab. Without it a page that is genuinely broken — rather than
 * merely served a stale shell — reloads forever.
 */
export const BLANK_SHELL_RECOVERY_KEY = 'srn-blank-recovery'

/** Did the application mount anything at all? */
export function shellMountedContent(doc: Pick<Document, 'getElementById'> = document): boolean {
  const root = doc.getElementById(ElementIds.RootId)
  return Boolean(root && root.childElementCount > 0)
}

/**
 * `true` the first time it is called in a tab, `false` afterwards.
 *
 * Storage can throw (a private window, blocked site data), and a recovery that
 * refused to run because it could not RECORD the attempt would be worse than
 * one that may run twice, so a throw is read as "not yet attempted".
 */
export function claimRecoveryAttempt(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): boolean {
  if (!storage) {
    return true
  }
  try {
    if (storage.getItem(BLANK_SHELL_RECOVERY_KEY)) {
      return false
    }
    storage.setItem(BLANK_SHELL_RECOVERY_KEY, '1')
  } catch {
    return true
  }
  return true
}

export type BlankShellRecoveryOptions = {
  doc?: Pick<Document, 'getElementById'>
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  environment?: AppCacheResetEnvironment
  reload?: () => void
}

/**
 * Evict the shell and reload, if the root is empty and this tab has not already
 * tried. Reloads even when the eviction fails: landing on the same poisoned
 * shell is no worse than the blank page already on screen, and the attempt is
 * recorded either way so it happens once.
 */
export async function recoverBlankShellIfNeeded(options: BlankShellRecoveryOptions = {}): Promise<boolean> {
  const doc = options.doc ?? document
  const storage = options.storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)
  const reload = options.reload ?? (() => reloadPage())

  if (shellMountedContent(doc)) {
    return false
  }
  if (!claimRecoveryAttempt(storage)) {
    return false
  }
  try {
    await reloadApplicationClearingCaches(options.environment, reload)
  } catch {
    reload()
  }
  return true
}

/**
 * Arm the recovery. Exported so a spec can drive it without relying on this
 * module's load-time side effect; the call at the bottom is what the bundle
 * runs.
 */
export function installBlankShellRecovery(options: BlankShellRecoveryOptions = {}): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }
  window.addEventListener('load', () => {
    window.setTimeout(() => {
      void recoverBlankShellIfNeeded(options)
    }, BLANK_SHELL_GRACE_MS)
  })
}

installBlankShellRecovery()
