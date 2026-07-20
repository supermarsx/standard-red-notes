// MUST come first, exactly as in src/index.ts: snjs's published bundle reads the
// browser global `self` at module-evaluation time.
import '../src/polyfill.ts'

/**
 * Tests for src/NotesClient.ts — the note CRUD layer over a decrypted snjs
 * account.
 *
 * NotesClient already takes its HeadlessApp by constructor injection and only
 * ever touches `headless.app.items` / `headless.app.mutator`, so a stub app is
 * enough to drive every branch honestly. Nothing here fakes encryption: the
 * client contains no crypto, it hands plaintext to snjs's mutator, which is
 * what encrypts on sync. The authenticated end-to-end path is covered only by
 * the live-server tests, not here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import snjs from '@standardnotes/snjs'
import { NotesClient } from '../src/NotesClient.ts'

const { ContentType } = snjs as unknown as Record<string, any>

interface StubNote {
  uuid: string
  title?: string
  text?: string
  created_at?: unknown
  updated_at?: unknown
}

interface Recorder {
  created: { type: string; content: Record<string, unknown>; needsSync: unknown }[]
  taggedWith: { note: string; tag: string }[]
  createdTags: string[]
  deleted: string[]
  syncs: number
}

/** Build a stub HeadlessApp plus a recorder of everything the client asked for. */
function makeApp(notes: StubNote[], tags: { title: string }[] = []) {
  const recorder: Recorder = { created: [], taggedWith: [], createdTags: [], deleted: [], syncs: 0 }
  const noteTags = new Map<string, { title: string }[]>()
  let nextUuid = 0

  const app = {
    items: {
      getDisplayableNotes: () => notes,
      getDisplayableTags: () => tags,
      getSortedTagsForItem: (note: StubNote) => noteTags.get(note.uuid),
    },
    mutator: {
      createItem: (type: string, content: Record<string, unknown>, needsSync: unknown) => {
        recorder.created.push({ type, content, needsSync })
        const note: StubNote = {
          uuid: `created-${nextUuid++}`,
          title: content.title as string,
          text: content.text as string,
          created_at: new Date('2024-01-01T00:00:00.000Z'),
          updated_at: new Date(0),
        }
        notes.push(note)
        return note
      },
      createTagOrSmartView: (title: string) => {
        recorder.createdTags.push(title)
        const tag = { title }
        tags.push(tag)
        return tag
      },
      addTagToNote: (note: StubNote, tag: { title: string }) => {
        recorder.taggedWith.push({ note: note.uuid, tag: tag.title })
        noteTags.set(note.uuid, [...(noteTags.get(note.uuid) ?? []), tag])
      },
      changeItem: (note: StubNote, mutate: (m: StubNote) => void) => {
        mutate(note)
      },
      setItemToBeDeleted: (note: StubNote) => {
        recorder.deleted.push(note.uuid)
      },
    },
  }

  const headless = {
    app,
    sync: async () => {
      recorder.syncs++
    },
  } as unknown as ConstructorParameters<typeof NotesClient>[0]

  return { headless, recorder, noteTags }
}

function note(uuid: string, overrides: Partial<StubNote> = {}): StubNote {
  return {
    uuid,
    title: `title-${uuid}`,
    text: `text-${uuid}`,
    created_at: new Date('2024-01-01T00:00:00.000Z'),
    updated_at: new Date('2024-06-01T00:00:00.000Z'),
    ...overrides,
  }
}

// --- listNotes ---------------------------------------------------------------

test('listNotes syncs first, then returns newest-updated first', async () => {
  const { headless, recorder } = makeApp([
    note('old', { updated_at: new Date('2024-01-02T00:00:00.000Z') }),
    note('new', { updated_at: new Date('2024-09-09T00:00:00.000Z') }),
    note('mid', { updated_at: new Date('2024-05-05T00:00:00.000Z') }),
  ])
  const listed = await new NotesClient(headless).listNotes()
  assert.equal(recorder.syncs, 1, 'a stale local view would be a silent data-loss trap')
  assert.deepEqual(
    listed.map((n) => n.uuid),
    ['new', 'mid', 'old'],
  )
})

test('listNotes applies a positive limit and ignores a non-positive one', async () => {
  const notes = [note('a'), note('b'), note('c')]
  assert.equal((await new NotesClient(makeApp([...notes]).headless).listNotes(2)).length, 2)
  assert.equal((await new NotesClient(makeApp([...notes]).headless).listNotes(0)).length, 3)
  assert.equal((await new NotesClient(makeApp([...notes]).headless).listNotes(-1)).length, 3)
  assert.equal((await new NotesClient(makeApp([...notes]).headless).listNotes()).length, 3)
})

test('listNotes does not reorder the caller-visible note array in place', async () => {
  const notes = [note('a', { updated_at: new Date('2024-01-01T00:00:00.000Z') }), note('b')]
  const { headless } = makeApp(notes)
  await new NotesClient(headless).listNotes()
  assert.deepEqual(
    notes.map((n) => n.uuid),
    ['a', 'b'],
  )
})

test('an untitled note lists as an empty title rather than undefined', async () => {
  const { headless } = makeApp([note('a', { title: undefined })])
  const [listed] = await new NotesClient(headless).listNotes()
  assert.equal(listed.title, '')
})

test('a note whose updated_at is still epoch 0 falls back to created_at', async () => {
  // A just-created item reports updated_at as epoch 0 until the server stamps it.
  const { headless } = makeApp([
    note('fresh', { created_at: new Date('2024-03-03T00:00:00.000Z'), updated_at: new Date(0) }),
  ])
  const [listed] = await new NotesClient(headless).listNotes()
  assert.equal(listed.updatedAt, '2024-03-03T00:00:00.000Z')
})

test('string and numeric timestamps are normalised to ISO', async () => {
  const { headless } = makeApp([
    note('s', { updated_at: '2024-04-04T00:00:00.000Z' }),
    note('n', { updated_at: Date.parse('2024-04-05T00:00:00.000Z') }),
  ])
  const listed = await new NotesClient(headless).listNotes()
  const byUuid = Object.fromEntries(listed.map((n) => [n.uuid, n.updatedAt]))
  assert.equal(byUuid.s, '2024-04-04T00:00:00.000Z')
  assert.equal(byUuid.n, '2024-04-05T00:00:00.000Z')
})

test('an unusable created_at degrades to "now" rather than throwing', async () => {
  const before = Date.now()
  const { headless } = makeApp([note('x', { created_at: null, updated_at: new Date(0) })])
  const [listed] = await new NotesClient(headless).listNotes()
  assert.ok(Date.parse(listed.updatedAt) >= before)
})

// --- readNote ----------------------------------------------------------------

test('readNote returns the decrypted body and its tag titles', async () => {
  const target = note('a')
  const { headless, noteTags } = makeApp([target, note('b')])
  noteTags.set('a', [{ title: 'inbox' }, { title: 'ideas' }])
  const full = await new NotesClient(headless).readNote('a')
  assert.deepEqual(full, {
    uuid: 'a',
    title: 'title-a',
    text: 'text-a',
    tags: ['inbox', 'ideas'],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T00:00:00.000Z',
  })
})

test('readNote on an unknown uuid throws instead of returning an empty note', async () => {
  const { headless } = makeApp([note('a')])
  await assert.rejects(() => new NotesClient(headless).readNote('ghost'), /note not found: ghost/)
})

test('a string or numeric created_at is normalised to ISO', async () => {
  const { headless } = makeApp([
    note('s', { created_at: '2023-07-07T00:00:00.000Z' }),
    note('n', { created_at: Date.parse('2023-08-08T00:00:00.000Z') }),
  ])
  const client = new NotesClient(headless)
  assert.equal((await client.readNote('s')).createdAt, '2023-07-07T00:00:00.000Z')
  assert.equal((await client.readNote('n')).createdAt, '2023-08-08T00:00:00.000Z')
})

test('a note with no tags reads back as an empty tag list', async () => {
  const { headless } = makeApp([note('a')])
  assert.deepEqual((await new NotesClient(headless).readNote('a')).tags, [])
})

test('a note with empty title/text reads back as empty strings', async () => {
  const { headless } = makeApp([note('a', { title: undefined, text: undefined })])
  const full = await new NotesClient(headless).readNote('a')
  assert.equal(full.title, '')
  assert.equal(full.text, '')
})

// --- createNote --------------------------------------------------------------

test('createNote marks the item dirty so it is actually uploaded', async () => {
  const { headless, recorder } = makeApp([])
  const created = await new NotesClient(headless).createNote({ title: 'T', text: 'B', tags: [] })
  assert.equal(recorder.created.length, 1)
  assert.equal(recorder.created[0].type, ContentType.TYPES.Note)
  assert.equal(recorder.created[0].needsSync, true, 'without needsSync the note would stay local-only')
  assert.deepEqual(recorder.created[0].content, { title: 'T', text: 'B', references: [] })
  assert.equal(created.title, 'T')
  assert.equal(recorder.syncs, 1)
})

test('createNote reuses an existing tag and creates only the missing ones', async () => {
  const { headless, recorder } = makeApp([], [{ title: 'existing' }])
  await new NotesClient(headless).createNote({ title: 'T', text: '', tags: ['existing', 'brand-new'] })
  assert.deepEqual(recorder.createdTags, ['brand-new'])
  assert.deepEqual(
    recorder.taggedWith.map((t) => t.tag),
    ['existing', 'brand-new'],
  )
})

test('createNote with no tags never touches the tag machinery', async () => {
  const { headless, recorder } = makeApp([])
  await new NotesClient(headless).createNote({ title: 'T', text: '', tags: [] })
  assert.deepEqual(recorder.createdTags, [])
  assert.deepEqual(recorder.taggedWith, [])
})

// --- updateNote --------------------------------------------------------------

test('updateNote applies only the fields it was given', async () => {
  const target = note('a')
  const { headless } = makeApp([target])
  await new NotesClient(headless).updateNote('a', { title: 'new title' })
  assert.equal(target.title, 'new title')
  assert.equal(target.text, 'text-a', 'an omitted field must not be blanked')
})

test('updateNote can set a field to the empty string', async () => {
  const target = note('a')
  const { headless } = makeApp([target])
  await new NotesClient(headless).updateNote('a', { text: '' })
  assert.equal(target.text, '')
})

test('updateNote adds the requested tags and syncs once', async () => {
  const { headless, recorder } = makeApp([note('a')], [{ title: 'known' }])
  await new NotesClient(headless).updateNote('a', { tags: ['known', 'fresh'] })
  assert.deepEqual(recorder.createdTags, ['fresh'])
  assert.deepEqual(
    recorder.taggedWith.map((t) => t.tag),
    ['known', 'fresh'],
  )
  assert.equal(recorder.syncs, 1)
})

test('updateNote with no tags key leaves tagging alone', async () => {
  const { headless, recorder } = makeApp([note('a')])
  await new NotesClient(headless).updateNote('a', { title: 'x' })
  assert.deepEqual(recorder.taggedWith, [])
})

test('updateNote on an unknown uuid throws before mutating anything', async () => {
  const { headless, recorder } = makeApp([note('a')])
  await assert.rejects(() => new NotesClient(headless).updateNote('ghost', { title: 'x' }), /note not found: ghost/)
  assert.equal(recorder.syncs, 0)
})

// --- deleteNote --------------------------------------------------------------

test('deleteNote targets exactly the requested uuid and nothing else', async () => {
  const { headless, recorder } = makeApp([note('a'), note('b'), note('c')])
  await new NotesClient(headless).deleteNote('b')
  assert.deepEqual(recorder.deleted, ['b'])
  assert.equal(recorder.syncs, 1)
})

test('deleteNote on an unknown uuid deletes NOTHING and throws', async () => {
  const { headless, recorder } = makeApp([note('a')])
  await assert.rejects(() => new NotesClient(headless).deleteNote('ghost'), /note not found: ghost/)
  assert.deepEqual(recorder.deleted, [])
  assert.equal(recorder.syncs, 0)
})

// --- exportAll ---------------------------------------------------------------

test('exportAll syncs, returns full decrypted notes and is newest-first', async () => {
  const { headless, recorder, noteTags } = makeApp([
    note('old', { updated_at: new Date('2024-01-01T00:00:00.000Z') }),
    note('new', { updated_at: new Date('2024-12-01T00:00:00.000Z') }),
  ])
  noteTags.set('new', [{ title: 'inbox' }])
  const exported = await new NotesClient(headless).exportAll()
  assert.equal(recorder.syncs, 1)
  assert.deepEqual(
    exported.map((n) => n.uuid),
    ['new', 'old'],
  )
  assert.deepEqual(exported[0].tags, ['inbox'])
  assert.equal(exported[0].text, 'text-new')
})

test('exportAll on an empty account returns an empty array', async () => {
  const { headless } = makeApp([])
  assert.deepEqual(await new NotesClient(headless).exportAll(), [])
})
