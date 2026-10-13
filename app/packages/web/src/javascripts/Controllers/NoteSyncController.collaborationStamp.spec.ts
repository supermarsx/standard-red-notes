/**
 * @jest-environment jsdom
 *
 * A collaboration stamp is read only while the note's modified date is the stamp's own. A save
 * that changes something other than the body -- a rename, made through this controller -- moves
 * that date, and would void a stamp that still describes the untouched body. The controller
 * therefore writes the stamp again as of that save; and only then.
 */
import {
  AlertService,
  ContentType,
  DecryptedPayload,
  FillItemContent,
  ItemManagerInterface,
  MutationType,
  MutatorClientInterface,
  NoteContent,
  NoteMutator,
  PayloadSource,
  PayloadTimestampDefaults,
  Result,
  SessionsClientInterface,
  SNNote,
  SyncServiceInterface,
} from '@standardnotes/snjs'
import { IsNativeMobileWeb } from '@standardnotes/ui-services'
import {
  COLLABORATION_REVISION_KEY,
  createCollaborationRevisionStamp,
  readCollaborationRevisionStamp,
  writeCollaborationRevisionStamp,
  type CollaborationRevisionStamp,
} from '@/Components/SuperEditor/Collaboration/CollaborationRevisionStamp'
import { NoteSyncController, type NoteSaveFunctionParams } from './NoteSyncController'

const TUESDAY = Date.UTC(2026, 9, 6, 9, 30)
const A_MINUTE = 60_000
const BODY = '{"root":{"children":[{"text":"Alpha Beta"}]}}'

const stampFor = (at: number): CollaborationRevisionStamp =>
  createCollaborationRevisionStamp(
    'epoch',
    { stateVector: new Map([[11, 40]]), deleted: new Map([[11, [[3, 2]]]]) },
    BODY,
    at,
  ) as CollaborationRevisionStamp

const noteOf = (content: NoteContent): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      { uuid: 'note-1', content_type: ContentType.TYPES.Note, content, ...PayloadTimestampDefaults() },
      PayloadSource.Constructor,
    ),
  )

/**
 * The note as the collaborative editor saved it from a live document on Tuesday, written out as
 * it is stored: the stamp, and the modified date of that same save.
 */
const stampedNote = (): SNNote =>
  noteOf(
    FillItemContent<NoteContent>({
      title: 'Minutes',
      text: BODY,
      appData: {
        'org.standardnotes.sn': {
          [COLLABORATION_REVISION_KEY]: stampFor(TUESDAY),
          client_updated_at: new Date(TUESDAY).toISOString(),
        },
      },
    } as never),
  )

describe('NoteSyncController and the collaboration stamp', () => {
  let note: SNNote
  let changeItem: jest.Mock
  let controller: NoteSyncController

  /** Run one save through the controller and return what it would store. */
  const saved = async (params: NoteSaveFunctionParams): Promise<Record<string, unknown>> => {
    void controller.saveAndAwaitLocalPropagation({ ...params, bypassDebouncer: true })
    jest.runOnlyPendingTimers()
    await Promise.resolve()
    expect(changeItem).toHaveBeenCalledTimes(1)
    const [, mutate, type] = changeItem.mock.calls[0] as [SNNote, (mutator: NoteMutator) => void, MutationType]
    const mutator = new NoteMutator(note, type)
    mutate(mutator)
    return JSON.parse(JSON.stringify(mutator.getResult().content)) as Record<string, unknown>
  }

  beforeEach(() => {
    // Built before the clock is faked: the item layer freezes a payload on a timer, and a Date
    // made by the faked clock cannot be frozen.
    note = stampedNote()
    jest.useFakeTimers({ now: TUESDAY })
    changeItem = jest.fn().mockResolvedValue(undefined)
    controller = new NoteSyncController(
      note,
      {
        findItem: jest.fn().mockReturnValue(note),
        getItems: jest.fn().mockReturnValue([]),
      } as unknown as ItemManagerInterface,
      { changeItem } as unknown as MutatorClientInterface,
      {
        isSignedOut: jest.fn().mockReturnValue(false),
        isSignedIn: jest.fn().mockReturnValue(true),
      } as unknown as SessionsClientInterface,
      { sync: jest.fn().mockResolvedValue(undefined) } as unknown as SyncServiceInterface,
      { alert: jest.fn().mockResolvedValue(undefined) } as unknown as AlertService,
      { execute: jest.fn().mockReturnValue(Result.ok(false)) } as unknown as IsNativeMobileWeb,
    )
    // Precondition: as saved, the note is validly stamped.
    expect(readCollaborationRevisionStamp(note.payload.content)).toEqual(stampFor(TUESDAY))
    jest.setSystemTime(TUESDAY + A_MINUTE)
  })

  afterEach(() => {
    controller.deinit()
    jest.useRealTimers()
  })

  it('keeps the stamp speaking for the body across a rename, as of the rename', async () => {
    const stored = await saved({ title: 'Minutes, corrected', isUserModified: true })

    expect(stored.title).toBe('Minutes, corrected')
    expect(stored.text).toBe(BODY)
    // As of the save itself, which the controller makes a debounce after it was asked for.
    expect(Date.now()).toBeGreaterThanOrEqual(TUESDAY + A_MINUTE)
    expect(readCollaborationRevisionStamp(stored)).toEqual(stampFor(Date.now()))
  })

  it('does not re-date the stamp on a save that does not move the modified date', async () => {
    // Otherwise the stamp would be from AFTER the last time a person wrote the note, which
    // describes no save and is not read.
    const stored = await saved({ title: 'Minutes, corrected', isUserModified: false })

    expect(readCollaborationRevisionStamp(stored)).toEqual(stampFor(TUESDAY))
  })

  it('removes the stamp from a save of the body that brings none of its own', async () => {
    // A save from an editor with no live document behind it: the plain editor, an import, the
    // collaborative editor after the room was lost.
    const stored = (await saved({
      text: '{"root":{"children":[{"text":"another body"}]}}',
      isUserModified: true,
    })) as { appData: Record<string, Record<string, unknown>> }

    // Not left behind, stale: a stamp of a long session is tens of kilobytes that would
    // otherwise ride along in the note for good.
    expect(COLLABORATION_REVISION_KEY in stored.appData['org.standardnotes.sn']).toBe(false)
    expect(readCollaborationRevisionStamp(stored)).toBeUndefined()
  })

  it('lets the mutation of the editor that serialized the body write the stamp for it', async () => {
    const newBody = '{"root":{"children":[{"text":"another body"}]}}'
    const fresh = (at: number) =>
      createCollaborationRevisionStamp('epoch', { stateVector: new Map([[11, 52]]), deleted: new Map() }, newBody, at)

    const stored = await saved({
      text: newBody,
      isUserModified: true,
      customMutate: (mutator) => writeCollaborationRevisionStamp(mutator, fresh(Date.now())),
    })

    expect(readCollaborationRevisionStamp(stored)).toEqual(fresh(Date.now()))
  })
})
