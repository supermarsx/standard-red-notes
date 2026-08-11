import {
  flushChecklistMutationDurability,
  getReadyActiveChecklistMutationLease,
  hasActiveChecklistMutationBridge,
  mutateThroughActiveChecklistBridge,
  notifyChecklistMutationBridgeReadiness,
  persistChecklistMutationExactlyOnce,
  registerChecklistMutationBridge,
  registerChecklistMutationDurabilityFlusher,
  waitForActiveChecklistMutationBridge,
  waitForReadyActiveChecklistMutationLease,
} from './ChecklistMutationBridge'

const mutation = {
  target: { todoId: 'todo-a', locator: '0.0', text: 'A', checked: false },
  patch: { checked: true },
}

describe('exact checklist mutation bridge lifetimes', () => {
  it('routes only to the exact application, note and lease owner', async () => {
    const application = {}
    const handler = jest.fn(() => ({ status: 'updated' as const, todoId: 'todo-a' }))
    const dispose = registerChecklistMutationBridge(application, 'note-a', 'lease-a', handler)

    expect(mutateThroughActiveChecklistBridge(application, 'note-b', 'lease-a', mutation)).toBeUndefined()
    expect(mutateThroughActiveChecklistBridge(application, 'note-a', 'lease-b', mutation)).toBeUndefined()
    await expect(mutateThroughActiveChecklistBridge(application, 'note-a', 'lease-a', mutation)).resolves.toEqual({
      status: 'updated',
      todoId: 'todo-a',
    })
    dispose()
    expect(hasActiveChecklistMutationBridge(application, 'note-a', 'lease-a')).toBe(false)
  })

  it('keeps a newer registration when stale cleanup runs for the same lease', async () => {
    const application = {}
    const oldHandler = jest.fn(() => ({ status: 'rejected' as const, reason: 'stale' }))
    const newHandler = jest.fn(() => ({ status: 'updated' as const, todoId: 'todo-new' }))
    const disposeOld = registerChecklistMutationBridge(application, 'same-note', 'same-lease', oldHandler)
    const disposeNew = registerChecklistMutationBridge(application, 'same-note', 'same-lease', newHandler)

    disposeOld()
    await expect(
      mutateThroughActiveChecklistBridge(application, 'same-note', 'same-lease', mutation),
    ).resolves.toMatchObject({ todoId: 'todo-new' })
    expect(oldHandler).not.toHaveBeenCalled()
    disposeNew()
  })

  it('routes only the unique active visible lifetime and fails closed on active ambiguity', async () => {
    const application = {}
    const inactive = registerChecklistMutationBridge(
      application,
      'note',
      'visible-inactive',
      () => ({ status: 'updated' }),
      () => true,
      { role: 'interactive', isActive: () => false },
    )
    const active = registerChecklistMutationBridge(
      application,
      'note',
      'visible-active',
      () => ({ status: 'updated' }),
      () => true,
      { role: 'interactive', isActive: () => true },
    )
    expect(getReadyActiveChecklistMutationLease(application, 'note', 'interactive')).toBe('visible-active')

    const ambiguous = registerChecklistMutationBridge(
      application,
      'note',
      'visible-also-active',
      () => ({ status: 'updated' }),
      () => true,
      { role: 'interactive', isActive: () => true },
    )
    expect(getReadyActiveChecklistMutationLease(application, 'note', 'interactive')).toBeUndefined()
    ambiguous()
    await expect(
      waitForReadyActiveChecklistMutationLease(application, 'note', {
        role: 'interactive',
        timeoutMs: 100,
      }),
    ).resolves.toBe('visible-active')
    active()
    inactive()
  })

  it('aborts a claimed visible lease if pane focus changes before mutation dispatch', async () => {
    const application = {}
    let active = true
    const handler = jest.fn(() => ({ status: 'updated' as const }))
    registerChecklistMutationBridge(application, 'note', 'visible', handler, () => true, {
      role: 'interactive',
      isActive: () => active,
    })
    expect(getReadyActiveChecklistMutationLease(application, 'note', 'interactive')).toBe('visible')

    active = false
    await expect(mutateThroughActiveChecklistBridge(application, 'note', 'visible', mutation)).resolves.toEqual({
      status: 'rejected',
      reason: 'The source note editor is no longer the active mutation owner.',
      retryAcquire: true,
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not report success through a lease that became inactive while saving', async () => {
    const application = {}
    let active = true
    let finish!: () => void
    const saving = new Promise<void>((resolve) => {
      finish = resolve
    })
    registerChecklistMutationBridge(
      application,
      'note',
      'visible',
      async () => {
        await saving
        return { status: 'updated' }
      },
      () => true,
      { role: 'interactive', isActive: () => active },
    )

    const result = mutateThroughActiveChecklistBridge(application, 'note', 'visible', mutation)
    active = false
    finish()
    await expect(result).resolves.toEqual({
      status: 'rejected',
      reason: 'The source note editor changed while the update was being saved.',
      retryAcquire: true,
    })
  })

  it('waits for exact canonical readiness and supports bounded abort', async () => {
    const application = {}
    let ready = false
    registerChecklistMutationBridge(
      application,
      'note',
      'lease',
      () => ({ status: 'updated' }),
      () => ready,
    )

    let settled = false
    const wait = waitForActiveChecklistMutationBridge(application, 'note', {
      leaseId: 'lease',
      timeoutMs: 1_000,
    }).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    ready = true
    notifyChecklistMutationBridgeReadiness(application)
    await expect(wait).resolves.toBe(true)

    const controller = new AbortController()
    const aborted = waitForActiveChecklistMutationBridge(application, 'missing', {
      leaseId: 'missing',
      timeoutMs: 1_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(aborted).resolves.toBe(false)
  })

  it('awaits the exact provider flush and rejects a disconnected readiness window', async () => {
    const application = {}
    let ready = true
    let resolveFlush!: () => void
    const flush = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = resolve
        }),
    )
    registerChecklistMutationDurabilityFlusher(application, 'note', 'lease', flush, () => ready)

    let settled = false
    const pending = flushChecklistMutationDurability(application, 'note', 'lease').then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    resolveFlush()
    await pending

    ready = false
    await expect(flushChecklistMutationDurability(application, 'note', 'lease')).rejects.toThrow('not mutation-ready')
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('owns local then provider persistence exactly once without re-failing after acknowledgement', async () => {
    const localSave = jest.fn().mockResolvedValue(undefined)
    let providerReady = true
    const providerFlush = jest.fn(async () => {
      providerReady = false
    })
    const controllerStrictPersistence = async () => {
      await localSave()
      await providerFlush()
    }

    await expect(persistChecklistMutationExactlyOnce(controllerStrictPersistence, () => true)).resolves.toBe(true)
    expect(localSave).toHaveBeenCalledTimes(1)
    expect(providerFlush).toHaveBeenCalledTimes(1)
    expect(providerReady).toBe(false)
  })
})
