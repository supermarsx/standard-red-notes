import {
  AlertService,
  ContentType,
  ItemManagerInterface,
  MutatorClientInterface,
  Result,
  SessionsClientInterface,
  SNNote,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import { NoteSyncController } from './NoteSyncController'

describe('NoteSyncController save cancellation', () => {
  let item: SNNote
  let items: jest.Mocked<ItemManagerInterface>
  let mutator: jest.Mocked<MutatorClientInterface>
  let sessions: jest.Mocked<SessionsClientInterface>
  let sync: jest.Mocked<SyncServiceInterface>
  let alerts: jest.Mocked<AlertService>
  let isNativeMobileWeb: jest.Mocked<IsNativeMobileWeb>
  let controller: NoteSyncController

  beforeEach(() => {
    jest.useFakeTimers()
    item = {
      uuid: 'vault-note',
      text: 'retained vault plaintext',
      key_system_identifier: 'vault-key-system',
    } as SNNote
    items = {
      findItem: jest.fn().mockReturnValue(item),
      getItems: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<ItemManagerInterface>
    mutator = {
      changeItem: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MutatorClientInterface>
    sessions = {
      isSignedOut: jest.fn().mockReturnValue(false),
      isSignedIn: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<SessionsClientInterface>
    sync = {
      sync: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SyncServiceInterface>
    alerts = {
      alert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AlertService>
    isNativeMobileWeb = {
      execute: jest.fn().mockReturnValue(Result.ok(false)),
    } as unknown as jest.Mocked<IsNativeMobileWeb>

    controller = new NoteSyncController(item, items, mutator, sessions, sync, alerts, isNativeMobileWeb)
  })

  afterEach(() => {
    controller.deinit()
    jest.useRealTimers()
  })

  it('settles the actual queued save promise on security teardown without mutation or propagation callback', async () => {
    const onLocalPropagationComplete = jest.fn()
    const save = controller.saveAndAwaitLocalPropagation({
      text: 'must not persist after vault lock',
      onLocalPropagationComplete,
    })

    controller.deinit()

    await expect(save).resolves.toBeUndefined()
    jest.runOnlyPendingTimers()
    await Promise.resolve()

    expect(mutator.changeItem).not.toHaveBeenCalled()
    expect(sync.sync).not.toHaveBeenCalled()
    expect(onLocalPropagationComplete).not.toHaveBeenCalled()
    expect(controller.savingLocallyPromise).toBeNull()
    expect((controller as unknown as { item?: SNNote }).item).toBeUndefined()
  })

  it('settles a superseded debounce without persisting or reporting the stale value', async () => {
    const firstPropagation = jest.fn()
    const secondPropagation = jest.fn()
    const firstSave = controller.saveAndAwaitLocalPropagation({
      text: 'superseded plaintext',
      onLocalPropagationComplete: firstPropagation,
    })
    const secondSave = controller.saveAndAwaitLocalPropagation({
      text: 'current plaintext',
      onLocalPropagationComplete: secondPropagation,
    })

    await expect(firstSave).resolves.toBeUndefined()
    expect(mutator.changeItem).not.toHaveBeenCalled()
    expect(firstPropagation).not.toHaveBeenCalled()

    jest.runOnlyPendingTimers()
    await expect(secondSave).resolves.toBeUndefined()

    expect(mutator.changeItem).toHaveBeenCalledTimes(1)
    expect(secondPropagation).toHaveBeenCalledTimes(1)
    expect(firstPropagation).not.toHaveBeenCalled()
  })

  it('settles an already-started save on teardown and blocks its deferred mutation callback', async () => {
    let deferredMutation: ((mutator: { text: string }) => void) | undefined
    let finishMutation: (() => void) | undefined
    const mutation = new Promise<void>((resolve) => {
      finishMutation = resolve
    })
    ;(mutator.changeItem as jest.Mock).mockImplementation(
      (_item: SNNote, mutate: (noteMutator: { text: string }) => void) => {
        deferredMutation = mutate
        return mutation
      },
    )
    const propagation = jest.fn()
    const save = controller.saveAndAwaitLocalPropagation({
      text: 'must not cross the lock boundary',
      bypassDebouncer: true,
      onLocalPropagationComplete: propagation,
    })

    jest.runOnlyPendingTimers()
    await Promise.resolve()
    expect(mutator.changeItem).toHaveBeenCalledTimes(1)

    controller.deinit()
    await expect(save).resolves.toBeUndefined()

    const lateMutator = { text: 'unchanged' }
    deferredMutation?.(lateMutator)
    finishMutation?.()
    await mutation
    await Promise.resolve()

    expect(lateMutator.text).toBe('unchanged')
    expect(sync.sync).not.toHaveBeenCalled()
    expect(propagation).not.toHaveBeenCalled()
  })

  it('keeps the lifecycle drain pending until every overlapping in-flight save settles', async () => {
    let finishFirstMutation: (() => void) | undefined
    const firstMutation = new Promise<void>((resolve) => {
      finishFirstMutation = resolve
    })
    ;(mutator.changeItem as jest.Mock)
      .mockImplementationOnce((_item: SNNote, mutate: (noteMutator: Record<string, unknown>) => void) => {
        mutate({})
        return firstMutation
      })
      .mockImplementationOnce((_item: SNNote, mutate: (noteMutator: Record<string, unknown>) => void) => {
        mutate({})
        return Promise.resolve(item)
      })

    const firstSave = controller.saveAndAwaitLocalPropagation({ text: 'first', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await Promise.resolve()

    const secondSave = controller.saveAndAwaitLocalPropagation({ text: 'second', bypassDebouncer: true })
    const lifecycleDrain = controller.savingLocallyPromise?.promise
    jest.runOnlyPendingTimers()
    await secondSave

    let drained = false
    void lifecycleDrain?.then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(controller.savingLocallyPromise).not.toBeNull()

    finishFirstMutation?.()
    await firstMutation
    await firstSave
    await lifecycleDrain

    expect(drained).toBe(true)
    expect(controller.savingLocallyPromise).toBeNull()
  })

  it('preserves legacy save resolution while exposing the real rejected mutation to strict durability', async () => {
    const failure = new Error('disk mutation failed')
    mutator.changeItem.mockRejectedValueOnce(failure)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const save = controller.saveAndAwaitLocalPropagation({ text: 'must remain retryable', bypassDebouncer: true })
    jest.runOnlyPendingTimers()

    await expect(save).resolves.toBeUndefined()
    await expect(controller.awaitCurrentLocalPropagationStrict()).rejects.toBe(failure)
    consoleError.mockRestore()
  })
})

describe('NoteSyncController work-preservation on a discovered-gone note (t97)', () => {
  let item: SNNote
  let items: jest.Mocked<ItemManagerInterface>
  let mutator: jest.Mocked<MutatorClientInterface>
  let sessions: jest.Mocked<SessionsClientInterface>
  let sync: jest.Mocked<SyncServiceInterface>
  let alerts: jest.Mocked<AlertService>
  let isNativeMobileWeb: jest.Mocked<IsNativeMobileWeb>
  let controller: NoteSyncController

  beforeEach(() => {
    jest.useFakeTimers()
    item = {
      uuid: 'deleted-note-uuid',
      text: 'text the user was still typing',
      title: 'My Note',
    } as SNNote
    items = {
      // The note has already been discarded from the item store by the time the debounced
      // save fires -- this is the exact condition the guard in undebouncedMutateAndSync checks.
      findItem: jest.fn().mockReturnValue(undefined),
      getItems: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<ItemManagerInterface>
    mutator = {
      changeItem: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MutatorClientInterface>
    sessions = {
      isSignedOut: jest.fn().mockReturnValue(false),
      isSignedIn: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<SessionsClientInterface>
    sync = {
      sync: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SyncServiceInterface>
    alerts = {
      alert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AlertService>
    isNativeMobileWeb = {
      execute: jest.fn().mockReturnValue(Result.ok(false)),
    } as unknown as jest.Mocked<IsNativeMobileWeb>

    controller = new NoteSyncController(item, items, mutator, sessions, sync, alerts, isNativeMobileWeb)
  })

  afterEach(() => {
    controller.deinit()
    jest.useRealTimers()
  })

  it('tells the user the note was deleted (not the old "can not be found or has been deleted" hedge) when no unsynced text was preserved', async () => {
    const save = controller.saveAndAwaitLocalPropagation({ text: 'stale edit', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await save

    expect(items.getItems).toHaveBeenCalledWith(ContentType.TYPES.Note)
    expect(alerts.alert).toHaveBeenCalledTimes(1)
    const [message, title] = alerts.alert.mock.calls[0]
    expect(title).toBe('Note deleted')
    expect(message).toContain('This note was deleted')
    expect(message).not.toContain('kept as a new note')
    expect(mutator.changeItem).not.toHaveBeenCalled()
  })

  it('points the user at the automatic conflict-copy instead of the old copy-it-out-by-hand instruction when one exists', async () => {
    const rescueCopy = {
      uuid: 'rescue-uuid',
      title: 'My Note (recovered)',
      conflictOf: item.uuid,
      updated_at: new Date('2026-09-24T00:00:00Z'),
    } as unknown as SNNote
    items.getItems.mockReturnValue([rescueCopy])

    const save = controller.saveAndAwaitLocalPropagation({ text: 'stale edit', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await save

    expect(alerts.alert).toHaveBeenCalledTimes(1)
    const [message] = alerts.alert.mock.calls[0]
    expect(message).toContain('kept as a new note titled "My Note (recovered)"')
  })

  it('picks the most recently updated conflict-copy when more than one exists', async () => {
    const older = {
      uuid: 'older-rescue',
      title: 'Older copy',
      conflictOf: item.uuid,
      updated_at: new Date('2026-09-01T00:00:00Z'),
    } as unknown as SNNote
    const newer = {
      uuid: 'newer-rescue',
      title: 'Newer copy',
      conflictOf: item.uuid,
      updated_at: new Date('2026-09-24T00:00:00Z'),
    } as unknown as SNNote
    items.getItems.mockReturnValue([older, newer])

    const save = controller.saveAndAwaitLocalPropagation({ text: 'stale edit', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await save

    const [message] = alerts.alert.mock.calls[0]
    expect(message).toContain('Newer copy')
    expect(message).not.toContain('Older copy')
  })

  it('pins the status at the deletion error instead of letting later showSavingStatus/showAllChangesSavedStatus calls pretend the editor is still live', async () => {
    const save = controller.saveAndAwaitLocalPropagation({ text: 'stale edit', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await save

    expect(controller.status?.type).toBe('error')
    expect(controller.status?.message).toBe('Note deleted')

    controller.showSavingStatus()
    expect(controller.status?.type).toBe('error')

    controller.showAllChangesSavedStatus()
    expect(controller.status?.type).toBe('error')
  })

  it('never attempts to save again and never re-alerts once the note has been reported gone', async () => {
    const firstSave = controller.saveAndAwaitLocalPropagation({ text: 'stale edit', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await firstSave

    expect(alerts.alert).toHaveBeenCalledTimes(1)

    const secondSave = controller.saveAndAwaitLocalPropagation({
      text: 'more typing into a dead editor',
      bypassDebouncer: true,
    })
    jest.runOnlyPendingTimers()
    await secondSave

    expect(mutator.changeItem).not.toHaveBeenCalled()
    expect(alerts.alert).toHaveBeenCalledTimes(1)
  })
})
