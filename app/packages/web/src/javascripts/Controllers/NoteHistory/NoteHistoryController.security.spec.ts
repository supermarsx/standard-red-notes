import { Deferred, Result, RevisionMetadata, SNNote } from '@standardnotes/snjs'
import { NoteHistoryController } from './NoteHistoryController'

describe('NoteHistoryController security teardown', () => {
  it('scrubs every plaintext holder and rejects late async revision repopulation', async () => {
    const listRevisions = Deferred<Result<RevisionMetadata[]>>()
    const getRevision = Deferred<Result<unknown>>()
    const note = {
      uuid: 'vault-note',
      content: { title: 'secret title', text: 'secret body' },
      key_system_identifier: 'vault-key-system',
    } as SNNote
    const controller = new NoteHistoryController(
      note,
      {} as never,
      { hasMinimumRole: jest.fn().mockReturnValue(true) } as never,
      { findItem: jest.fn().mockReturnValue(note) } as never,
      {} as never,
      { sync: jest.fn() } as never,
      {
        getExtensions: jest.fn().mockReturnValue([]),
        loadExtensionInContextOfItem: jest.fn(),
      } as never,
      { sessionHistoryForItem: jest.fn().mockReturnValue([]) } as never,
      {} as never,
      { execute: jest.fn().mockReturnValue(getRevision.promise) } as never,
      { execute: jest.fn().mockReturnValue(listRevisions.promise) } as never,
      {} as never,
      {} as never,
    )
    const revisionEntry = {
      uuid: 'revision-1',
      required_role: 'core-user',
    } as RevisionMetadata
    const selectRevision = controller.selectRemoteRevision(revisionEntry)

    controller.sessionHistory = [{ title: 'session', entries: [{ payload: { content: note.content } }] }] as never
    controller.legacyHistory = [{ subactions: [{ url: 'secret-url' }] }] as never
    controller.comparisonContent = note.content
    controller.deinit()

    expect((controller as unknown as { note?: SNNote }).note).toBeUndefined()
    expect(controller.remoteHistory).toEqual([])
    expect(controller.sessionHistory).toEqual([])
    expect(controller.legacyHistory).toEqual([])
    expect(controller.selectedEntry).toBeUndefined()
    expect(controller.selectedRevision).toBeUndefined()
    expect(controller.comparisonContent).toBeUndefined()

    getRevision.resolve(
      Result.ok({
        payload: { uuid: note.uuid, content: { title: 'late secret', text: 'must not return' } },
      }),
    )
    listRevisions.resolve(Result.ok([revisionEntry]))
    await selectRevision
    await Promise.resolve()
    await Promise.resolve()

    expect(controller.remoteHistory).toEqual([])
    expect(controller.selectedEntry).toBeUndefined()
    expect(controller.selectedRevision).toBeUndefined()
    expect(controller.comparisonContent).toBeUndefined()
  })
})
