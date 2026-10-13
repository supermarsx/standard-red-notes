/**
 * @jest-environment jsdom
 *
 * Restoring a revision from history writes that revision's whole content back over the note. A
 * revision saved from a live shared document carries the stamp that says which state of the
 * document its body is, and an editor that holds the document treats a stamped body it already
 * contains as nothing new: it carries on over it. That is right for a save that lost a race and
 * wrong for a restore, which is a decision to go back. The restore therefore writes the body
 * WITHOUT the stamp, and is handled by everyone exactly as it was before stamps existed.
 */
import {
  ContentType,
  DecryptedPayload,
  FillItemContent,
  MutationType,
  NoteContent,
  NoteMutator,
  PayloadEmitSource,
  PayloadSource,
  PayloadTimestampDefaults,
  Result,
  SNNote,
} from '@standardnotes/snjs'
import {
  COLLABORATION_REVISION_KEY,
  createCollaborationRevisionStamp,
  readCollaborationRevisionStamp,
} from '@/Components/SuperEditor/Collaboration/CollaborationRevisionStamp'
import { NoteHistoryController } from './NoteHistoryController'

jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: () => Promise.resolve(true),
}))

const OLD_BODY = '{"root":{"children":[{"text":"what the note said on Tuesday"}]}}'

const note = (content: Partial<NoteContent>): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid: 'note-1',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'Minutes', text: 'what it says today', ...content }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

describe('restoring a revision that was saved from a live shared document', () => {
  it('writes the old body back without the stamp it was saved with', async () => {
    const tuesday = Date.UTC(2026, 9, 6, 9, 30)
    const stamp = createCollaborationRevisionStamp(
      'epoch-of-tuesday',
      { stateVector: new Map([[7, 31]]), deleted: new Map([[7, [[3, 2]]]]) },
      OLD_BODY,
      tuesday,
    )
    const revisionContent = FillItemContent<NoteContent>({
      title: 'Minutes',
      text: OLD_BODY,
      appData: {
        'org.standardnotes.sn': { [COLLABORATION_REVISION_KEY]: stamp, client_updated_at: new Date(tuesday) },
      },
    } as never)
    // Precondition: as it sits in history, the revision IS stamped, and validly.
    expect(readCollaborationRevisionStamp(JSON.parse(JSON.stringify(revisionContent)))).toEqual(stamp)

    const current = note({})
    const changeAndSave = { execute: jest.fn() }
    const controller = new NoteHistoryController(
      current,
      {} as never,
      { hasMinimumRole: jest.fn().mockReturnValue(true) } as never,
      { findItem: jest.fn().mockReturnValue(current) } as never,
      {} as never,
      { sync: jest.fn() } as never,
      { getExtensions: jest.fn().mockReturnValue([]), loadExtensionInContextOfItem: jest.fn() } as never,
      { sessionHistoryForItem: jest.fn().mockReturnValue([]) } as never,
      { alert: jest.fn() } as never,
      { execute: jest.fn() } as never,
      { execute: jest.fn().mockResolvedValue(Result.ok([])) } as never,
      {} as never,
      changeAndSave as never,
    )

    await controller.restoreRevision({ payload: { uuid: current.uuid, content: revisionContent } } as never)

    expect(changeAndSave.execute).toHaveBeenCalledTimes(1)
    const [target, mutate, updateTimestamps, source] = changeAndSave.execute.mock.calls[0] as [
      SNNote,
      (mutator: NoteMutator) => void,
      boolean,
      PayloadEmitSource,
    ]
    expect(target).toBe(current)
    expect(updateTimestamps).toBe(true)
    expect(source).toBe(PayloadEmitSource.RemoteRetrieved)

    // Run the mutation with the real mutator and look at what would be stored.
    const mutator = new NoteMutator(current, MutationType.UpdateUserTimestamps)
    mutate(mutator)
    const restored = JSON.parse(JSON.stringify(mutator.getResult().content)) as {
      text: string
      appData: Record<string, Record<string, unknown>>
    }

    expect(restored.text).toBe(OLD_BODY)
    expect(COLLABORATION_REVISION_KEY in restored.appData['org.standardnotes.sn']).toBe(false)
    expect(readCollaborationRevisionStamp(restored)).toBeUndefined()
  })
})
