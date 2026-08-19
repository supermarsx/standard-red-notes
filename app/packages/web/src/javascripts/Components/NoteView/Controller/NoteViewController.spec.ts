import { WebApplication } from '@/Application/WebApplication'
import { ContentType } from '@standardnotes/domain-core'
import {
  ComponentManager,
  ComponentItem,
  SNTag,
  SNNote,
  Deferred,
  SyncServiceInterface,
  ItemManagerInterface,
  MutatorClientInterface,
  PreferenceServiceInterface,
} from '@standardnotes/snjs'
import { NativeFeatureIdentifier, NoteType } from '@standardnotes/features'
import { NoteViewController } from './NoteViewController'

describe('note view controller', () => {
  let application: WebApplication
  let componentManager: ComponentManager

  beforeEach(() => {
    application = {
      preferences: {
        getValue: jest.fn().mockReturnValue(true),
      } as unknown as jest.Mocked<PreferenceServiceInterface>,
      items: {
        streamItems: jest.fn().mockReturnValue(() => {}),
        createTemplateItem: jest.fn().mockReturnValue({} as SNNote),
      } as unknown as jest.Mocked<ItemManagerInterface>,
      mutator: {} as jest.Mocked<MutatorClientInterface>,
      sessions: {
        isSignedIn: jest.fn().mockReturnValue(true),
      },
    } as unknown as jest.Mocked<WebApplication>

    application.isNativeMobileWeb = jest.fn().mockReturnValue(false)

    Object.defineProperty(application, 'sync', { value: {} as jest.Mocked<SyncServiceInterface> })
    application.sync.sync = jest.fn().mockReturnValue(Promise.resolve())

    componentManager = {} as jest.Mocked<ComponentManager>
    Object.defineProperty(application, 'componentManager', { value: componentManager })
  })

  it('should create notes with plaintext note type', async () => {
    application.componentManager.getDefaultEditorIdentifier = jest
      .fn()
      .mockReturnValue(NativeFeatureIdentifier.TYPES.PlainEditor)

    const controller = new NoteViewController(
      undefined,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    expect(application.items.createTemplateItem).toHaveBeenCalledWith(
      ContentType.TYPES.Note,
      expect.objectContaining({ noteType: NoteType.Plain }),
      expect.anything(),
    )
  })

  it('should create notes with markdown note type', async () => {
    application.items.getDisplayableComponents = jest.fn().mockReturnValue([
      {
        identifier: NativeFeatureIdentifier.TYPES.DeprecatedMarkdownProEditor,
      } as ComponentItem,
    ])

    application.componentManager.getDefaultEditorIdentifier = jest
      .fn()
      .mockReturnValue(NativeFeatureIdentifier.TYPES.DeprecatedMarkdownProEditor)

    const controller = new NoteViewController(
      undefined,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    expect(application.items.createTemplateItem).toHaveBeenCalledWith(
      ContentType.TYPES.Note,
      expect.objectContaining({ noteType: NoteType.Markdown }),
      expect.anything(),
    )
  })

  it('should add tag to note if default tag is set', async () => {
    application.componentManager.getDefaultEditorIdentifier = jest
      .fn()
      .mockReturnValue(NativeFeatureIdentifier.TYPES.PlainEditor)

    const tag = {
      uuid: 'tag-uuid',
    } as jest.Mocked<SNTag>

    application.items.findItem = jest.fn().mockReturnValue(tag)
    application.mutator.addTagToNote = jest.fn()

    const controller = new NoteViewController(
      undefined,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
      { tag: tag.uuid },
    )
    await controller.initialize()

    expect(controller['defaultTag']).toEqual(tag)
    expect(application.mutator.addTagToNote).toHaveBeenCalledWith(expect.anything(), tag, expect.anything())
  })

  /**
   * Standard Red Notes (last-edit-loss fix — dealloced guard): a lifecycle flush can
   * fire AFTER the controller is deinited (the <SuperEditor> unmounts after the
   * controller is closed on note-switch). A post-deinit save must be a safe NO-OP, not
   * a throw that loses the edit / crashes the unmount.
   */
  it('saveAndAwaitLocalPropagation is a safe no-op after deinit (does not throw)', async () => {
    const note = { uuid: 'note-uuid', text: '' } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)
    application.mutator.changeItem = jest.fn().mockResolvedValue(undefined)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()
    controller.deinit()
    expect(controller.dealloced).toEqual(true)

    await expect(
      controller.saveAndAwaitLocalPropagation({ text: 'late edit', isUserModified: true }),
    ).resolves.toBeUndefined()
    expect(application.mutator.changeItem).not.toHaveBeenCalled()
  })

  /**
   * Standard Red Notes (last-edit-loss fix): the active editor registers a flush +
   * hasPending with the controller; flushAndAwaitPendingSave invokes the flush, and a
   * post-deinit flush is a no-op (the editorHasPendingChanges/flushEditorSerialize
   * guards short-circuit on dealloced).
   */
  it('flushAndAwaitPendingSave invokes the registered editor flush; both are no-ops after deinit', async () => {
    const note = { uuid: 'note-uuid', text: '' } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const flush = jest.fn()
    const hasPending = jest.fn().mockReturnValue(true)
    controller.registerEditorFlush(flush, hasPending)

    expect(controller.editorHasPendingChanges()).toBe(true)

    await controller.flushAndAwaitPendingSave()
    expect(flush).toHaveBeenCalledTimes(1)

    controller.deinit()
    flush.mockClear()

    // After deinit the flush + hasPending guards short-circuit (no throw, no call).
    expect(controller.editorHasPendingChanges()).toBe(false)
    controller.flushEditorSerialize()
    await controller.flushAndAwaitPendingSave()
    expect(flush).not.toHaveBeenCalled()
  })

  it('strict Todo durability retains and retries the exact failed local state before provider flush', async () => {
    const note = { uuid: 'note-uuid', text: '' } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)
    application.sessions.isSignedOut = jest.fn().mockReturnValue(false)
    const localFailure = new Error('local persistence failed')
    application.mutator.changeItem = jest
      .fn()
      .mockRejectedValueOnce(localFailure)
      .mockRejectedValueOnce(localFailure)
      .mockResolvedValueOnce(undefined)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const providerFlush = jest.fn().mockResolvedValue(undefined)
    controller.registerEditorDurabilityFlush(providerFlush)
    let firstSerialize = true
    controller.registerEditorFlush(
      () => {
        if (!firstSerialize) {
          return
        }
        firstSerialize = false
        void controller.saveAndAwaitLocalPropagation({
          text: 'exact serialized checklist state',
          isUserModified: true,
          bypassDebouncer: true,
        })
      },
      () => true,
    )

    await expect(controller.flushAndAwaitPendingSaveStrict()).rejects.toThrow('local persistence failed')
    expect(providerFlush).not.toHaveBeenCalled()
    expect(application.mutator.changeItem).toHaveBeenCalledTimes(1)

    await expect(controller.flushAndAwaitPendingSaveStrict()).rejects.toThrow('local persistence failed')
    expect(providerFlush).not.toHaveBeenCalled()
    expect(application.mutator.changeItem).toHaveBeenCalledTimes(2)

    await expect(controller.flushAndAwaitPendingSaveStrict()).resolves.toBeUndefined()
    expect(application.mutator.changeItem).toHaveBeenCalledTimes(3)
    expect(application.mutator.changeItem).toHaveBeenLastCalledWith(note, expect.any(Function), expect.anything())
    expect(providerFlush).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  /**
   * Standard Red Notes: a collaboration provider that never becomes mutation-ready
   * (relay unreachable / room state still correlating) used to reject the ORDINARY
   * note-switch teardown, so every note open threw and navigation was blocked. The
   * note's own text is persisted by the local save above the relay flush, so the
   * teardown now continues and reports the lost relay exactly once.
   */
  it('note-switch teardown survives a provider that is not mutation-ready and reports it once', async () => {
    const note = { uuid: 'note-uuid', text: '' } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const providerFlush = jest
      .fn()
      .mockRejectedValue(new Error('Checklist collaboration provider is not mutation-ready.'))
    controller.registerEditorDurabilityFlush(providerFlush)
    const showError = jest.spyOn(controller, 'showErrorSyncStatus')

    await expect(controller.flushAndAwaitPendingSave()).resolves.toBeUndefined()
    await expect(controller.flushAndAwaitPendingSave()).resolves.toBeUndefined()

    expect(providerFlush).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    consoleError.mockRestore()
  })

  /**
   * The relay flush may only be waived once the LOCAL copy is proved durable. When
   * local persistence also failed there is genuine unsaved content, so the teardown
   * must still reject and the caller keeps the editor mounted.
   */
  it('note-switch teardown still rejects when the local copy is not durable either', async () => {
    const note = { uuid: 'note-uuid', text: '' } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)
    application.sessions.isSignedOut = jest.fn().mockReturnValue(false)
    application.mutator.changeItem = jest.fn().mockRejectedValue(new Error('local persistence failed'))
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    controller.registerEditorDurabilityFlush(
      jest.fn().mockRejectedValue(new Error('Checklist collaboration provider is not mutation-ready.')),
    )
    let firstSerialize = true
    controller.registerEditorFlush(
      () => {
        if (!firstSerialize) {
          return
        }
        firstSerialize = false
        void controller.saveAndAwaitLocalPropagation({
          text: 'unsaved checklist state',
          isUserModified: true,
          bypassDebouncer: true,
        })
      },
      () => true,
    )

    await expect(controller.flushAndAwaitPendingSave()).rejects.toThrow('local persistence failed')
    consoleError.mockRestore()
  })

  it('security teardown synchronously scrubs a retained vault note and editor callbacks', async () => {
    const disposeItemStream = jest.fn()
    application.items.streamItems = jest.fn().mockReturnValue(disposeItemStream)
    application.mutator.changeItem = jest.fn()
    const note = {
      uuid: 'vault-note-uuid',
      title: 'Retained vault title',
      text: 'retained vault plaintext',
      key_system_identifier: 'vault-key-system',
    } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const flush = jest.fn()
    controller.registerEditorFlush(flush, () => true)

    controller.deinitImmediatelyForSecurity()

    expect(controller.dealloced).toBe(true)
    expect((controller as unknown as { item?: SNNote }).item).toBeUndefined()
    expect((controller as unknown as { syncController: { item?: SNNote } }).syncController.item).toBeUndefined()
    expect(controller.editorHasPendingChanges()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
    expect(disposeItemStream).toHaveBeenCalledTimes(1)

    controller.flushEditorSerialize()
    await controller.saveAndAwaitLocalPropagation({ text: 'must not escape after lock' })
    expect(flush).not.toHaveBeenCalled()
    expect(application.mutator.changeItem).not.toHaveBeenCalled()

    controller.deinitImmediatelyForSecurity()
    expect(disposeItemStream).toHaveBeenCalledTimes(1)
  })

  it('security teardown cancels a queued vault save without flushing plaintext', async () => {
    jest.useFakeTimers()
    const note = {
      uuid: 'vault-note-with-pending-save',
      text: 'retained vault plaintext',
      key_system_identifier: 'vault-key-system',
    } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)
    application.mutator.changeItem = jest.fn().mockResolvedValue(undefined)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const pendingSave = controller.saveAndAwaitLocalPropagation({
      text: 'new vault plaintext',
      bypassDebouncer: true,
    })
    controller.deinitImmediatelyForSecurity()
    await expect(pendingSave).resolves.toBeUndefined()
    jest.runOnlyPendingTimers()

    expect(application.mutator.changeItem).not.toHaveBeenCalled()
    expect((controller as unknown as { item?: SNNote }).item).toBeUndefined()
    expect(
      (controller as unknown as { syncController: { savingLocallyPromise: unknown } }).syncController
        .savingLocallyPromise,
    ).toBeNull()
    jest.useRealTimers()
  })

  it('ordinary deinit still scrubs retained plaintext when its local-save wait rejects', async () => {
    const note = {
      uuid: 'vault-note-with-rejected-save',
      text: 'retained vault plaintext',
      key_system_identifier: 'vault-key-system',
    } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const rejectedSave = Deferred<void>()
    ;(
      controller as unknown as {
        syncController: { savingLocallyPromise: typeof rejectedSave }
      }
    ).syncController.savingLocallyPromise = rejectedSave

    controller.deinit()
    expect(controller.dealloced).toBe(false)

    rejectedSave.reject()
    await rejectedSave.promise.catch(() => undefined)
    await Promise.resolve()

    expect(controller.dealloced).toBe(true)
    expect((controller as unknown as { item?: SNNote }).item).toBeUndefined()
  })

  it('should wait until item finishes saving locally before deiniting', async () => {
    const note = {
      uuid: 'note-uuid',
    } as jest.Mocked<SNNote>

    application.items.findItem = jest.fn().mockReturnValue(note)

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const changePromise = Deferred()

    application.mutator.changeItem = jest.fn().mockReturnValue(changePromise.promise)

    const savePromise = controller.saveAndAwaitLocalPropagation({ isUserModified: true, bypassDebouncer: true })
    controller.deinit()

    expect(controller.dealloced).toEqual(false)

    changePromise.resolve(true)
    await changePromise.promise
    await savePromise

    expect(controller.dealloced).toEqual(true)
  })

  it('ordinary deinit waits for older overlapping mutations, not only the latest save', async () => {
    jest.useFakeTimers()
    const note = {
      uuid: 'overlapping-note',
      text: 'retained plaintext',
    } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)

    let finishFirstMutation: (() => void) | undefined
    const firstMutation = new Promise<void>((resolve) => {
      finishFirstMutation = resolve
    })
    ;(application.mutator as unknown as { changeItem: jest.Mock }).changeItem = jest
      .fn()
      .mockImplementationOnce((_item: SNNote, mutate: (mutator: Record<string, unknown>) => void) => {
        mutate({})
        return firstMutation
      })
      .mockImplementationOnce((_item: SNNote, mutate: (mutator: Record<string, unknown>) => void) => {
        mutate({})
        return Promise.resolve(note)
      })

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const firstSave = controller.saveAndAwaitLocalPropagation({ text: 'first', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await Promise.resolve()

    const secondSave = controller.saveAndAwaitLocalPropagation({ text: 'second', bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await secondSave

    controller.deinit()
    expect(controller.dealloced).toBe(false)

    finishFirstMutation?.()
    await firstMutation
    await firstSave
    await Promise.resolve()

    expect(controller.dealloced).toBe(true)
    expect((controller as unknown as { item?: SNNote }).item).toBeUndefined()
    jest.useRealTimers()
  })

  it('keeps deinit waiting when a newer debounce supersedes the queued save', async () => {
    jest.useFakeTimers()
    const note = {
      uuid: 'superseded-note',
      text: 'retained plaintext',
    } as jest.Mocked<SNNote>
    application.items.findItem = jest.fn().mockReturnValue(note)
    application.mutator.changeItem = jest
      .fn()
      .mockImplementation((_item: SNNote, mutate: (mutator: Record<string, unknown>) => void) => {
        mutate({})
        return Promise.resolve(note)
      })

    const controller = new NoteViewController(
      note,
      application.items,
      application.mutator,
      application.sync,
      application.sessions,
      application.preferences,
      application.componentManager,
      application.alerts,
      application.isNativeMobileWebUseCase,
    )
    await controller.initialize()

    const firstSave = controller.saveAndAwaitLocalPropagation({ text: 'superseded', bypassDebouncer: true })
    controller.deinit()
    const secondSave = controller.saveAndAwaitLocalPropagation({ text: 'must persist', bypassDebouncer: true })

    await firstSave
    await Promise.resolve()
    expect(controller.dealloced).toBe(false)

    jest.runOnlyPendingTimers()
    await secondSave
    await Promise.resolve()

    expect(application.mutator.changeItem).toHaveBeenCalledTimes(1)
    expect(controller.dealloced).toBe(true)
    jest.useRealTimers()
  })
})
