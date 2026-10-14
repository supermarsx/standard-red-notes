import { NoteMutator } from './NoteMutator'
import { createNote } from './../../Utilities/Test/SpecUtils'
import { MutationType, AppDataField } from '../../Abstract/Item'
import { DecryptedPayload, PayloadSource } from '../../Abstract/Payload'
import { NativeFeatureIdentifier, NoteType } from '@standardnotes/features'
import { SNNote } from './Note'

describe('note mutator', () => {
  it('records actual trash age even when preserving user timestamps, without resetting an existing trash date', () => {
    const began = Date.now()
    const note = createNote({
      text: 'Old note',
      appData: { 'org.standardnotes.sn': { [AppDataField.UserModifiedDate]: '2020-01-01T00:00:00Z' } },
    })
    const mutator = new NoteMutator(note, MutationType.NoUpdateUserTimestamps)
    mutator.trashed = true
    const trashed = new SNNote(mutator.getResult())
    expect(Date.parse(trashed.content.trashed_at!)).toBeGreaterThanOrEqual(began)
    expect(Date.parse(trashed.content.trashed_at!)).toBeLessThanOrEqual(Date.now())
    expect(trashed.userModifiedDate).toEqual(note.userModifiedDate)
    const repeated = new NoteMutator(trashed, MutationType.NoUpdateUserTimestamps)
    repeated.trashed = true
    expect(repeated.getResult().content.trashed_at).toBe(trashed.content.trashed_at)
    repeated.trashed = false
    expect(repeated.getResult().content.trashed_at).toBeUndefined()
    repeated.trashed = true
    expect(Date.parse(repeated.getResult().content.trashed_at!)).toBeGreaterThanOrEqual(
      Date.parse(trashed.content.trashed_at!),
    )
  })

  it('preserves unknown age when an already trashed legacy note is marked trashed again', () => {
    const mutator = new NoteMutator(createNote({ trashed: true }), MutationType.NoUpdateUserTimestamps)
    mutator.trashed = true
    expect(mutator.getResult().content.trashed_at).toBeUndefined()
  })
  it('sets noteType', () => {
    const note = createNote({})
    const mutator = new NoteMutator(note, MutationType.NoUpdateUserTimestamps)
    mutator.noteType = NoteType.Authentication
    const result = mutator.getResult()

    expect(result.content.noteType).toEqual(NoteType.Authentication)
  })

  it('sets componentIdentifier', () => {
    const note = createNote({})
    const mutator = new NoteMutator(note, MutationType.NoUpdateUserTimestamps)
    mutator.editorIdentifier = NativeFeatureIdentifier.TYPES.DeprecatedMarkdownProEditor
    const result = mutator.getResult()

    expect(result.content.editorIdentifier).toEqual(NativeFeatureIdentifier.TYPES.DeprecatedMarkdownProEditor)
  })

  describe('local-only', () => {
    it('can be enabled before the note has ever synced', () => {
      const note = createNote({})
      const mutator = new NoteMutator(note, MutationType.NoUpdateUserTimestamps)

      mutator.localOnly = true

      expect(new SNNote(mutator.getResult()).localOnly).toBe(true)
    })

    it('rejects newly enabling local-only after the note has synced', () => {
      const note = createNote({})
      const syncedNote = new SNNote(
        new DecryptedPayload(
          {
            ...note.payloadRepresentation().ejected(),
            updated_at: new Date('2026-01-01T00:00:00.000Z'),
            updated_at_timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
          },
          PayloadSource.Constructor,
        ),
      )
      const mutator = new NoteMutator(syncedNote, MutationType.NoUpdateUserTimestamps)

      expect(() => {
        mutator.localOnly = true
      }).toThrow('Local-only can only be enabled before an item has ever been synced.')
    })

    it('allows legacy local-only notes to remain local-only or return to sync', () => {
      const localOnlyNote = createNote({
        appData: {
          'org.standardnotes.sn': {
            localOnly: true,
          },
        },
      })
      const syncedLocalOnlyNote = new SNNote(
        new DecryptedPayload(
          {
            ...localOnlyNote.payloadRepresentation().ejected(),
            updated_at: new Date('2026-01-01T00:00:00.000Z'),
            updated_at_timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
          },
          PayloadSource.Constructor,
        ),
      )

      const keepMutator = new NoteMutator(syncedLocalOnlyNote, MutationType.NoUpdateUserTimestamps)
      expect(() => {
        keepMutator.localOnly = true
      }).not.toThrow()

      const syncMutator = new NoteMutator(syncedLocalOnlyNote, MutationType.NoUpdateUserTimestamps)
      syncMutator.localOnly = false
      expect(new SNNote(syncMutator.getResult()).localOnly).toBe(false)
    })
  })
})
