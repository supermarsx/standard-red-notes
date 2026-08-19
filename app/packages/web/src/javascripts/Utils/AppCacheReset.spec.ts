/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: the SAFETY BOUNDARY of the "reload and clear cached
 * files" control.
 *
 * The failure this guards against is not a stale asset — it is a well-meaning
 * "clear everything" that also wipes IndexedDB/localStorage and so destroys
 * unsynced notes and signs the user out. These tests pin both halves:
 *   (1) only `srn-shell-*` Cache Storage entries are deleted, everything else
 *       in Cache Storage is left alone;
 *   (2) no user-data storage API is touched at all — indexedDB, localStorage
 *       and sessionStorage are booby-trapped and must record zero accesses.
 */
import { clearApplicationShellCaches, reloadApplicationClearingCaches, SHELL_CACHE_PREFIX } from './AppCacheReset'

type FakeCacheStorage = CacheStorage & { deleted: string[] }

const makeCaches = (keys: string[]): FakeCacheStorage => {
  const deleted: string[] = []
  let remaining = [...keys]

  return {
    deleted,
    keys: async () => [...remaining],
    delete: async (key: string) => {
      if (!remaining.includes(key)) {
        return false
      }
      deleted.push(key)
      remaining = remaining.filter((existing) => existing !== key)
      return true
    },
  } as unknown as FakeCacheStorage
}

const makeServiceWorker = (registrationCount: number) => {
  const unregistered: number[] = []

  const registrations = Array.from({ length: registrationCount }, (_, index) => ({
    unregister: async () => {
      unregistered.push(index)
      return true
    },
  }))

  return {
    container: {
      getRegistrations: async () => registrations,
    } as unknown as ServiceWorkerContainer,
    unregistered,
  }
}

/**
 * Replace the user-data storage globals with accessors that record any touch.
 * Reading the property at all is a failure: there is no legitimate reason for
 * this module to look at them.
 */
const trapUserDataStorage = () => {
  const accesses: string[] = []
  const originals: Array<[string, PropertyDescriptor | undefined]> = []

  for (const name of ['indexedDB', 'localStorage', 'sessionStorage']) {
    originals.push([name, Object.getOwnPropertyDescriptor(globalThis, name)])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        accesses.push(name)
        return undefined
      },
    })
  }

  const restore = () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        delete (globalThis as unknown as Record<string, unknown>)[name]
      }
    }
  }

  return { accesses, restore }
}

describe('AppCacheReset', () => {
  it('deletes only the service worker shell caches and preserves every other cache', async () => {
    const caches = makeCaches([
      'srn-shell-3.201.28-1785432284632',
      'srn-shell-3.201.28-1786376589647',
      'some-third-party-cache',
      'srn-user-files-do-not-touch',
      'workbox-precache-v2',
    ])

    const result = await clearApplicationShellCaches({ caches })

    expect(result.deletedCaches).toEqual(['srn-shell-3.201.28-1785432284632', 'srn-shell-3.201.28-1786376589647'])
    expect(result.preservedCaches).toEqual([
      'some-third-party-cache',
      'srn-user-files-do-not-touch',
      'workbox-precache-v2',
    ])
    expect(caches.deleted).toEqual(result.deletedCaches)
    // The remaining keys are the ones we promised to keep.
    await expect(caches.keys()).resolves.toEqual([
      'some-third-party-cache',
      'srn-user-files-do-not-touch',
      'workbox-precache-v2',
    ])
  })

  it('never reads indexedDB, localStorage or sessionStorage', async () => {
    const { accesses, restore } = trapUserDataStorage()

    try {
      const caches = makeCaches(['srn-shell-1', 'items-backup'])
      const { container } = makeServiceWorker(1)

      await reloadApplicationClearingCaches({ caches, serviceWorker: container }, () => undefined)

      expect(accesses).toEqual([])
    } finally {
      restore()
    }
  })

  it('unregisters service workers before purging, then reloads exactly once', async () => {
    const order: string[] = []
    const { container, unregistered } = makeServiceWorker(2)
    const base = makeCaches(['srn-shell-1'])
    const caches = {
      keys: async () => {
        order.push('keys')
        return base.keys()
      },
      delete: async (key: string) => {
        order.push(`delete:${key}`)
        return base.delete(key)
      },
    } as unknown as CacheStorage

    const wrappedContainer = {
      getRegistrations: async () => {
        order.push('getRegistrations')
        return container.getRegistrations()
      },
    } as unknown as ServiceWorkerContainer

    let reloads = 0
    const result = await reloadApplicationClearingCaches({ caches, serviceWorker: wrappedContainer }, () => {
      order.push('reload')
      reloads += 1
    })

    expect(order).toEqual(['getRegistrations', 'keys', 'delete:srn-shell-1', 'reload'])
    expect(unregistered).toHaveLength(2)
    expect(result.unregisteredWorkers).toBe(2)
    expect(reloads).toBe(1)
  })

  it('degrades quietly where Cache Storage or service workers are unavailable', async () => {
    const result = await clearApplicationShellCaches({ caches: undefined, serviceWorker: undefined })

    expect(result).toEqual({ deletedCaches: [], preservedCaches: [], unregisteredWorkers: 0 })
  })

  it('keeps counting a cache as preserved when its deletion fails', async () => {
    const caches = {
      keys: async () => ['srn-shell-1'],
      delete: async () => {
        throw new Error('locked')
      },
    } as unknown as CacheStorage

    const result = await clearApplicationShellCaches({ caches })

    expect(result.deletedCaches).toEqual([])
  })

  it('pins the prefix the service worker actually writes', () => {
    expect(SHELL_CACHE_PREFIX).toBe('srn-shell-')
  })
})
