import {
  AlertService,
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
})
