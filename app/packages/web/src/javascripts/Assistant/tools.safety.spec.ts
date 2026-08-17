import { WebApplication } from '@/Application/WebApplication'
import { createEmailReminder, deleteEmailReminder } from '@/Reminders/emailReminders'
import { Reminder } from '@/Reminders/reminders'
import { CollectionSort, ContentType, PrefKey } from '@standardnotes/snjs'
import { AssistantToolContext, AssistantTools } from './tools'

jest.mock('@/Reminders/emailReminders', () => ({
  createEmailReminder: jest.fn(),
  deleteEmailReminder: jest.fn(),
}))

const createEmailReminderMock = createEmailReminder as jest.MockedFunction<typeof createEmailReminder>
const deleteEmailReminderMock = deleteEmailReminder as jest.MockedFunction<typeof deleteEmailReminder>

function makeContext(overrides: Partial<AssistantToolContext> = {}): AssistantToolContext {
  return {
    confirmBeforeWrite: false,
    requestConfirmation: async () => true,
    presentPane: () => {},
    ...overrides,
  }
}

function reminder(id: string, emailReminderId?: string): Reminder {
  return {
    id,
    dueAt: '2027-01-01T00:00:00.000Z',
    message: `Reminder ${id}`,
    ...(emailReminderId ? { emailReminderId } : {}),
  }
}

function makeReminderApplication(initial: Reminder[] = []) {
  const state = { reminders: initial.map((value) => ({ ...value })) }
  const note = {
    uuid: 'note-1',
    content_type: ContentType.TYPES.Note,
    title: 'Reminder note',
    text: '',
    preview_plain: '',
    pinned: false,
    archived: false,
    starred: false,
    trashed: false,
    protected: false,
    getAppDomainValue: () => state.reminders,
  }
  const notesController = {
    upsertNoteReminder: jest.fn(async (_note: unknown, value: Reminder) => {
      state.reminders = [...state.reminders.filter((existing) => existing.id !== value.id), { ...value }]
    }),
    clearNoteReminders: jest.fn(async () => {
      state.reminders = []
    }),
  }
  const mutator = {
    changeItem: jest.fn(
      async (
        _note: unknown,
        mutate: (value: { setAppDataItem: (_key: unknown, value: Reminder[] | undefined) => void }) => void,
      ) => {
        mutate({
          setAppDataItem: (_key: unknown, value: Reminder[] | undefined) => {
            state.reminders = value?.map((entry) => ({ ...entry })) ?? []
          },
        })
        return note
      },
    ),
  }
  const legacyApi = { identity: 'old-email-client' }
  const record = {
    legacyApi,
    hasAccount: () => true,
    items: {
      findItem: (uuid: string) => (uuid === note.uuid ? note : undefined),
      getItems: () => [note],
    },
    notesController,
    mutator,
  }
  return { application: record as unknown as WebApplication, record, legacyApi, mutator, note, notesController, state }
}

beforeEach(() => {
  createEmailReminderMock.mockReset()
  deleteEmailReminderMock.mockReset()
  deleteEmailReminderMock.mockResolvedValue(true)
})

describe('AssistantTools preference value validation', () => {
  const booleanKeys = [
    PrefKey.SortNotesReverse,
    PrefKey.NotesShowArchived,
    PrefKey.NotesShowTrashed,
    PrefKey.NotesHidePinned,
    PrefKey.NotesHideNotePreview,
    PrefKey.NotesHideDate,
    PrefKey.NotesHideTags,
    PrefKey.NotesHideEditorIcon,
    PrefKey.EditorSpellcheck,
    PrefKey.AlwaysShowSuperToolbar,
  ]

  it('accepts only booleans for every allowlisted boolean preference', async () => {
    const setPreference = jest.fn(async () => undefined)
    const tools = new AssistantTools({ setPreference } as unknown as WebApplication, makeContext())

    for (const key of booleanKeys) {
      await expect(tools.call('app.setPreference', { key, value: true })).resolves.toMatchObject({ ok: true, key })
      await expect(tools.call('app.setPreference', { key, value: 'true' })).rejects.toThrow('boolean')
    }

    expect(setPreference).toHaveBeenCalledTimes(booleanKeys.length)
  })

  it('bounds note sorting to the concrete values supported by the list controller', async () => {
    const setPreference = jest.fn(async () => undefined)
    const tools = new AssistantTools({ setPreference } as unknown as WebApplication, makeContext())
    const accepted = [CollectionSort.CreatedAt, CollectionSort.UpdatedAt, CollectionSort.Title, CollectionSort.Custom]

    for (const value of accepted) {
      await expect(tools.call('app.setPreference', { key: PrefKey.SortNotesBy, value })).resolves.toMatchObject({
        ok: true,
        value,
      })
    }
    for (const value of ['createdAt', '', true, { property: 'title' }]) {
      await expect(tools.call('app.setPreference', { key: PrefKey.SortNotesBy, value })).rejects.toThrow(
        'must be one of',
      )
    }

    expect(setPreference).toHaveBeenCalledTimes(accepted.length)
  })

  it('reports a delayed mutation as completed when cancellation arrives after dispatch starts', async () => {
    const controller = new AbortController()
    let finishMutation!: () => void
    const setPreference = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishMutation = resolve
        }),
    )
    const tools = new AssistantTools(
      { setPreference } as unknown as WebApplication,
      makeContext({ signal: controller.signal }),
    )

    const pending = tools.call('app.setPreference', { key: PrefKey.EditorSpellcheck, value: false })
    await Promise.resolve()
    controller.abort()
    finishMutation()

    await expect(pending).resolves.toEqual({
      ok: true,
      key: PrefKey.EditorSpellcheck,
      value: false,
      completedAfterCancellation: true,
    })
    expect(setPreference).toHaveBeenCalledWith(PrefKey.EditorSpellcheck, false)
  })
})

describe('AssistantTools reminder reconciliation', () => {
  it('finishes and truthfully reports linking an externally created id when the user aborts mid-call', async () => {
    const { application, notesController, state } = makeReminderApplication()
    const controller = new AbortController()
    createEmailReminderMock.mockImplementation(async () => {
      controller.abort()
      return 'email-created'
    })
    const tools = new AssistantTools(
      application,
      makeContext({ signal: controller.signal, selectedNoteUuids: new Set(['note-1']) }),
    )

    await expect(
      tools.call('reminders.set', {
        uuid: 'note-1',
        datetime: '2027-01-01T00:00:00Z',
        email: true,
      }),
    ).resolves.toMatchObject({ ok: true, completedAfterCancellation: true })

    expect(notesController.upsertNoteReminder).toHaveBeenCalledTimes(1)
    expect(state.reminders).toEqual([expect.objectContaining({ emailReminderId: 'email-created' })])
    expect(deleteEmailReminderMock).not.toHaveBeenCalled()
  })

  it('rolls an external id back through the captured client when the account changes', async () => {
    const { application, record, legacyApi, notesController } = makeReminderApplication()
    let sessionCurrent = true
    const replacementController = { upsertNoteReminder: jest.fn() }
    createEmailReminderMock.mockImplementation(async (capturedApplication) => {
      expect((capturedApplication as unknown as { legacyApi: unknown }).legacyApi).toBe(legacyApi)
      sessionCurrent = false
      record.legacyApi = { identity: 'new-email-client' }
      record.notesController = replacementController as unknown as typeof notesController
      return 'old-account-email'
    })
    const tools = new AssistantTools(
      application,
      makeContext({ isSessionCurrent: () => sessionCurrent, selectedNoteUuids: new Set(['note-1']) }),
    )

    await expect(
      tools.call('reminders.set', {
        uuid: 'note-1',
        datetime: '2027-01-01T00:00:00Z',
        email: true,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(deleteEmailReminderMock).toHaveBeenCalledWith(expect.objectContaining({ legacyApi }), 'old-account-email')
    expect(notesController.upsertNoteReminder).not.toHaveBeenCalled()
    expect(replacementController.upsertNoteReminder).not.toHaveBeenCalled()
  })

  it('deletes a newly-created external id when its local write fails', async () => {
    const { application, notesController, state } = makeReminderApplication()
    createEmailReminderMock.mockResolvedValue('email-to-compensate')
    notesController.upsertNoteReminder.mockRejectedValueOnce(new Error('local write failed'))
    const tools = new AssistantTools(application, makeContext({ selectedNoteUuids: new Set(['note-1']) }))

    await expect(
      tools.call('reminders.set', {
        uuid: 'note-1',
        datetime: '2027-01-01T00:00:00Z',
        email: true,
      }),
    ).rejects.toThrow('local write failed')

    expect(deleteEmailReminderMock).toHaveBeenCalledWith(
      expect.objectContaining({ legacyApi: expect.anything() }),
      'email-to-compensate',
    )
    expect(state.reminders).toEqual([])
  })

  it('relinks a created id when both the initial local write and external rollback fail', async () => {
    const { application, notesController, state } = makeReminderApplication()
    createEmailReminderMock.mockResolvedValue('email-preserved')
    deleteEmailReminderMock.mockResolvedValue(false)
    notesController.upsertNoteReminder.mockRejectedValueOnce(new Error('transient local failure'))
    const tools = new AssistantTools(application, makeContext({ selectedNoteUuids: new Set(['note-1']) }))

    await expect(
      tools.call('reminders.set', {
        uuid: 'note-1',
        datetime: '2027-01-01T00:00:00Z',
        email: true,
      }),
    ).resolves.toMatchObject({ ok: true, warning: expect.stringContaining('relinked') })
    expect(notesController.upsertNoteReminder).toHaveBeenCalledTimes(2)
    expect(state.reminders).toEqual([expect.objectContaining({ emailReminderId: 'email-preserved' })])
  })

  it('finishes and truthfully reports clearing every captured external id after a mid-call abort', async () => {
    const { application, legacyApi, state } = makeReminderApplication([
      reminder('first', 'email-first'),
      reminder('second', 'email-second'),
    ])
    const controller = new AbortController()
    deleteEmailReminderMock.mockImplementation(async (_application, id) => {
      if (id === 'email-first') {
        controller.abort()
      }
      return true
    })
    const tools = new AssistantTools(
      application,
      makeContext({ signal: controller.signal, selectedNoteUuids: new Set(['note-1']) }),
    )

    await expect(tools.call('reminders.clear', { uuid: 'note-1' })).resolves.toEqual({
      ok: true,
      noteUuid: 'note-1',
      cleared: 2,
      completedAfterCancellation: true,
    })

    expect(deleteEmailReminderMock.mock.calls).toEqual([
      [expect.objectContaining({ legacyApi }), 'email-first'],
      [expect.objectContaining({ legacyApi }), 'email-second'],
    ])
    expect(state.reminders).toEqual([])
  })

  it('keeps clear operations on the controller and email client captured before the first await', async () => {
    const { application, record, legacyApi, notesController, state } = makeReminderApplication([
      reminder('first', 'email-first'),
    ])
    const replacementController = { clearNoteReminders: jest.fn() }
    notesController.clearNoteReminders.mockImplementationOnce(async () => {
      state.reminders = []
      record.legacyApi = { identity: 'new-email-client' }
      record.notesController = replacementController as unknown as typeof notesController
    })
    const tools = new AssistantTools(application, makeContext({ selectedNoteUuids: new Set(['note-1']) }))

    await expect(tools.call('reminders.clear', { uuid: 'note-1' })).resolves.toMatchObject({ ok: true, cleared: 1 })
    expect(notesController.clearNoteReminders).toHaveBeenCalledTimes(1)
    expect(replacementController.clearNoteReminders).not.toHaveBeenCalled()
    expect(deleteEmailReminderMock).toHaveBeenCalledWith(expect.objectContaining({ legacyApi }), 'email-first')
  })

  it('does not touch external ids when the initial local clear fails', async () => {
    const original = reminder('first', 'email-first')
    const { application, notesController, state } = makeReminderApplication([original])
    notesController.clearNoteReminders.mockRejectedValueOnce(new Error('local clear failed'))
    const tools = new AssistantTools(application, makeContext({ selectedNoteUuids: new Set(['note-1']) }))

    await expect(tools.call('reminders.clear', { uuid: 'note-1' })).rejects.toThrow('local clear failed')
    expect(deleteEmailReminderMock).not.toHaveBeenCalled()
    expect(state.reminders).toEqual([original])
  })

  it('restores exactly the reminders whose external deletion failed', async () => {
    const failed = reminder('failed', 'email-failed')
    const { application, mutator, state } = makeReminderApplication([
      reminder('deleted', 'email-deleted'),
      failed,
      reminder('local-only'),
    ])
    deleteEmailReminderMock.mockImplementation(async (_application, id) => id !== 'email-failed')
    const tools = new AssistantTools(application, makeContext({ selectedNoteUuids: new Set(['note-1']) }))

    await expect(tools.call('reminders.clear', { uuid: 'note-1' })).rejects.toThrow('state was restored')

    expect(mutator.changeItem).toHaveBeenCalledTimes(1)
    expect(state.reminders).toEqual([failed])
  })
})

describe('AssistantTools created-note provenance', () => {
  it('does not admit a created UUID when the principal changes before insert resolves', async () => {
    let sessionCurrent = true
    let createdNote: Record<string, unknown> | undefined
    const application = {
      items: {
        createTemplateItem: (_contentType: string, content: Record<string, unknown>) => ({
          uuid: 'created-note',
          content_type: ContentType.TYPES.Note,
          preview_plain: '',
          pinned: false,
          archived: false,
          starred: false,
          trashed: false,
          protected: false,
          ...content,
        }),
        findItem: (uuid: string) => (uuid === createdNote?.uuid ? createdNote : undefined),
        getItems: () => (createdNote ? [createdNote] : []),
        getSortedTagsForItem: () => [],
      },
      mutator: {
        insertItem: async (template: Record<string, unknown>) => {
          createdNote = template
          sessionCurrent = false
          return template
        },
      },
    } as unknown as WebApplication
    const tools = new AssistantTools(
      application,
      makeContext({ isSessionCurrent: () => sessionCurrent, selectedNoteUuids: new Set() }),
    )

    await expect(tools.call('notes.create', { title: 'New', text: 'Body' })).rejects.toMatchObject({
      name: 'AbortError',
    })
    sessionCurrent = true
    await expect(tools.call('notes.update', { uuid: 'created-note', text: 'Nope' })).rejects.toThrow(
      'outside the context',
    )
    await expect(tools.call('notes.update', { uuid: 'model-invented', text: 'Nope' })).rejects.toThrow(
      'outside the context',
    )
  })

  it('rejects an insert result whose identity differs from the application template', async () => {
    let returnedNote: Record<string, unknown> | undefined
    const application = {
      items: {
        createTemplateItem: (_contentType: string, content: Record<string, unknown>) => ({
          uuid: 'template-note',
          content_type: ContentType.TYPES.Note,
          ...content,
        }),
        findItem: (uuid: string) => (uuid === returnedNote?.uuid ? returnedNote : undefined),
      },
      mutator: {
        insertItem: async (template: Record<string, unknown>) => {
          returnedNote = { ...template, uuid: 'substituted-note' }
          return returnedNote
        },
      },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, makeContext({ selectedNoteUuids: new Set() }))

    await expect(tools.call('notes.create', { title: 'New', text: 'Body' })).rejects.toThrow(
      'did not match the application-issued template',
    )
    await expect(tools.call('notes.update', { uuid: 'substituted-note', text: 'Nope' })).rejects.toThrow(
      'outside the context',
    )
  })
})
