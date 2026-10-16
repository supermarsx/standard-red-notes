/** @jest-environment jsdom */
import { $createTextNode, $getRoot, createEditor } from 'lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { ContentType, NoteType } from '@standardnotes/snjs'
import {
  $setChecklistPerPerson,
  $setChecklistPersonalTick,
} from '@/Components/SuperEditor/Checklist/checklistPersonalTicks'
import { $setChecklistTodoId } from '@/Components/SuperEditor/Lexical/Nodes/ChecklistItemNode'
import type { WebApplication } from '@/Application/WebApplication'
import { AssistantTools } from './tools'
import { checklistForPassage, projectNoteChecklist } from './noteChecklistContext'

jest.mock('@/Utils/Items/Search/doesItemMatchSearchQuery', () => ({ doesItemMatchSearchQuery: () => true }))

function lexicalFixture() {
  const editor = createEditor({
    namespace: 'assistant-checklist',
    nodes: [ListNode, ListItemNode],
    onError: (e) => {
      throw e
    },
  })
  editor.update(
    () => {
      const done = $createListItemNode(true).append($createTextNode('Release shipped'))
      const pending = $createListItemNode(false).append($createTextNode('Release pending'))
      const personal = $createListItemNode(false).append($createTextNode('Release acknowledgement'))
      $setChecklistTodoId(personal, 'task-personal')
      $setChecklistPerPerson(personal, true)
      $setChecklistPersonalTick(personal, 'peer', true)
      $getRoot().append(
        $createListNode('check').append(done, pending, personal),
        $createListNode('bullet').append($createListItemNode().append($createTextNode('Ordinary bullet'))),
      )
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

it('projects real serialized Lexical checked states and per-person ticks without claiming global completion', () => {
  const result = projectNoteChecklist(lexicalFixture(), NoteType.Super, 'self')
  expect(result.items).toEqual([
    { text: 'Release shipped', checked: true, completionMode: 'single' },
    { text: 'Release pending', checked: false, completionMode: 'single' },
    {
      text: 'Release acknowledgement',
      checked: null,
      completionMode: 'per-person',
      checkedBy: ['peer'],
      checkedByTruncated: false,
      checkedForCurrentUser: false,
      todoId: 'task-personal',
    },
  ])
  expect(result.text).toContain('[x] Release shipped')
  expect(result.text).toContain('[ ] Release pending')
  expect(result.text).toContain('[per-person] Release acknowledgement')
  expect(projectNoteChecklist(lexicalFixture(), NoteType.Super, 'peer').items[2].checkedForCurrentUser).toBe(true)
})

it('keeps Markdown checked markers and ignores fenced examples and ordinary lists', () => {
  const text = '- [x] Done\n- [ ] Pending\n* [X] Also done\n- Just a bullet\n```md\n- [x] Example\n```'
  const result = projectNoteChecklist(text)
  expect(result.text).toBe(text)
  expect(result.items.map(({ text, checked }) => ({ text, checked }))).toEqual([
    { text: 'Done', checked: true },
    { text: 'Pending', checked: false },
    { text: 'Also done', checked: true },
  ])
})

it('reads Advanced Checklist booleans strictly and marks missing/invalid completion unknown', () => {
  const result = projectNoteChecklist(
    JSON.stringify({
      groups: [
        {
          name: 'Work',
          tasks: [
            { description: 'Done', completed: true },
            { description: 'Pending', completed: false },
            { description: 'Unreported' },
            { description: 'Invalid', completed: 'true' },
          ],
        },
      ],
    }),
    NoteType.Task,
  )
  expect(result.items.map((item) => item.checked)).toEqual([true, false, null, null])
  expect(result.text).toContain('[?] Unreported')
  expect(
    projectNoteChecklist(JSON.stringify({ tasks: [{ description: 'Flat', completed: true }] }), NoteType.Task).items[0]
      .checked,
  ).toBe(true)
  expect(projectNoteChecklist('{broken', NoteType.Task).status).toBe('unknown')
  expect(projectNoteChecklist('{}', NoteType.Task).status).toBe('unknown')
})

it('reads inert HTML checkbox and Quill checklist state while retaining unknown-schema honesty', () => {
  const result = projectNoteChecklist(
    '<ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Pending</li></ul><ul data-checked="true"><li>Quill done</li></ul><script>do not include</script>',
    NoteType.RichText,
  )
  expect(result.items.map(({ text, checked }) => ({ text, checked }))).toEqual([
    { text: 'Done', checked: true },
    { text: 'Pending', checked: false },
    { text: 'Quill done', checked: true },
  ])
  expect(result.text).toContain('[x] Done')
  expect(result.text).not.toContain('do not include')
  expect(result.status).toBe('unknown')
  expect(projectNoteChecklist('- [x] Code example', NoteType.Code).items).toEqual([])
})

it('bounds malformed/oversized input and labels incomplete task collections honestly', () => {
  expect(projectNoteChecklist('x'.repeat(1_000_001), NoteType.Super)).toMatchObject({
    status: 'unknown',
    truncated: true,
    items: [],
  })
  const result = projectNoteChecklist(Array.from({ length: 201 }, (_, i) => `- [x] task${i}`).join('\n'))
  expect(result.items).toHaveLength(200)
  expect(result.truncated).toBe(true)
  expect(checklistForPassage(result, 'task0').items).toHaveLength(1)
})

it('adds read/search/retrieval states without exposing tasks outside snippets or authorized scope', async () => {
  const note = {
    uuid: 'note',
    title: 'Release tasks',
    text: lexicalFixture(),
    noteType: NoteType.Super,
    preview_plain: 'Release shipped',
    content_type: ContentType.TYPES.Note,
  }
  const hidden = { ...note, uuid: 'hidden', title: 'Private hidden', text: '- [x] Secret' }
  const locked = { ...note, uuid: 'locked', locked: true }
  const application = {
    sessions: { getUser: () => ({ uuid: 'self' }) },
    items: {
      getItems: () => [note, hidden, locked],
      findItem: (uuid: string) => [note, hidden, locked].find((n) => n.uuid === uuid),
      getSortedTagsForItem: () => [],
    },
    isAuthorizedToRenderItem: () => true,
  } as unknown as WebApplication
  const tools = new AssistantTools(application, {
    selectedNoteUuids: new Set(['note', 'locked']),
    confirmBeforeWrite: false,
    requestConfirmation: async () => true,
    presentPane: () => {},
  })
  const read = (await tools.call('notes.read', { uuid: 'note' })) as { checklist: { items: unknown[] } }
  expect(read.checklist.items).toHaveLength(3)
  const search = (await tools.call('notes.search', { query: 'Release' })) as {
    notes: { checklist: { items: { text: string; checked: boolean }[] } }[]
  }
  expect(search.notes).toHaveLength(1)
  expect(search.notes[0].checklist.items).toEqual([
    { text: 'Release shipped', checked: true, completionMode: 'single' },
  ])
  const retrieved = (await tools.call('notes.retrieve', { query: 'Release' })) as {
    results: { snippet: string; checklist: { items: { text: string }[] } }[]
  }
  expect(retrieved.results).toHaveLength(1)
  expect(retrieved.results[0].snippet).toContain('[x] Release shipped')
  expect(retrieved.results[0].snippet).not.toContain('"root"')
  for (const hit of retrieved.results) {
    expect(hit.checklist.items.every((item) => hit.snippet.includes(item.text))).toBe(true)
  }
  await expect(tools.call('notes.read', { uuid: 'hidden' })).rejects.toThrow('outside the context')
})
