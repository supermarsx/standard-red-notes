import { Deferred, Result, RevisionMetadata, SNNote } from '@standardnotes/snjs'
import { NoteHistoryController } from './NoteHistoryController'

describe('NoteHistoryController security teardown', () => {
  it('loads and compares existing revisions carrying legacy premium-role metadata', async () => {
    const note = { uuid: 'owned-note', content: { title: 'Today', text: 'Current body' } } as SNNote
    const revision = { payload: { uuid: note.uuid, content: { title: 'Earlier', text: 'Saved body' } } }
    const getRevision = { execute: jest.fn().mockResolvedValue(Result.ok(revision)) }
    const controller = new NoteHistoryController(
      note,
      {} as never,
      { findItem: () => note } as never,
      {} as never,
      { sync: jest.fn() } as never,
      { getExtensions: () => [], loadExtensionInContextOfItem: jest.fn() } as never,
      { sessionHistoryForItem: () => [] } as never,
      {} as never,
      getRevision as never,
      { execute: jest.fn().mockResolvedValue(Result.ok([])) } as never,
      {} as never,
      {} as never,
    )
    await controller.selectRemoteRevision({ uuid: 'older-revision', required_role: 'pro-user' } as RevisionMetadata)
    expect(getRevision.execute).toHaveBeenCalledWith({ itemUuid: note.uuid, revisionUuid: 'older-revision' })
    expect(controller.selectedRevision?.payload.content).toEqual(revision.payload.content)
    await controller.fetchRemoteHistory()
    const selected = { uuid: 'older-revision', required_role: 'pro-user' } as RevisionMetadata
    const previous = { uuid: 'previous-revision', required_role: 'pro-user' } as RevisionMetadata
    controller.setRemoteHistory([{ title: 'Saved', entries: [selected, previous] }] as never)
    controller.setSelectedEntry(selected)
    controller.setCompareTarget('previous')
    const previousContent = { title: 'Earlier still', text: 'The preceding saved body' }
    getRevision.execute.mockResolvedValueOnce(Result.ok({ payload: { uuid: note.uuid, content: previousContent } }))
    await controller.refreshComparisonContent()
    expect(getRevision.execute).toHaveBeenLastCalledWith({ itemUuid: note.uuid, revisionUuid: previous.uuid })
    expect(controller.comparisonContent).toEqual(previousContent)
    controller.deinit()
  })

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
