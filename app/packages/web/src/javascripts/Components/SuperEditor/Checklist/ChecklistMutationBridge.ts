import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from '../../TodoAggregate/superChecklistDocument'

export type ChecklistBridgeMutation = {
  target: SuperChecklistTodoTarget
  patch: SuperChecklistTodoPatch
}

export type ChecklistBridgeMutationResult =
  | { status: 'updated'; todoId?: string; changed?: boolean }
  | { status: 'rejected'; reason: string; retainOwner?: boolean; retryAcquire?: boolean }

type ChecklistBridgeHandler = (
  mutation: ChecklistBridgeMutation,
) => ChecklistBridgeMutationResult | Promise<ChecklistBridgeMutationResult>

export type ChecklistEditorRole = 'interactive' | 'detached'

type BridgeEntry = {
  token: object
  handler: ChecklistBridgeHandler
  isReady: () => boolean
  role: ChecklistEditorRole
  isActive: () => boolean
}

type DurabilityEntry = {
  token: object
  flush: () => Promise<void>
  isReady: () => boolean
}

type EntriesByLease<Entry> = Map<string, Entry>
type EntriesByNote<Entry> = Map<string, EntriesByLease<Entry>>

const activeBridges = new WeakMap<object, EntriesByNote<BridgeEntry>>()
const bridgeListeners = new WeakMap<object, Set<() => void>>()
const durabilityFlushers = new WeakMap<object, EntriesByNote<DurabilityEntry>>()
const READINESS_RECHECK_MS = 100

function notifyBridgeListeners(application: object): void {
  for (const listener of bridgeListeners.get(application) ?? []) {
    listener()
  }
}

function getOrCreateLeaseEntries<Entry>(
  registry: WeakMap<object, EntriesByNote<Entry>>,
  application: object,
  noteUuid: string,
): EntriesByLease<Entry> {
  let byNote = registry.get(application)
  if (!byNote) {
    byNote = new Map()
    registry.set(application, byNote)
  }
  let byLease = byNote.get(noteUuid)
  if (!byLease) {
    byLease = new Map()
    byNote.set(noteUuid, byLease)
  }
  return byLease
}

function removeExactEntry<Entry>(
  registry: WeakMap<object, EntriesByNote<Entry>>,
  application: object,
  noteUuid: string,
  leaseId: string,
  expected: Entry,
): void {
  const byNote = registry.get(application)
  const byLease = byNote?.get(noteUuid)
  if (byLease?.get(leaseId) !== expected) {
    return
  }
  byLease.delete(leaseId)
  if (byLease.size === 0) {
    byNote?.delete(noteUuid)
  }
  if (byNote?.size === 0) {
    registry.delete(application)
  }
}

function bridgeEntry(application: object, noteUuid: string, leaseId: string): BridgeEntry | undefined {
  return activeBridges.get(application)?.get(noteUuid)?.get(leaseId)
}

function durabilityEntry(application: object, noteUuid: string, leaseId: string): DurabilityEntry | undefined {
  return durabilityFlushers.get(application)?.get(noteUuid)?.get(leaseId)
}

/** Register one exact committed editor lifetime. Stale cleanup is token-safe. */
export function registerChecklistMutationBridge(
  application: object,
  noteUuid: string,
  leaseId: string,
  handler: ChecklistBridgeHandler,
  isReady: () => boolean = () => true,
  options: { role?: ChecklistEditorRole; isActive?: () => boolean } = {},
): () => void {
  const entry = {
    token: {},
    handler,
    isReady,
    role: options.role ?? 'interactive',
    isActive: options.isActive ?? (() => true),
  }
  getOrCreateLeaseEntries(activeBridges, application, noteUuid).set(leaseId, entry)
  notifyBridgeListeners(application)

  return () => {
    removeExactEntry(activeBridges, application, noteUuid, leaseId, entry)
    notifyBridgeListeners(application)
  }
}

export function revokeChecklistMutationBridge(application: object, noteUuid: string, leaseId: string): void {
  const bridge = bridgeEntry(application, noteUuid, leaseId)
  if (bridge) {
    removeExactEntry(activeBridges, application, noteUuid, leaseId, bridge)
  }
  const durability = durabilityEntry(application, noteUuid, leaseId)
  if (durability) {
    removeExactEntry(durabilityFlushers, application, noteUuid, leaseId, durability)
  }
  notifyBridgeListeners(application)
}

export function getReadyActiveChecklistMutationLease(
  application: object,
  noteUuid: string,
  role: ChecklistEditorRole,
): string | undefined {
  const entries = activeBridges.get(application)?.get(noteUuid)
  if (!entries) {
    return undefined
  }
  const active = [...entries.entries()].filter(([, entry]) => {
    if (entry.role !== role) {
      return false
    }
    try {
      return entry.isActive()
    } catch {
      return false
    }
  })
  if (active.length !== 1) {
    return undefined
  }
  const [leaseId, entry] = active[0]
  try {
    return entry.isReady() ? leaseId : undefined
  } catch {
    return undefined
  }
}

export function waitForReadyActiveChecklistMutationLease(
  application: object,
  noteUuid: string,
  options: { role: ChecklistEditorRole; timeoutMs: number; signal?: AbortSignal },
): Promise<string | undefined> {
  const current = getReadyActiveChecklistMutationLease(application, noteUuid, options.role)
  if (current || options.signal?.aborted || options.timeoutMs <= 0) {
    return Promise.resolve(current)
  }
  return new Promise((resolve) => {
    let settled = false
    let dispose: () => void = () => undefined
    const finish = (leaseId?: string) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      clearInterval(recheck)
      dispose()
      options.signal?.removeEventListener('abort', handleAbort)
      resolve(leaseId)
    }
    const inspect = () => {
      const leaseId = getReadyActiveChecklistMutationLease(application, noteUuid, options.role)
      if (leaseId) {
        finish(leaseId)
      }
    }
    const handleAbort = () => finish()
    const timeout = setTimeout(() => finish(), options.timeoutMs)
    const recheck = setInterval(inspect, Math.min(READINESS_RECHECK_MS, options.timeoutMs))
    dispose = subscribeChecklistMutationBridges(application, inspect)
    options.signal?.addEventListener('abort', handleAbort, { once: true })
    inspect()
  })
}

export function mutateThroughActiveChecklistBridge(
  application: object,
  noteUuid: string,
  leaseId: string,
  mutation: ChecklistBridgeMutation,
): Promise<ChecklistBridgeMutationResult> | undefined {
  const entry = bridgeEntry(application, noteUuid, leaseId)
  if (!entry) {
    return undefined
  }
  try {
    if (!entry.isActive() || !entry.isReady()) {
      return Promise.resolve({
        status: 'rejected',
        reason: 'The source note editor is no longer the active mutation owner.',
        retryAcquire: true,
      })
    }
    return Promise.resolve(entry.handler(mutation)).then((result) => {
      const current = bridgeEntry(application, noteUuid, leaseId)
      if (result.status === 'updated' && (current?.token !== entry.token || !entry.isActive())) {
        return {
          status: 'rejected' as const,
          reason: 'The source note editor changed while the update was being saved.',
          retryAcquire: true,
        }
      }
      return result
    })
  } catch (error) {
    return Promise.reject(error)
  }
}

export function hasActiveChecklistMutationBridge(application: object, noteUuid: string, leaseId: string): boolean {
  const entry = bridgeEntry(application, noteUuid, leaseId)
  if (!entry) {
    return false
  }
  try {
    return entry.isActive() && entry.isReady()
  } catch {
    return false
  }
}

/**
 * The controller strict flush owns both local persistence and the exact provider
 * acknowledgement. Call it once, then recheck only authorization/active ownership;
 * a transport disconnect after an acknowledged flush must not create a false failure.
 */
export async function persistChecklistMutationExactlyOnce(
  persistChanges: () => Promise<void>,
  isStillAuthorizedAndActive: () => boolean,
): Promise<boolean> {
  await persistChanges()
  return isStillAuthorizedAndActive()
}

export function notifyChecklistMutationBridgeReadiness(application: object): void {
  notifyBridgeListeners(application)
}

export function subscribeChecklistMutationBridges(application: object, listener: () => void): () => void {
  let listeners = bridgeListeners.get(application)
  if (!listeners) {
    listeners = new Set()
    bridgeListeners.set(application, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = bridgeListeners.get(application)
    current?.delete(listener)
    if (current?.size === 0) {
      bridgeListeners.delete(application)
    }
  }
}

export function waitForActiveChecklistMutationBridge(
  application: object,
  noteUuid: string,
  options: { leaseId: string; timeoutMs: number; signal?: AbortSignal },
): Promise<boolean> {
  const { leaseId } = options
  if (hasActiveChecklistMutationBridge(application, noteUuid, leaseId)) {
    return Promise.resolve(true)
  }
  if (options.signal?.aborted || options.timeoutMs <= 0) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    let settled = false
    let dispose: () => void = () => undefined
    const finish = (ready: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      clearInterval(readinessRecheck)
      dispose()
      options.signal?.removeEventListener('abort', handleAbort)
      resolve(ready)
    }
    const handleAbort = () => finish(false)
    const timeout = setTimeout(() => finish(false), options.timeoutMs)
    const readinessRecheck = setInterval(
      () => {
        if (hasActiveChecklistMutationBridge(application, noteUuid, leaseId)) {
          finish(true)
        }
      },
      Math.min(READINESS_RECHECK_MS, options.timeoutMs),
    )
    dispose = subscribeChecklistMutationBridges(application, () => {
      if (hasActiveChecklistMutationBridge(application, noteUuid, leaseId)) {
        finish(true)
      }
    })
    options.signal?.addEventListener('abort', handleAbort, { once: true })
    if (hasActiveChecklistMutationBridge(application, noteUuid, leaseId)) {
      finish(true)
    }
  })
}

export function registerChecklistMutationDurabilityFlusher(
  application: object,
  noteUuid: string,
  leaseId: string,
  flush: () => Promise<void>,
  isReady: () => boolean = () => true,
): () => void {
  const entry = { token: {}, flush, isReady }
  getOrCreateLeaseEntries(durabilityFlushers, application, noteUuid).set(leaseId, entry)
  notifyBridgeListeners(application)
  return () => {
    removeExactEntry(durabilityFlushers, application, noteUuid, leaseId, entry)
    notifyBridgeListeners(application)
  }
}

export function isChecklistMutationDurabilityReady(application: object, noteUuid: string, leaseId: string): boolean {
  const entry = durabilityEntry(application, noteUuid, leaseId)
  // Solo/local editors have no relay provider and are immediately durable.
  if (!entry) {
    return true
  }
  try {
    return entry.isReady()
  } catch {
    return false
  }
}

export async function flushChecklistMutationDurability(
  application: object,
  noteUuid: string,
  leaseId: string,
): Promise<void> {
  const entry = durabilityEntry(application, noteUuid, leaseId)
  if (!entry) {
    return
  }
  if (!isChecklistMutationDurabilityReady(application, noteUuid, leaseId)) {
    throw new Error('Checklist collaboration provider is not mutation-ready.')
  }
  await entry.flush()
  if (
    durabilityEntry(application, noteUuid, leaseId)?.token !== entry.token ||
    !isChecklistMutationDurabilityReady(application, noteUuid, leaseId)
  ) {
    throw new Error('Checklist collaboration provider changed before the update was flushed.')
  }
}
