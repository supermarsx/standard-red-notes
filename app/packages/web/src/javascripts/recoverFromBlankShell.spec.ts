/** @jest-environment jsdom */

/**
 * The blank-page recovery moved out of index.html's inline bootstrap `<script>`
 * and into `app.js`, because the inline script is the one the CSP pins by
 * sha256 — so a pin that no longer authorises the served document blocked the
 * recovery along with the bootstrap, in exactly the situation the recovery
 * exists for.
 *
 * What jsdom can check is the behaviour and the wiring: it fires only on a
 * blank root, once per tab, through the existing
 * `reloadApplicationClearingCaches` (which unregisters the worker before
 * purging, unlike the inline version), and it is no longer in the pinned
 * script. That it still runs WITH THE INLINE SCRIPT BLOCKED is a browser fact,
 * proved in headless Chrome under a real refusing CSP — see
 * `mctr-recovery-proof.mjs` and the report; jsdom has no CSP at all.
 */
import {
  BLANK_SHELL_GRACE_MS,
  BLANK_SHELL_RECOVERY_KEY,
  claimRecoveryAttempt,
  installBlankShellRecovery,
  recoverBlankShellIfNeeded,
  type BlankShellRecoveryOptions,
  shellMountedContent,
} from './recoverFromBlankShell'
import { ElementIds } from './Constants/ElementIDs'
import { SHELL_CACHE_PREFIX, type AppCacheResetEnvironment } from './Utils/AppCacheReset'

const reload = jest.fn()
let deletedCaches: string[]
let unregistered: number
let environment: {
  caches: { keys: () => Promise<string[]>; delete: (key: string) => Promise<boolean> }
  serviceWorker: { getRegistrations: () => Promise<{ unregister: () => Promise<boolean> }[]> }
}

/** A root that mounted content, or one that did not. */
const seedRoot = (childCount: number): void => {
  document.body.innerHTML = ''
  const root = document.createElement('div')
  root.id = ElementIds.RootId
  for (let index = 0; index < childCount; index++) {
    root.appendChild(document.createElement('span'))
  }
  document.body.appendChild(root)
}

beforeEach(() => {
  reload.mockClear()
  deletedCaches = []
  unregistered = 0
  storage = makeStorage()
  document.body.innerHTML = ''
  environment = {
    caches: {
      keys: async () => [`${SHELL_CACHE_PREFIX}v1`, `${SHELL_CACHE_PREFIX}v2`, 'some-other-cache'],
      delete: async (key: string) => {
        deletedCaches.push(key)
        return true
      },
    },
    serviceWorker: {
      getRegistrations: async () => [
        {
          unregister: async () => {
            unregistered += 1
            return true
          },
        },
      ],
    },
  }
})

/**
 * A storage of this test's own, fresh per test.
 *
 * This module arms the recovery as a LOAD-TIME SIDE EFFECT, which is the whole
 * point of it — `app.js` runs it and nothing has to call it. So importing the
 * module registers a listener against the real `document` and the real
 * `sessionStorage`, and dispatching `load` here fires that one too. Sharing
 * `sessionStorage` with it means whichever listener runs first claims the single
 * per-tab attempt and the other silently declines: correct behaviour, useless
 * test. (It cost one red run to notice.)
 */
const makeStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

let storage: Pick<Storage, 'getItem' | 'setItem'>

const options = (): BlankShellRecoveryOptions => ({
  storage,
  environment: environment as unknown as AppCacheResetEnvironment,
  reload,
})

describe('the blank-shell recovery decides on the rendered root', () => {
  it('does nothing when the application mounted content', async () => {
    seedRoot(3)
    expect(shellMountedContent()).toBe(true)
    expect(await recoverBlankShellIfNeeded(options())).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(deletedCaches).toEqual([])
    expect(unregistered).toBe(0)
    // And it must not burn the one attempt on a healthy load.
    expect(storage.getItem(BLANK_SHELL_RECOVERY_KEY)).toBeNull()
  })

  it('evicts every shell cache and reloads when the root is empty', async () => {
    seedRoot(0)
    expect(shellMountedContent()).toBe(false)
    expect(await recoverBlankShellIfNeeded(options())).toBe(true)
    // Every shell cache, whatever build wrote it — and nothing that is not ours.
    expect(deletedCaches.sort()).toEqual([`${SHELL_CACHE_PREFIX}v1`, `${SHELL_CACHE_PREFIX}v2`])
    expect(deletedCaches).not.toContain('some-other-cache')
    expect(unregistered).toBe(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('also fires when the root element is missing entirely', async () => {
    // The application never got far enough to render its own container.
    expect(await recoverBlankShellIfNeeded(options())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('recovers once per tab, so a genuinely broken page cannot reload forever', async () => {
    seedRoot(0)
    expect(await recoverBlankShellIfNeeded(options())).toBe(true)
    expect(storage.getItem(BLANK_SHELL_RECOVERY_KEY)).toBe('1')

    reload.mockClear()
    deletedCaches = []
    // The reload lands on the same blank shell: the second attempt must stop.
    expect(await recoverBlankShellIfNeeded(options())).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(deletedCaches).toEqual([])
  })

  it('reloads even when the eviction throws, rather than leaving a blank page', async () => {
    seedRoot(0)
    environment.caches.keys = async () => {
      throw new Error('site data blocked')
    }
    expect(await recoverBlankShellIfNeeded(options())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('treats storage that throws as "not yet attempted", so it still recovers', () => {
    const throwing = {
      getItem: () => {
        throw new Error('storage blocked')
      },
      setItem: () => {
        throw new Error('storage blocked')
      },
    }
    expect(claimRecoveryAttempt(throwing)).toBe(true)
    // And a browser with no sessionStorage at all.
    expect(claimRecoveryAttempt(undefined)).toBe(true)
  })

  it('arms on `load` and waits out the grace period, not before', async () => {
    jest.useFakeTimers()
    try {
      seedRoot(0)
      installBlankShellRecovery(options())
      window.dispatchEvent(new Event('load'))
      // `...Async` rather than counting `await Promise.resolve()` turns: the
      // eviction awaits getRegistrations, unregister, keys and a Promise.all of
      // deletes, and a fixed number of microtask flushes is a test that passes
      // or fails on how many `await`s the implementation happens to have.
      await jest.advanceTimersByTimeAsync(BLANK_SHELL_GRACE_MS - 1)
      expect(reload).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('where the recovery is wired, which is the point of the move', () => {
  const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs')
  const { join } = jest.requireActual<typeof import('node:path')>('node:path')
  const webRoot = join(__dirname, '..', '..')

  it('is no longer in the CSP-pinned inline script', () => {
    const indexHtml = readFileSync(join(webRoot, 'src', 'index.html'), 'utf8')
    const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? ''
    expect(inlineScript).not.toBe('')
    // The bootstrap itself must STAY inline: the container entrypoint templates
    // these from env at start, which it can only do in the document.
    expect(inlineScript).toContain('window.defaultSyncServer')
    // The recovery must not be.
    expect(inlineScript).not.toContain(BLANK_SHELL_RECOVERY_KEY)
    expect(inlineScript).not.toContain(SHELL_CACHE_PREFIX)
    expect(inlineScript).not.toContain('getRegistrations')
  })

  it('is imported for its side effect BEFORE the application evaluates', () => {
    // ES module imports evaluate in order before the importing module's body,
    // so this ordering is what arms the listener even if App's own evaluation
    // throws — one of the ways the page ends up blank.
    const entry = readFileSync(join(webRoot, 'src', 'javascripts', 'index.ts'), 'utf8')
    // Anchored to the start of a line, because the comment above the import
    // QUOTES `import './App'` — an unanchored indexOf finds the prose first and
    // reports the wrong order. (It did, on the first run of this test.)
    const recoveryAt = entry.search(/^import '\.\/recoverFromBlankShell'$/m)
    const appAt = entry.search(/^import '\.\/App'$/m)
    expect(recoveryAt).toBeGreaterThan(-1)
    expect(appAt).toBeGreaterThan(-1)
    expect(recoveryAt).toBeLessThan(appAt)
  })

  it('reuses the existing eviction rather than carrying a second copy', () => {
    const source = readFileSync(join(webRoot, 'src', 'javascripts', 'recoverFromBlankShell.ts'), 'utf8')
    expect(source).toContain('reloadApplicationClearingCaches')
    // No second implementation of the cache sweep or the unregister loop.
    expect(source).not.toContain('caches.delete')
    expect(source).not.toContain('getRegistrations')
  })
})
