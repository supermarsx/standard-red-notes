import { AutoVaultRulesService } from './AutoVaultRulesService'
import type { WebApplication } from '@/Application/WebApplication'
import type { AutoVaultRule } from './autoVaultRules'
import { CollaborationSaverRegistry } from '@/Components/SuperEditor/Collaboration/CollaborationSaverElection'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'

jest.mock('@standardnotes/snjs', () => ({
  ApplicationEvent: {
    LocalDataLoaded: 'loaded',
    CompletedFullSync: 'sync',
    ExitedOutOfSync: 'online',
    SignedIn: 'signed-in',
    SignedOut: 'signed-out',
  },
  ContentType: { TYPES: { Note: 'Note', Tag: 'Tag', UserPrefs: 'Prefs' } },
  FolderContentType: 'Folder',
  PrefKey: { AutoVaultRules: 'rules' },
  isDeletedItem: (item: { deleted?: boolean }) => item.deleted === true,
}))
jest.mock('@/Components/SuperEditor/Collaboration/CollaborationSaverElection', () => ({
  CollaborationSaverRegistry: { get: jest.fn() },
}))
jest.mock('@/Components/NoteView/Controller/NoteViewController', () => ({
  NoteViewController: class {
    item = { uuid: 'note' }
    flushAndAwaitPendingSaveStrict = jest.fn().mockResolvedValue(undefined)
  },
}))

describe('automatic note vault assignment', () => {
  let service: AutoVaultRulesService
  beforeEach(() => {
    jest.useFakeTimers()
    jest.mocked(CollaborationSaverRegistry.get).mockReturnValue(undefined)
  })
  afterEach(() => {
    service?.deinit()
    jest.useRealTimers()
  })
  const setup = (initialRules: AutoVaultRule[]) => {
    let rules = initialRules
    let userUuid: string | undefined = 'user-a'
    const eventObservers: ((event: string) => Promise<void>)[] = []
    const note = {
      uuid: 'note',
      trashed: false,
      deleted: false,
      key_system_identifier: undefined as string | undefined,
    }
    const tag = {
      uuid: 'topic',
      parentId: undefined,
      noteReferences: [{ uuid: 'note' }],
      key_system_identifier: undefined as string | undefined,
    }
    const folders = [{ uuid: 'folder', noteReferences: [{ uuid: 'note' }] }]
    const notes = [note]
    const vault = { uuid: 'vault', systemIdentifier: 'system', isSharedVaultListing: () => false }
    const otherVault = { uuid: 'other', systemIdentifier: 'other-system', isSharedVaultListing: () => false }
    const observers: (() => void)[] = []
    const locked = jest.fn().mockReturnValue(false)
    const readonly = jest.fn().mockReturnValue(false)
    const linkedFiles = jest.fn().mockReturnValue([])
    const move = jest.fn().mockImplementation(async (target, item) => {
      item.key_system_identifier = target.systemIdentifier
      return { isFailed: () => false }
    })
    const controllers: NoteViewController[] = []
    const application = {
      sessions: { getUser: () => (userUuid ? { uuid: userUuid } : undefined) },
      getPreference: () => rules,
      setPreference: async (_key: string, value: AutoVaultRule[]) => {
        rules = value
      },
      addEventObserver: (callback: (event: string) => Promise<void>) => {
        eventObservers.push(callback)
        return () => {}
      },
      items: {
        addObserver: (_type: unknown, callback: () => void) => {
          observers.push(callback)
          return () => {}
        },
        getItems: (type: string) => (type === 'Note' ? notes : type === 'Tag' ? [tag] : folders),
        findItem: (uuid: string) => (uuid === tag.uuid ? tag : notes.find((candidate) => candidate.uuid === uuid)),
        getUnsortedTagsForItem: () => (initialRules.some((rule) => rule.kind === 'tag') ? [tag] : []),
        getItemLinkedFiles: linkedFiles,
        getItemLinkedNotes: () => [],
      },
      vaults: { getVaults: () => [vault, otherVault], getItemVault: () => undefined, moveItemToVault: move },
      vaultLocks: { isVaultLocked: locked },
      vaultUsers: { isCurrentUserReadonlyVaultMember: readonly },
      itemControllerGroup: { itemControllers: controllers },
    }
    service = new AutoVaultRulesService(application as unknown as WebApplication)
    return {
      note,
      tag,
      notes,
      folders,
      move,
      locked,
      readonly,
      linkedFiles,
      controllers,
      observers,
      setRules: (value: AutoVaultRule[]) => {
        rules = value
      },
      setUser: (value: string | undefined) => {
        userUuid = value
      },
      eventObservers,
    }
  }
  it('assigns existing topic notes through the safe vault operation after moving only the configured topic', async () => {
    const fixture = setup([{ kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault' }])
    await service.applyRules()
    expect(fixture.move.mock.calls.map((call) => call[1].uuid)).toEqual(['topic', 'note'])
    expect(fixture.note.key_system_identifier).toBe('system')
    expect(service.problems).toEqual([])
    await service.applyRules()
    expect(fixture.move).toHaveBeenCalledTimes(2)
  })
  it('applies a parent folder rule to future notes after a membership mutation', async () => {
    const fixture = setup([{ kind: 'folder', sourceUuid: 'folder', vaultUuid: 'vault' }])
    await service.applyRules()
    const created = { ...fixture.note, uuid: 'new-note', key_system_identifier: undefined }
    fixture.notes.push(created)
    fixture.folders[0].noteReferences.push({ uuid: 'new-note' })
    fixture.observers[0]()
    await jest.advanceTimersByTimeAsync(200)
    expect(created.key_system_identifier).toBe('system')
  })
  it('keeps all note/topic vaults unchanged when destinations conflict', async () => {
    const fixture = setup([
      { kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault' },
      { kind: 'folder', sourceUuid: 'folder', vaultUuid: 'other' },
    ])
    await service.applyRules()
    expect(fixture.move).not.toHaveBeenCalled()
    expect(service.problems).toEqual([{ noteUuid: 'note', reason: 'conflict' }])
  })
  it('never moves trashed/deleted notes, locked vaults, read-only sources or unrelated files', async () => {
    const fixture = setup([{ kind: 'folder', sourceUuid: 'folder', vaultUuid: 'vault' }])
    fixture.note.trashed = true
    await service.applyRules()
    expect(fixture.move).not.toHaveBeenCalled()
    fixture.note.trashed = false
    fixture.note.deleted = true
    await service.applyRules()
    expect(fixture.move).not.toHaveBeenCalled()
    fixture.note.deleted = false
    fixture.locked.mockReturnValue(true)
    await service.applyRules()
    expect(service.problems[0].reason).toBe('locked')
    fixture.locked.mockReturnValue(false)
    fixture.readonly.mockReturnValue(true)
    await service.applyRules()
    expect(service.problems[0].reason).toBe('permission')
    fixture.readonly.mockReturnValue(false)
    fixture.linkedFiles.mockReturnValue([{ uuid: 'unrelated-file' }])
    await service.applyRules()
    expect(service.problems[0].reason).toBe('linked-items')
    expect(fixture.move).not.toHaveBeenCalled()
  })
  it('defers non-authoritative live notes and rechecks changed rules after an editor flush', async () => {
    const fixture = setup([{ kind: 'folder', sourceUuid: 'folder', vaultUuid: 'vault' }])
    jest.mocked(CollaborationSaverRegistry.get).mockReturnValue({ active: true, isSaver: false } as never)
    await service.applyRules()
    expect(fixture.move).not.toHaveBeenCalled()
    expect(service.problems[0].reason).toBe('saving')
    jest.mocked(CollaborationSaverRegistry.get).mockReturnValue(undefined)
    const controller = new (NoteViewController as unknown as { new (): NoteViewController })()
    jest.mocked(controller.flushAndAwaitPendingSaveStrict).mockImplementation(async () => {
      fixture.setRules([{ kind: 'folder', sourceUuid: 'folder', vaultUuid: 'other' }])
    })
    fixture.controllers.push(controller)
    await service.applyRules()
    expect(controller.flushAndAwaitPendingSaveStrict).toHaveBeenCalled()
    expect(fixture.move).not.toHaveBeenCalled()
  })

  it('does not move a live note when authoritative ownership is lost during its durability flush', async () => {
    const fixture = setup([{ kind: 'folder', sourceUuid: 'folder', vaultUuid: 'vault' }])
    jest
      .mocked(CollaborationSaverRegistry.get)
      .mockReturnValueOnce({
        active: true,
        isSaver: true,
        paused: false,
        saveFence: { room: 'note', token: 'fixture' },
      } as never)
      .mockReturnValue({ active: true, isSaver: false } as never)
    const controller = new (NoteViewController as unknown as { new (): NoteViewController })()
    fixture.controllers.push(controller)
    await service.applyRules()
    expect(controller.flushAndAwaitPendingSaveStrict).toHaveBeenCalled()
    expect(fixture.move).not.toHaveBeenCalled()
    expect(service.problems[0].reason).toBe('saving')
  })

  it('abandons an in-flight topic run across sign-out/sign-in even when the same account and rules return', async () => {
    const fixture = setup([{ kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault' }])
    let finish!: () => void
    fixture.move.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ isFailed: () => true })
        }),
    )
    const pending = service.applyRules()
    await Promise.resolve()
    expect(fixture.move).toHaveBeenCalledTimes(1)
    fixture.setUser(undefined)
    await fixture.eventObservers[0]('signed-out')
    fixture.setUser('user-a')
    await fixture.eventObservers[0]('signed-in')
    finish()
    await pending
    expect(fixture.move).toHaveBeenCalledTimes(1)
    expect(fixture.note.key_system_identifier).toBeUndefined()
    expect(service.problems).toEqual([])
  })

  it('does not move a topic while a related live note belongs to another saver', async () => {
    const fixture = setup([{ kind: 'tag', sourceUuid: 'topic', vaultUuid: 'vault' }])
    jest.mocked(CollaborationSaverRegistry.get).mockReturnValue({ active: true, isSaver: false } as never)
    await service.applyRules()
    expect(fixture.move).not.toHaveBeenCalled()
    expect(service.problems.some((problem) => problem.reason === 'saving')).toBe(true)
  })
})
