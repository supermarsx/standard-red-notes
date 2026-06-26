import { createNoteWithContent } from '../../Utilities/Test/SpecUtils'
import { ItemCollection } from '../Collection/Item/ItemCollection'
import { SNNote } from '../../Syncable/Note/Note'
import { notesAndFilesMatchingOptions } from './DisplayOptionsToFilters'
import { NotesAndFilesDisplayOptions } from './DisplayOptions'

describe('item display options', () => {
  const collectionWithNotes = function (titles: (string | undefined)[] = [], bodies: string[] = []) {
    const collection = new ItemCollection()
    const notes: SNNote[] = []
    titles.forEach((title, index) => {
      notes.push(
        createNoteWithContent({
          title: title,
          text: bodies[index],
        }),
      )
    })
    collection.set(notes)
    return collection
  }

  it('string query title', () => {
    const query = 'foo'

    const options: NotesAndFilesDisplayOptions = {
      searchQuery: { query: query, includeProtectedNoteText: true },
    } as jest.Mocked<NotesAndFilesDisplayOptions>
    const collection = collectionWithNotes(['hello', 'fobar', 'foobar', 'foo'])
    expect(notesAndFilesMatchingOptions(options, collection.all() as SNNote[], collection)).toHaveLength(2)
  })

  it('string query text', async function () {
    const query = 'foo'
    const options: NotesAndFilesDisplayOptions = {
      searchQuery: { query: query, includeProtectedNoteText: true },
    } as jest.Mocked<NotesAndFilesDisplayOptions>
    const collection = collectionWithNotes(
      [undefined, undefined, undefined, undefined],
      ['hello', 'fobar', 'foobar', 'foo'],
    )
    expect(notesAndFilesMatchingOptions(options, collection.all() as SNNote[], collection)).toHaveLength(2)
  })

  it('string query title and text', async function () {
    const query = 'foo'
    const options: NotesAndFilesDisplayOptions = {
      searchQuery: { query: query, includeProtectedNoteText: true },
    } as jest.Mocked<NotesAndFilesDisplayOptions>
    const collection = collectionWithNotes(['hello', 'foobar'], ['foo', 'fobar'])
    expect(notesAndFilesMatchingOptions(options, collection.all() as SNNote[], collection)).toHaveLength(2)
  })

  it('matches a lazy-decrypt lite note (empty text) against its preview_plain', () => {
    // Standard Red Notes: with lazy-decrypt on, a cold "lite" note has text === ''
    // but preview_plain stays resident. The substring matcher should fall back to
    // the preview so the note still matches on preview terms with zero decrypt.
    const query = 'preview'
    const options: NotesAndFilesDisplayOptions = {
      searchQuery: { query, includeProtectedNoteText: true },
    } as jest.Mocked<NotesAndFilesDisplayOptions>

    const collection = new ItemCollection()
    const liteMatching = createNoteWithContent({
      title: 'cold note',
      text: '',
      preview_plain: 'this is the resident preview text',
    })
    const liteNonMatching = createNoteWithContent({
      title: 'other cold note',
      text: '',
      preview_plain: 'unrelated resident snippet',
    })
    collection.set([liteMatching, liteNonMatching])

    const results = notesAndFilesMatchingOptions(options, collection.all() as SNNote[], collection)
    expect(results).toHaveLength(1)
    expect((results[0] as SNNote).uuid).toBe(liteMatching.uuid)
  })

  it('falls back to preview_html (tags stripped) when text and preview_plain are empty', () => {
    const query = 'highlight'
    const options: NotesAndFilesDisplayOptions = {
      searchQuery: { query, includeProtectedNoteText: true },
    } as jest.Mocked<NotesAndFilesDisplayOptions>

    const collection = new ItemCollection()
    const note = createNoteWithContent({
      title: 'cold html note',
      text: '',
      preview_plain: '',
      preview_html: '<p>a <strong>highlight</strong> inside markup</p>',
    })
    collection.set([note])

    expect(notesAndFilesMatchingOptions(options, collection.all() as SNNote[], collection)).toHaveLength(1)
  })

  it('still matches full body when text is present (preview fallback unused / flag off)', () => {
    // Flag-off behavior: text is resident, so the full body is matched exactly as
    // before and the preview fallback is never consulted.
    const query = 'body'
    const options: NotesAndFilesDisplayOptions = {
      searchQuery: { query, includeProtectedNoteText: true },
    } as jest.Mocked<NotesAndFilesDisplayOptions>

    const collection = new ItemCollection()
    const note = createNoteWithContent({
      title: 'warm note',
      text: 'full decrypted body here',
      preview_plain: 'unrelated preview snippet',
    })
    collection.set([note])

    expect(notesAndFilesMatchingOptions(options, collection.all() as SNNote[], collection)).toHaveLength(1)
  })
})
