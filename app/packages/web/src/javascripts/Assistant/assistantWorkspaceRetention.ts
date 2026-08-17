/**
 * Bounded, content-free coordination for encrypted Assistant chat workspaces.
 *
 * A lifetime Web Lock proves that another browsing context is no longer using
 * a workspace before its exact encrypted keys are removed. Browsers without
 * Web Locks fail closed to transient (in-memory) chats instead of guessing from
 * timestamps and deleting a suspended tab's data.
 */

export const MAX_RETAINED_ASSISTANT_WORKSPACES_PER_ACCOUNT = 2
export const MAX_ASSISTANT_WORKSPACE_TAB_IDS = 64
export const ASSISTANT_WORKSPACE_RELEASE_WAIT_MS = 2_000
export const ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX = 'assistant-workspace-registry:v1'
export const ASSISTANT_WORKSPACE_RETIRED_KEY_PREFIX = 'assistant-workspace-retired:v1'

const REGISTRY_VERSION = 1
const MAX_ACCOUNT_SCOPE_LENGTH = 192
const MAX_WORKSPACE_SCOPE_LENGTH = 384
const MAX_TAB_ID_LENGTH = 128
const MAX_REGISTRY_ENTRIES = 32
const LOCK_PREFIX = 'standard-red-notes-assistant-workspace:v1'

export type AssistantWorkspaceRegistryEntry = {
  workspaceScope: string
  tabIds: string[]
  lastUsedAt: number
}

type StoredRegistry = {
  version: typeof REGISTRY_VERSION
  entries: AssistantWorkspaceRegistryEntry[]
}

export interface AssistantWorkspaceLocalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type WorkspaceLock = { name?: string }
export interface AssistantWorkspaceLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: WorkspaceLock | null) => T | PromiseLike<T>,
  ): Promise<T>
}

export type AssistantWorkspaceClaim = {
  durable: boolean
  retired: boolean
  trackedTabIds: string[]
  /** Run one encrypted-storage write while this workspace's lifetime lock is held. */
  runPersistence(operation: () => Promise<void>, resourceId?: string): Promise<boolean>
  /** Fence one resource, drain earlier writes, then run its durable cleanup. */
  retirePersistence(resourceId: string, cleanup: () => Promise<void>): Promise<boolean>
  /** Register a mounted panel's final durable checkpoint for workspace release. */
  registerFinalizer(finalizer: () => Promise<void>): () => void
  updateTabIds(tabIds: string[]): Promise<boolean>
  touch(): Promise<boolean>
  release(): Promise<void>
}

export type AssistantWorkspaceCleanup = (entry: AssistantWorkspaceRegistryEntry) => Promise<void>

/**
 * Bound navigation/account transitions without pretending a hung encrypted
 * write was cancelled. Timed-out claims keep their lifetime locks and fences;
 * the next view can continue transiently instead of loading forever.
 */
export async function waitForAssistantWorkspaceReleases(
  releases: Iterable<Promise<unknown>>,
  timeoutMs = ASSISTANT_WORKSPACE_RELEASE_WAIT_MS,
): Promise<boolean> {
  const pending = [...releases]
  if (pending.length === 0) {
    return true
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs))
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

type RetentionOptions = {
  storage?: AssistantWorkspaceLocalStorage
  locks?: AssistantWorkspaceLockManager
  now?: () => number
  maxRetained?: number
}

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })

function validAccountScope(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ACCOUNT_SCOPE_LENGTH && !hasControlCharacters(value)
}

function validWorkspaceScope(accountScope: string, value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_WORKSPACE_SCOPE_LENGTH ||
    hasControlCharacters(value) ||
    !value.startsWith(`${accountScope}:`)
  ) {
    return false
  }
  const suffix = value.slice(accountScope.length + 1)
  return /^(dock|window):[A-Za-z0-9-]{8,128}$/.test(suffix)
}

function normalizeTabIds(tabIds: unknown): string[] {
  if (!Array.isArray(tabIds)) {
    return []
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of tabIds) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_TAB_ID_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(value) ||
      seen.has(value)
    ) {
      continue
    }
    seen.add(value)
    result.push(value)
    if (result.length >= MAX_ASSISTANT_WORKSPACE_TAB_IDS) {
      break
    }
  }
  return result
}

function validateTabIds(tabIds: string[]): string[] | undefined {
  const normalized = normalizeTabIds(tabIds)
  return normalized.length === tabIds.length ? normalized : undefined
}

const registryKey = (accountScope: string) =>
  `${ASSISTANT_WORKSPACE_REGISTRY_KEY_PREFIX}:${encodeURIComponent(accountScope)}`
export const assistantWorkspaceRetiredKey = (workspaceScope: string) =>
  `${ASSISTANT_WORKSPACE_RETIRED_KEY_PREFIX}:${encodeURIComponent(workspaceScope)}`
const registryLockName = (accountScope: string) => `${LOCK_PREFIX}:registry:${encodeURIComponent(accountScope)}`
const lifetimeLockName = (workspaceScope: string) => `${LOCK_PREFIX}:live:${encodeURIComponent(workspaceScope)}`

function unavailableClaim(retired = false): AssistantWorkspaceClaim {
  return {
    durable: false,
    retired,
    trackedTabIds: [],
    runPersistence: async () => false,
    retirePersistence: async () => false,
    registerFinalizer: () => () => undefined,
    updateTabIds: async () => false,
    touch: async () => false,
    release: async () => undefined,
  }
}

export function createAssistantWorkspaceRetention(options: RetentionOptions = {}) {
  const storage = options.storage ?? safeLocalStorage()
  const locks = options.locks ?? safeLockManager()
  const now = options.now ?? Date.now
  const maxRetained = Math.max(
    1,
    Math.min(MAX_REGISTRY_ENTRIES, Math.floor(options.maxRetained ?? MAX_RETAINED_ASSISTANT_WORKSPACES_PER_ACCOUNT)),
  )

  const isRetired = (workspaceScope: string): boolean => {
    if (!storage || workspaceScope.length === 0 || workspaceScope.length > MAX_WORKSPACE_SCOPE_LENGTH) {
      return false
    }
    try {
      return storage.getItem(assistantWorkspaceRetiredKey(workspaceScope)) === '1'
    } catch {
      return false
    }
  }

  const markRetired = (workspaceScope: string): void => {
    if (!storage) {
      throw new Error('Assistant workspace coordination storage is unavailable.')
    }
    storage.setItem(assistantWorkspaceRetiredKey(workspaceScope), '1')
  }

  const readRegistry = (accountScope: string): StoredRegistry | null => {
    if (!storage) {
      return null
    }
    let raw: string | null
    try {
      raw = storage.getItem(registryKey(accountScope))
    } catch {
      return null
    }
    if (!raw) {
      return { version: REGISTRY_VERSION, entries: [] }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredRegistry>
      if (
        parsed.version !== REGISTRY_VERSION ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.length > MAX_REGISTRY_ENTRIES
      ) {
        return null
      }
      const byScope = new Map<string, AssistantWorkspaceRegistryEntry>()
      for (const candidate of parsed.entries) {
        if (
          !candidate ||
          typeof candidate !== 'object' ||
          !validWorkspaceScope(accountScope, candidate.workspaceScope) ||
          !Number.isSafeInteger(candidate.lastUsedAt) ||
          candidate.lastUsedAt < 0 ||
          !Array.isArray(candidate.tabIds)
        ) {
          return null
        }
        const normalizedTabIds = normalizeTabIds(candidate.tabIds)
        if (normalizedTabIds.length !== candidate.tabIds.length) {
          return null
        }
        const entry = {
          workspaceScope: candidate.workspaceScope,
          tabIds: normalizedTabIds,
          lastUsedAt: candidate.lastUsedAt,
        }
        const previous = byScope.get(entry.workspaceScope)
        if (!previous || entry.lastUsedAt >= previous.lastUsedAt) {
          byScope.set(entry.workspaceScope, entry)
        }
      }
      return { version: REGISTRY_VERSION, entries: [...byScope.values()] }
    } catch {
      return null
    }
  }

  const writeRegistry = (accountScope: string, entries: AssistantWorkspaceRegistryEntry[]): void => {
    if (!storage) {
      throw new Error('Assistant workspace coordination storage is unavailable.')
    }
    const bounded = entries
      .slice()
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .slice(0, MAX_REGISTRY_ENTRIES)
    storage.setItem(registryKey(accountScope), JSON.stringify({ version: REGISTRY_VERSION, entries: bounded }))
  }

  const withRegistryLock = <T>(accountScope: string, operation: () => Promise<T>): Promise<T> =>
    locks!.request(registryLockName(accountScope), { mode: 'exclusive' }, async (lock) => {
      if (!lock) {
        throw new Error('Assistant workspace registry lock was not acquired.')
      }
      return operation()
    })

  const acquireLifetimeLock = async (workspaceScope: string) => {
    let releaseLock!: () => void
    let acquiredResolve!: (acquired: boolean) => void
    let acquiredReject!: (error: unknown) => void
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const acquired = new Promise<boolean>((resolve, reject) => {
      acquiredResolve = resolve
      acquiredReject = reject
    })
    const request = locks!.request(
      lifetimeLockName(workspaceScope),
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) {
          acquiredResolve(false)
          return
        }
        acquiredResolve(true)
        await released
      },
    )
    void request.catch(acquiredReject)
    if (!(await acquired)) {
      await request
      throw new Error('Assistant workspace lifetime lock is already held by another context.')
    }
    let releasedOnce = false
    return async () => {
      if (!releasedOnce) {
        releasedOnce = true
        releaseLock()
      }
      await request
    }
  }

  const claimWorkspace = async (
    accountScope: string,
    workspaceScope: string,
    tabIds: string[] | undefined,
    cleanup: AssistantWorkspaceCleanup,
  ): Promise<AssistantWorkspaceClaim> => {
    if (!storage || !locks || !validAccountScope(accountScope) || !validWorkspaceScope(accountScope, workspaceScope)) {
      return unavailableClaim()
    }
    const requestedTabIds = tabIds === undefined ? undefined : validateTabIds(tabIds)
    if (tabIds !== undefined && requestedTabIds === undefined) {
      return unavailableClaim()
    }
    if (isRetired(workspaceScope)) {
      return unavailableClaim(true)
    }

    let releaseLifetime: (() => Promise<void>) | undefined
    try {
      // A reload waits here if a cleaner already owns this exact scope. No
      // persisted tabs/history may be read before this promise resolves.
      releaseLifetime = await acquireLifetimeLock(workspaceScope)
      if (isRetired(workspaceScope)) {
        await releaseLifetime()
        return unavailableClaim(true)
      }

      let initialTrackedTabIds: string[] = []
      const admitted = await withRegistryLock(accountScope, async () => {
        const registry = readRegistry(accountScope)
        if (!registry) {
          return false
        }
        const existing = registry.entries.find((entry) => entry.workspaceScope === workspaceScope)
        if (existing) {
          initialTrackedTabIds = [...existing.tabIds]
          // A restoring view cannot know its tab IDs before the encrypted tab
          // record is read. Preserve the previous cleanup manifest until the
          // caller validates and explicitly replaces it.
          if (tabIds !== undefined) {
            existing.tabIds = requestedTabIds!
          }
          existing.lastUsedAt = now()
          writeRegistry(accountScope, registry.entries)
          return true
        }

        if (registry.entries.length < maxRetained) {
          registry.entries.push({ workspaceScope, tabIds: requestedTabIds ?? [], lastUsedAt: now() })
          writeRegistry(accountScope, registry.entries)
          return true
        }

        const candidates = registry.entries.slice().sort((left, right) => left.lastUsedAt - right.lastUsedAt)
        for (const candidate of candidates) {
          let acquiredCandidate = false
          let cleanupSucceeded = false
          await locks.request(
            lifetimeLockName(candidate.workspaceScope),
            { mode: 'exclusive', ifAvailable: true },
            async (lock) => {
              if (!lock) {
                return
              }
              acquiredCandidate = true
              // This durable, content-free fence is written before any await.
              markRetired(candidate.workspaceScope)
              try {
                await cleanup({ ...candidate, tabIds: [...candidate.tabIds] })
                // No writer can race this removal: the candidate lifetime lock
                // is still held, and release waits for every registered write.
                storage.removeItem(assistantWorkspaceRetiredKey(candidate.workspaceScope))
                cleanupSucceeded = true
              } catch {
                // Keep both the registry entry and retirement fence so cleanup
                // is retried and a delayed writer cannot resurrect content.
              }
            },
          )
          if (acquiredCandidate && !cleanupSucceeded) {
            return false
          }
          if (cleanupSucceeded) {
            const remaining = registry.entries.filter((entry) => entry.workspaceScope !== candidate.workspaceScope)
            remaining.push({ workspaceScope, tabIds: requestedTabIds ?? [], lastUsedAt: now() })
            writeRegistry(accountScope, remaining)
            return true
          }
        }
        return false
      })

      if (!admitted) {
        await releaseLifetime()
        return unavailableClaim()
      }

      let released = false
      let releaseStarted = false
      let releasePromise: Promise<void> | undefined
      let acceptingPersistence = true
      const pendingPersistence = new Set<Promise<unknown>>()
      const retiredResources = new Set<string>()
      let persistenceTail = Promise.resolve()
      const finalizers = new Set<() => Promise<void>>()

      const enqueuePersistence = <T>(operation: () => Promise<T>): Promise<T> => {
        const pending = persistenceTail.then(operation)
        persistenceTail = pending.then(
          () => undefined,
          () => undefined,
        )
        pendingPersistence.add(pending)
        void pending.finally(() => pendingPersistence.delete(pending)).catch(() => undefined)
        return pending
      }

      const runPersistence = async (operation: () => Promise<void>, resourceId?: string): Promise<boolean> => {
        if (
          !acceptingPersistence ||
          released ||
          isRetired(workspaceScope) ||
          (resourceId !== undefined && retiredResources.has(resourceId))
        ) {
          return false
        }
        return enqueuePersistence(async () => {
          if (
            !acceptingPersistence ||
            isRetired(workspaceScope) ||
            (resourceId !== undefined && retiredResources.has(resourceId))
          ) {
            return false
          }
          await operation()
          return true
        })
      }

      const retirePersistence = async (resourceId: string, cleanup: () => Promise<void>): Promise<boolean> => {
        if (
          !resourceId ||
          releaseStarted ||
          released ||
          isRetired(workspaceScope) ||
          retiredResources.has(resourceId)
        ) {
          return false
        }
        retiredResources.add(resourceId)
        try {
          return await enqueuePersistence(async () => {
            if (!acceptingPersistence || isRetired(workspaceScope)) {
              return false
            }
            await cleanup()
            return true
          })
        } catch {
          return false
        }
      }

      const update = async (nextTabIds?: string[]) => {
        if (released || releaseStarted || isRetired(workspaceScope)) {
          return false
        }
        try {
          return await withRegistryLock(accountScope, async () => {
            const registry = readRegistry(accountScope)
            const entry = registry?.entries.find((candidate) => candidate.workspaceScope === workspaceScope)
            if (!registry || !entry) {
              return false
            }
            if (nextTabIds) {
              const validated = validateTabIds(nextTabIds)
              if (!validated) {
                return false
              }
              entry.tabIds = validated
            }
            entry.lastUsedAt = now()
            writeRegistry(accountScope, registry.entries)
            return true
          })
        } catch {
          return false
        }
      }

      return {
        durable: true,
        retired: false,
        trackedTabIds: initialTrackedTabIds,
        runPersistence,
        retirePersistence,
        registerFinalizer: (finalizer) => {
          if (releaseStarted || released) {
            return () => undefined
          }
          finalizers.add(finalizer)
          return () => finalizers.delete(finalizer)
        },
        updateTabIds: (nextTabIds) => update(nextTabIds),
        touch: () => update(),
        release: () => {
          if (releasePromise) {
            return releasePromise
          }
          releaseStarted = true
          releasePromise = (async () => {
            // The parent can begin releasing before React commits descendant
            // cleanups. Invoke the already-registered panel finalizers instead
            // of relying on scheduler timing, then drain their writes.
            await Promise.allSettled([...finalizers].map((finalize) => finalize()))
            finalizers.clear()
            while (pendingPersistence.size > 0) {
              await Promise.allSettled([...pendingPersistence])
            }
            acceptingPersistence = false
            await Promise.allSettled([...pendingPersistence])
            released = true
            await releaseLifetime!()
          })()
          return releasePromise
        },
      }
    } catch {
      await releaseLifetime?.().catch(() => undefined)
      return unavailableClaim(isRetired(workspaceScope))
    }
  }

  return { claimWorkspace, isRetired }
}

function safeLocalStorage(): AssistantWorkspaceLocalStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function safeLockManager(): AssistantWorkspaceLockManager | undefined {
  try {
    return typeof navigator === 'undefined'
      ? undefined
      : (navigator.locks as unknown as AssistantWorkspaceLockManager | undefined)
  } catch {
    return undefined
  }
}

export const assistantWorkspaceRetention = createAssistantWorkspaceRetention()
