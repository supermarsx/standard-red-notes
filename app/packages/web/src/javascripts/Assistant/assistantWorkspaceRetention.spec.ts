import {
  ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX,
  ASSISTANT_WORKSPACE_RETIRED_KEY_PREFIX,
  AssistantWorkspaceLocalStorage,
  AssistantWorkspaceLockManager,
  MAX_ASSISTANT_WORKSPACE_TAB_IDS,
  createAssistantWorkspaceRetention,
  waitForAssistantWorkspaceReleases,
} from './assistantWorkspaceRetention'

class MemoryStorage implements AssistantWorkspaceLocalStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

class DeterministicLocks implements AssistantWorkspaceLockManager {
  private held = new Set<string>()
  private queues = new Map<
    string,
    Array<{
      callback: (lock: { name: string } | null) => unknown
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
    }>
  >()

  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: { name?: string } | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (options.ifAvailable && this.held.has(name)) {
      return Promise.resolve(callback(null))
    }
    return new Promise<T>((resolve, reject) => {
      const queued = {
        callback: callback as (lock: { name: string } | null) => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      if (this.held.has(name)) {
        const queue = this.queues.get(name) ?? []
        queue.push(queued)
        this.queues.set(name, queue)
      } else {
        this.run(name, queued)
      }
    })
  }

  private run(
    name: string,
    request: {
      callback: (lock: { name: string }) => unknown
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
    },
  ) {
    this.held.add(name)
    Promise.resolve()
      .then(() => request.callback({ name }))
      .then(request.resolve, request.reject)
      .finally(() => {
        this.held.delete(name)
        const queue = this.queues.get(name)
        const next = queue?.shift()
        if (queue?.length === 0) {
          this.queues.delete(name)
        }
        if (next) {
          this.run(name, next as Parameters<DeterministicLocks['run']>[1])
        }
      })
  }
}

const scope = (account: string, context: string, surface = 'dock') => `${account}:${surface}:${context}`
const cleanup = async () => undefined

describe('assistant workspace retention', () => {
  it('bounds release waiting while leaving a hung finalizer isolated', async () => {
    jest.useFakeTimers()
    try {
      const neverSettles = new Promise<void>(() => undefined)
      const wait = waitForAssistantWorkspaceReleases([neverSettles], 50)
      jest.advanceTimersByTime(50)
      await expect(wait).resolves.toBe(false)
      await expect(waitForAssistantWorkspaceReleases([Promise.resolve()], 50)).resolves.toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps two live workspaces durable and makes an extra live context transient', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 2 })
    const first = await retention.claimWorkspace('account-a', scope('account-a', 'context-0001'), ['tab-a'], cleanup)
    const second = await retention.claimWorkspace('account-a', scope('account-a', 'context-0002'), ['tab-b'], cleanup)
    const thirdCleanup = jest.fn(cleanup)
    const third = await retention.claimWorkspace(
      'account-a',
      scope('account-a', 'context-0003'),
      ['tab-c'],
      thirdCleanup,
    )

    expect(first.durable).toBe(true)
    expect(second.durable).toBe(true)
    expect(third).toMatchObject({ durable: false, retired: false })
    expect(thirdCleanup).not.toHaveBeenCalled()
    await Promise.all([first.release(), second.release()])
  })

  it('retires a released LRU before strict cleanup and admits the replacement only after cleanup', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    let clock = 1
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 2, now: () => clock++ })
    const firstScope = scope('account-a', 'context-0001')
    const first = await retention.claimWorkspace('account-a', firstScope, ['tab-a'], cleanup)
    await first.release()
    const second = await retention.claimWorkspace('account-a', scope('account-a', 'context-0002'), ['tab-b'], cleanup)

    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const strictCleanup = jest.fn(async () => {
      expect(retention.isRetired(firstScope)).toBe(true)
      await cleanupGate
    })
    let settled = false
    const replacementPromise = retention
      .claimWorkspace('account-a', scope('account-a', 'context-0003'), ['tab-c'], strictCleanup)
      .then((claim) => {
        settled = true
        return claim
      })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(strictCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceScope: firstScope, tabIds: ['tab-a'] }),
    )
    expect(settled).toBe(false)

    releaseCleanup()
    const replacement = await replacementPromise
    expect(replacement.durable).toBe(true)
    expect(retention.isRetired(firstScope)).toBe(false)
    await Promise.all([second.release(), replacement.release()])
  })

  it('does not accumulate retirement markers across successful evictions and permits a later reclaim', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 1 })
    const scopes = Array.from({ length: 12 }, (_, index) =>
      scope('account-a', `context-${String(index).padStart(4, '0')}`),
    )

    for (const [index, workspaceScope] of scopes.entries()) {
      const claim = await retention.claimWorkspace('account-a', workspaceScope, [`tab-${index}`], cleanup)
      expect(claim.durable).toBe(true)
      await claim.release()
    }

    expect(
      [...storage.values.keys()].filter((key) => key.startsWith(ASSISTANT_WORKSPACE_RETIRED_KEY_PREFIX)),
    ).toHaveLength(0)
    const reclaimed = await retention.claimWorkspace('account-a', scopes[0], ['tab-reclaimed'], cleanup)
    expect(reclaimed.durable).toBe(true)
    await reclaimed.release()
  })

  it('fails immediately instead of waiting forever when the same workspace is live elsewhere', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 2 })
    const workspaceScope = scope('account-a', 'context-0001')
    const first = await retention.claimWorkspace('account-a', workspaceScope, ['tab-a'], cleanup)
    const collision = await retention.claimWorkspace('account-a', workspaceScope, ['tab-b'], cleanup)

    expect(first.durable).toBe(true)
    expect(collision.durable).toBe(false)
    await first.release()
  })

  it('runs mounted-panel finalizers and keeps the lifetime lock until their persistence settles', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 1 })
    const workspaceScope = scope('account-a', 'context-0001')
    const claim = await retention.claimWorkspace('account-a', workspaceScope, ['tab-a'], cleanup)
    let finishWrite!: () => void
    const write = new Promise<void>((resolve) => {
      finishWrite = resolve
    })

    let registered!: Promise<boolean>
    claim.registerFinalizer(async () => {
      registered = claim.runPersistence(() => write)
      await registered
    })

    let released = false
    const release = claim.release().then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(released).toBe(false)

    finishWrite()
    expect(await registered).toBe(true)
    await release
    expect(released).toBe(true)
  })

  it('keeps the dead entry tracked and the newcomer transient when durable cleanup fails', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 1 })
    const oldScope = scope('account-a', 'context-0001')
    const old = await retention.claimWorkspace('account-a', oldScope, ['tab-a'], cleanup)
    await old.release()
    const failedCleanup = jest.fn(async () => {
      throw new Error('disk removal failed')
    })

    const newcomer = await retention.claimWorkspace(
      'account-a',
      scope('account-a', 'context-0002'),
      ['tab-b'],
      failedCleanup,
    )
    expect(newcomer.durable).toBe(false)
    expect(retention.isRetired(oldScope)).toBe(true)
    const registry = [...storage.values.entries()].find(([key]) =>
      key.startsWith(ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX),
    )
    expect(registry?.[1]).toContain(oldScope)
    expect(registry?.[1]).not.toContain('context-0002')
  })

  it('fails closed on malformed registry data', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    storage.setItem(`${ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX}:${encodeURIComponent('account-a')}`, '{broken')
    const retention = createAssistantWorkspaceRetention({ storage, locks })
    const claim = await retention.claimWorkspace('account-a', scope('account-a', 'context-0001'), ['tab-a'], cleanup)
    expect(claim.durable).toBe(false)
    expect(storage.getItem(`${ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX}:${encodeURIComponent('account-a')}`)).toBe(
      '{broken',
    )
  })

  it('fails closed without Web Locks and never writes a registry', async () => {
    const storage = new MemoryStorage()
    const retention = createAssistantWorkspaceRetention({ storage, locks: undefined })
    const claim = await retention.claimWorkspace('account-a', scope('account-a', 'context-0001'), ['tab-a'], cleanup)
    expect(claim.durable).toBe(false)
    expect(storage.values.size).toBe(0)
  })

  it('isolates account registries and stores only bounded content-free metadata', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 1 })
    const tabIds = Array.from({ length: MAX_ASSISTANT_WORKSPACE_TAB_IDS }, (_, index) => `tab-${index}`)
    const accountA = await retention.claimWorkspace('account-a', scope('account-a', 'context-0001'), tabIds, cleanup)
    const accountB = await retention.claimWorkspace(
      'account-b',
      scope('account-b', 'context-0001'),
      ['tab-private'],
      cleanup,
    )

    expect(accountA.durable).toBe(true)
    expect(accountB.durable).toBe(true)
    const serialized = [...storage.values.entries()]
      .filter(([key]) => key.startsWith(ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX))
      .map(([, value]) => value)
      .join('\n')
    expect(
      (JSON.parse([...storage.values.values()][0]) as { entries: [{ tabIds: string[] }] }).entries[0].tabIds,
    ).toHaveLength(MAX_ASSISTANT_WORKSPACE_TAB_IDS)
    expect(serialized).not.toContain('title')
    expect(serialized).not.toContain('message')
    expect(
      [...storage.values.keys()].filter((key) => key.startsWith(ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX)),
    ).toHaveLength(2)
    await Promise.all([accountA.release(), accountB.release()])
  })

  it('rejects an overflowing cleanup manifest without changing the durable registry', async () => {
    const storage = new MemoryStorage()
    const locks = new DeterministicLocks()
    const retention = createAssistantWorkspaceRetention({ storage, locks, maxRetained: 1 })
    const workspaceScope = scope('account-a', 'context-0001')
    const claim = await retention.claimWorkspace('account-a', workspaceScope, ['tab-original'], cleanup)
    const before = [...storage.values.values()][0]
    const overflowing = Array.from({ length: MAX_ASSISTANT_WORKSPACE_TAB_IDS + 1 }, (_, index) => `tab-${index}`)

    expect(await claim.updateTabIds(overflowing)).toBe(false)
    expect([...storage.values.values()][0]).toBe(before)
    await claim.release()

    const rejected = await retention.claimWorkspace('account-a', workspaceScope, overflowing, cleanup)
    expect(rejected.durable).toBe(false)
  })
})
