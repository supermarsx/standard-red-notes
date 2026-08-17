import { WebApplication } from '@/Application/WebApplication'
import { ContentType } from '@standardnotes/snjs'
import { AssistantToolConfirmation, describeAssistantToolConfirmation } from './assistantPresentation'
import { AssistantTools, AssistantToolContext } from './tools'

function makeContext(runSubAgent?: AssistantToolContext['runSubAgent']): AssistantToolContext {
  return {
    confirmBeforeWrite: false,
    requestConfirmation: async () => true,
    presentPane: () => {},
    runSubAgent,
  }
}

const fakeApp = {} as unknown as WebApplication

describe('AssistantTools delegate', () => {
  it('exposes the delegate tool at the top level when a sub-agent runner is provided', () => {
    const tools = new AssistantTools(
      fakeApp,
      makeContext(async () => 'ok'),
    )
    expect(tools.tools().some((t) => t.name === 'delegate')).toBe(true)
  })

  it('withholds delegate when no sub-agent runner is provided', () => {
    const tools = new AssistantTools(fakeApp, makeContext(undefined))
    expect(tools.tools().some((t) => t.name === 'delegate')).toBe(false)
  })

  it('withholds delegate from sub-agents (recursion guard) and rejects the call', async () => {
    const sub = new AssistantTools(
      fakeApp,
      makeContext(async () => 'ok'),
      false,
    )
    expect(sub.tools().some((t) => t.name === 'delegate')).toBe(false)
    await expect(sub.call('delegate', { task: 'x' })).rejects.toThrow('Unknown tool')
  })

  it('routes a delegate call to the sub-agent runner and returns its summary', async () => {
    const seen: Array<{ task: string; context?: string }> = []
    const runSubAgent = async (task: string, contextText?: string) => {
      seen.push({ task, context: contextText })
      return `handled: ${task}`
    }
    const tools = new AssistantTools(fakeApp, makeContext(runSubAgent))
    const result = await tools.call('delegate', { task: 'organize notes', context: 'uuid-1' })
    expect(result).toEqual({ ok: true, result: 'handled: organize notes' })
    expect(seen).toEqual([{ task: 'organize notes', context: 'uuid-1' }])
  })

  it('rejects a delegate call with no task', async () => {
    const tools = new AssistantTools(
      fakeApp,
      makeContext(async () => 'ok'),
    )
    await expect(tools.call('delegate', {})).rejects.toThrow('task')
  })
})

describe('AssistantTools todo.write', () => {
  it('replaces the list, drops empty items, and reports via onTodosChanged', async () => {
    let reported: unknown
    const ctx = { ...makeContext(), onTodosChanged: (todos: unknown) => (reported = todos) }
    const tools = new AssistantTools(fakeApp, ctx)
    const result = await tools.call('todo.write', {
      todos: [
        { content: 'Search notes', status: 'in_progress' },
        { content: '', status: 'pending' },
        { content: 'Summarize', status: 'pending' },
      ],
    })
    const expected = [
      { content: 'Search notes', status: 'in_progress' },
      { content: 'Summarize', status: 'pending' },
    ]
    expect(result).toEqual({ ok: true, todos: expected })
    expect(reported).toEqual(expected)
  })

  it('defaults an invalid status to pending', async () => {
    const tools = new AssistantTools(fakeApp, makeContext())
    const result = (await tools.call('todo.write', { todos: [{ content: 'X', status: 'bogus' }] })) as {
      todos: Array<{ status: string }>
    }
    expect(result.todos[0].status).toBe('pending')
  })
})

describe('AssistantTools notes.retrieve', () => {
  const appWithNotes = {
    items: {
      getItems: () => [
        { uuid: 'n1', title: 'Sourdough', text: 'feed the starter with flour and water', trashed: false },
        { uuid: 'n2', title: 'Taxes', text: 'quarterly deductions and receipts', trashed: false },
        { uuid: 'n3', title: 'Trashed', text: 'flour flour flour', trashed: true },
      ],
    },
  } as unknown as WebApplication

  it('returns relevance-ranked passages and excludes trashed notes', async () => {
    const tools = new AssistantTools(appWithNotes, makeContext())
    const result = (await tools.call('notes.retrieve', { query: 'sourdough starter flour' })) as {
      count: number
      results: Array<{ noteUuid: string }>
    }
    expect(result.count).toBeGreaterThan(0)
    expect(result.results[0].noteUuid).toBe('n1')
    expect(result.results.some((r) => r.noteUuid === 'n3')).toBe(false)
  })

  it('requires a query', async () => {
    const tools = new AssistantTools(appWithNotes, makeContext())
    await expect(tools.call('notes.retrieve', {})).rejects.toThrow('query')
  })
})

describe('AssistantTools runtime safety', () => {
  it('checks an abort signal before dispatching a tool', async () => {
    const controller = new AbortController()
    const runSubAgent = jest.fn(async () => 'should not run')
    controller.abort()
    const tools = new AssistantTools(fakeApp, {
      ...makeContext(runSubAgent),
      signal: controller.signal,
    })

    await expect(tools.call('delegate', { task: 'keep working' })).rejects.toMatchObject({ name: 'AbortError' })
    expect(runSubAgent).not.toHaveBeenCalled()
  })

  it('always asks inline before an external web disclosure and forwards the run signal', async () => {
    const controller = new AbortController()
    const requestConfirmation = jest.fn(async () => true)
    const serverJsonRequest = jest.fn(async () => ({ ok: true, status: 200, data: { results: [] } }))
    const application = { serverJsonRequest } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      ...makeContext(),
      signal: controller.signal,
      requestConfirmation,
      shouldRequestConfirmation: () => false,
    })

    await expect(tools.call('web.search', { query: 'public weather' })).resolves.toEqual({ results: [] })
    expect(requestConfirmation).toHaveBeenCalledWith(
      { name: 'web.search', args: { query: 'public weather' } },
      controller.signal,
    )
    expect(serverJsonRequest).toHaveBeenCalledWith(
      '/v1/web/search',
      { query: 'public weather', limit: 10 },
      controller.signal,
    )
  })

  it('rechecks cancellation after an inline decision before dispatching', async () => {
    const controller = new AbortController()
    const serverJsonRequest = jest.fn()
    const tools = new AssistantTools({ serverJsonRequest } as unknown as WebApplication, {
      ...makeContext(),
      signal: controller.signal,
      requestConfirmation: async () => {
        controller.abort()
        return true
      },
    })

    await expect(tools.call('web.fetch', { url: 'https://example.test' })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })

  it('rechecks the account principal after an inline decision before dispatching', async () => {
    let sessionCurrent = true
    const serverJsonRequest = jest.fn()
    const tools = new AssistantTools({ serverJsonRequest } as unknown as WebApplication, {
      ...makeContext(),
      isSessionCurrent: () => sessionCurrent,
      requestConfirmation: async () => {
        sessionCurrent = false
        return true
      },
    })

    await expect(tools.call('web.fetch', { url: 'https://example.test' }, 'call-a')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(serverJsonRequest).not.toHaveBeenCalled()
  })

  it('correlates policy authorization with the provider tool-call id', async () => {
    const onAuthorization = jest.fn()
    const tools = new AssistantTools(fakeApp, { ...makeContext(), onAuthorization })

    await tools.call('todo.write', { todos: [] }, 'policy-call')

    expect(onAuthorization).toHaveBeenCalledWith('policy-call', { decision: 'allow', source: 'policy' })
  })
})

describe('AssistantTools selected note scope', () => {
  const notes = [
    {
      uuid: 'private-note',
      content_type: ContentType.TYPES.Note,
      title: 'Private scope result',
      text: 'scope keyword private',
      preview_plain: 'private',
      trashed: false,
      archived: false,
    },
    {
      uuid: 'selected-note',
      content_type: ContentType.TYPES.Note,
      title: 'Selected scope result',
      text: 'scope keyword selected',
      preview_plain: 'selected',
      trashed: false,
      archived: false,
    },
  ]
  const application = {
    items: {
      getItems: () => notes,
      findItem: (uuid: string) => notes.find((note) => note.uuid === uuid),
      getSortedTagsForItem: () => [],
    },
  } as unknown as WebApplication

  it('filters list, search, and retrieval to the user-selected UUID allowlist', async () => {
    const tools = new AssistantTools(application, {
      ...makeContext(),
      selectedNoteUuids: new Set(['selected-note']),
    })

    const listed = (await tools.call('notes.list', {})) as { notes: Array<{ uuid: string }> }
    const searched = (await tools.call('notes.search', { query: 'scope result' })) as {
      notes: Array<{ uuid: string }>
    }
    const retrieved = (await tools.call('notes.retrieve', { query: 'scope keyword' })) as {
      results: Array<{ noteUuid: string }>
    }

    expect(listed.notes.map((note) => note.uuid)).toEqual(['selected-note'])
    expect(searched.notes.map((note) => note.uuid)).toEqual(['selected-note'])
    expect(retrieved.results.length).toBeGreaterThan(0)
    expect(retrieved.results.every((result) => result.noteUuid === 'selected-note')).toBe(true)
  })

  it('fails closed for direct reads outside the selected scope, including Super reads', async () => {
    const tools = new AssistantTools(application, {
      ...makeContext(),
      selectedNoteUuids: new Set(['selected-note']),
    })

    await expect(tools.call('notes.read', { uuid: 'private-note' })).rejects.toThrow('outside the context')
    await expect(tools.call('notes.readSuper', { uuid: 'private-note' })).rejects.toThrow('outside the context')
    await expect(tools.call('notes.read', { uuid: 'selected-note' })).resolves.toMatchObject({ uuid: 'selected-note' })
  })

  it('fails closed for updates, deletion, reminders, tags, and navigation outside the selected scope', async () => {
    const tools = new AssistantTools(application, {
      ...makeContext(),
      selectedNoteUuids: new Set(['selected-note']),
    })

    await expect(tools.call('notes.update', { uuid: 'private-note', text: 'changed' })).rejects.toThrow(
      'outside the context',
    )
    await expect(tools.call('notes.delete', { uuid: 'private-note' })).rejects.toThrow('outside the context')
    await expect(
      tools.call('reminders.set', { uuid: 'private-note', datetime: '2027-01-01T00:00:00Z' }),
    ).rejects.toThrow('outside the context')
    await expect(tools.call('tags.assign', { noteUuid: 'private-note', tagUuid: 'tag-1' })).rejects.toThrow(
      'outside the context',
    )
    await expect(tools.call('app.openNote', { uuid: 'private-note' })).rejects.toThrow('outside the context')
  })

  it('lists reminders only from notes in the selected scope', async () => {
    const reminderNotes = notes.map((note) => ({
      ...note,
      getAppDomainValue: () => [
        {
          id: `reminder-${note.uuid}`,
          dueAt: note.uuid === 'selected-note' ? '2027-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
          message: `${note.title} reminder`,
        },
      ],
    }))
    const scopedApplication = {
      items: {
        getItems: () => reminderNotes,
        findItem: (uuid: string) => reminderNotes.find((note) => note.uuid === uuid),
      },
    } as unknown as WebApplication
    const tools = new AssistantTools(scopedApplication, {
      ...makeContext(),
      selectedNoteUuids: new Set(['selected-note']),
    })

    const result = (await tools.call('reminders.list', {})) as {
      reminders: Array<{ noteUuid: string; message: string }>
    }
    expect(result.reminders).toEqual([
      expect.objectContaining({ noteUuid: 'selected-note', message: 'Selected scope result reminder' }),
    ])
    await expect(tools.call('reminders.list', { title: 'Private scope result' })).rejects.toThrow('No note found')
  })

  it('lists only tags attached to notes in the selected scope', async () => {
    const selectedTag = { uuid: 'selected-tag', title: 'Selected', content_type: ContentType.TYPES.Tag }
    const privateTag = { uuid: 'private-tag', title: 'Private', content_type: ContentType.TYPES.Tag }
    const scopedApplication = {
      items: {
        getItems: (contentType: string) => (contentType === ContentType.TYPES.Note ? notes : [selectedTag, privateTag]),
        findItem: (uuid: string) => notes.find((note) => note.uuid === uuid),
        getSortedTagsForItem: (note: { uuid: string }) =>
          note.uuid === 'selected-note' ? [selectedTag] : [privateTag],
        getTagLongTitle: (tag: { title: string }) => tag.title,
      },
    } as unknown as WebApplication
    const tools = new AssistantTools(scopedApplication, {
      ...makeContext(),
      selectedNoteUuids: new Set(['selected-note']),
    })

    await expect(tools.call('tags.list', {})).resolves.toEqual({
      count: 1,
      tags: [{ uuid: 'selected-tag', title: 'Selected', longTitle: 'Selected' }],
    })
  })

  it('treats an explicitly empty scope as permission to read no notes', async () => {
    const tools = new AssistantTools(application, {
      ...makeContext(),
      selectedNoteUuids: new Set(),
    })

    await expect(tools.call('notes.list', {})).resolves.toEqual({ count: 0, notes: [] })
    await expect(tools.call('notes.read', { uuid: 'selected-note' })).rejects.toThrow('outside the context')
  })

  it('admits only notes created successfully by this tool session for follow-up actions', async () => {
    const tag = { uuid: 'tag-created', title: 'Created', content_type: ContentType.TYPES.Tag }
    const createdNotes: Array<Record<string, unknown>> = []
    const openNote = jest.fn(async () => undefined)
    const addTagToNote = jest.fn(async () => undefined)
    const scopedApplication = {
      features: { getFeatureStatus: jest.fn() },
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
        findItem: (uuid: string) =>
          uuid === tag.uuid ? tag : createdNotes.find((candidate) => candidate.uuid === uuid),
        getItems: () => createdNotes,
        getSortedTagsForItem: () => [],
      },
      mutator: {
        insertItem: async (template: Record<string, unknown>) => {
          createdNotes.push(template)
          return template
        },
        changeItem: async (note: Record<string, unknown>, mutate: (value: Record<string, unknown>) => void) => {
          mutate(note)
          return note
        },
        addTagToNote,
      },
      itemListController: { openNote },
    } as unknown as WebApplication
    const tools = new AssistantTools(scopedApplication, {
      ...makeContext(),
      selectedNoteUuids: new Set(),
    })

    await expect(tools.call('notes.create', { title: 'New', text: 'Body' })).resolves.toMatchObject({
      ok: true,
      note: { uuid: 'created-note' },
    })
    await expect(tools.call('notes.update', { uuid: 'created-note', text: 'Updated' })).resolves.toMatchObject({
      ok: true,
    })
    await expect(tools.call('tags.assign', { noteUuid: 'created-note', tagUuid: tag.uuid })).resolves.toMatchObject({
      ok: true,
    })
    await expect(tools.call('app.openNote', { uuid: 'created-note' })).resolves.toMatchObject({ ok: true })
    expect(addTagToNote).toHaveBeenCalled()
    expect(openNote).toHaveBeenCalledWith('created-note')
    await expect(tools.call('notes.update', { uuid: 'model-invented', text: 'Nope' })).rejects.toThrow(
      'outside the context',
    )
  })
})

describe('AssistantTools trusted confirmation identity', () => {
  it('replaces model-supplied labels with a bounded trusted note title and short id', async () => {
    const note = {
      uuid: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      content_type: ContentType.TYPES.Note,
      title: `Trusted title ${'x'.repeat(200)}`,
      text: 'body must not be exposed',
    }
    const requestConfirmation = jest.fn(async (_request: AssistantToolConfirmation) => false)
    const application = {
      items: {
        findItem: () => note,
        getItems: () => [note],
      },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      ...makeContext(),
      confirmBeforeWrite: true,
      requestConfirmation,
    })

    await expect(
      tools.call('notes.delete', {
        uuid: note.uuid,
        targetTitle: 'Model-spoofed title',
        targetShortId: 'spoofed',
      }),
    ).resolves.toMatchObject({ cancelled: true })

    const request = requestConfirmation.mock.calls[0][0]
    expect(request.args).toMatchObject({
      uuid: note.uuid,
      targetTitle: note.title.slice(0, 120),
      targetShortId: '12345678',
    })
    expect(JSON.stringify(request)).not.toContain('body must not be exposed')
    expect(JSON.stringify(request)).not.toContain('Model-spoofed title')
    expect(describeAssistantToolConfirmation(request).fields).toEqual(
      expect.arrayContaining([
        { label: 'Target Title', value: note.title.slice(0, 120) },
        { label: 'Target Short Id', value: '12345678' },
      ]),
    )
  })

  it('shows trusted note and tag targets for reversible changes too', async () => {
    const note = {
      uuid: 'note-uuid-12345678',
      content_type: ContentType.TYPES.Note,
      title: 'Project note',
      text: 'private body',
    }
    const tag = {
      uuid: 'tag-uuid-87654321',
      content_type: ContentType.TYPES.Tag,
      title: 'Work',
    }
    const requestConfirmation = jest.fn(async (_request: AssistantToolConfirmation, _signal?: AbortSignal) => false)
    const application = {
      items: {
        findItem: (uuid: string) => (uuid === note.uuid ? note : uuid === tag.uuid ? tag : undefined),
        getItems: (contentType: string) => (contentType === ContentType.TYPES.Note ? [note] : [tag]),
      },
    } as unknown as WebApplication
    const tools = new AssistantTools(application, {
      ...makeContext(),
      confirmBeforeWrite: true,
      requestConfirmation,
      selectedNoteUuids: new Set([note.uuid]),
    })

    await expect(tools.call('tags.assign', { noteUuid: note.uuid, tagUuid: tag.uuid })).resolves.toMatchObject({
      cancelled: true,
    })
    expect(requestConfirmation).toHaveBeenCalledWith({
      name: 'tags.assign',
      args: expect.objectContaining({
        targetTitle: 'Project note',
        targetShortId: 'note-uui',
        targetTagTitle: 'Work',
        targetTagShortId: 'tag-uuid',
      }),
    })
    expect(JSON.stringify(requestConfirmation.mock.calls[0][0])).not.toContain('private body')
  })
})
