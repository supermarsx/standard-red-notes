/**
 * @jest-environment jsdom
 *
 * What a client that has never heard of the stamp does to it, with the real note mutator such a
 * client runs: an older web, desktop or mobile build, the MCP server, the CLI. They all change a
 * note the same way -- copy its content, set the fields they know -- so the stamp, an app-data
 * entry none of them knows, travels along untouched. Each outcome has to be one this build can
 * live with:
 *
 *  - the body was changed: the stamp no longer describes it and is not read as a stamp;
 *  - the note was written again by a person (a rename, a RESTORE of an old revision): its
 *    modified date is no longer the stamp's own, and the stamp is not read as a stamp;
 *  - the note was touched without that (pinned, archived): the stamp still speaks for the last
 *    save of the body, and still says the truth about it;
 *  - the app data was dropped: there is no stamp.
 *
 * "Not read as a stamp" always means the same thing: the note is treated exactly as an unstamped
 * note always was.
 */
import {
  ConflictStrategy,
  ContentType,
  DecryptedPayload,
  FillItemContent,
  MutationType,
  NoteContent,
  NoteMutator,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import {
  COLLABORATION_REVISION_KEY,
  STAMP_SAVE_WINDOW_MS,
  carryCollaborationRevisionStamp,
  createCollaborationRevisionStamp,
  readCollaborationRevisionStamp,
  writeCollaborationRevisionStamp,
  type CollaborationRevisionStamp,
} from './CollaborationRevisionStamp'

const EPOCH = '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const BODY = '{"root":{"children":[{"text":"Alpha Beta"}]}}'
const TUESDAY = Date.UTC(2026, 9, 6, 9, 30)
const A_MINUTE = 60_000

type StoredContent = { text: string; title?: string; appData: Record<string, Record<string, unknown>> }

const noteOf = (content: NoteContent): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      { uuid: 'note-1', content_type: ContentType.TYPES.Note, content, ...PayloadTimestampDefaults() },
      PayloadSource.Constructor,
    ),
  )

const plainNote = (): SNNote => noteOf(FillItemContent<NoteContent>({ title: 'Minutes', text: BODY }))

/** Apply a change the way every client does, and return the content that would be encrypted and stored. */
const mutate = (
  note: SNNote,
  change: (mutator: NoteMutator) => void,
  type = MutationType.UpdateUserTimestamps,
): StoredContent => {
  const mutator = new NoteMutator(note, type)
  change(mutator)
  return JSON.parse(JSON.stringify(mutator.getResult().content)) as StoredContent
}

const stampFor = (text: string, at = Date.now()): CollaborationRevisionStamp =>
  createCollaborationRevisionStamp(
    EPOCH,
    {
      stateVector: new Map([
        [11, 40],
        [22, 9],
      ]),
      deleted: new Map([[22, [[2, 3]]]]),
    },
    text,
    at,
  ) as CollaborationRevisionStamp

/** The note as this build saved it from a live shared document, at the current (test) time. */
const saveFromLiveDocument = (): StoredContent =>
  mutate(plainNote(), (mutator) => {
    mutator.text = BODY
    writeCollaborationRevisionStamp(mutator, stampFor(BODY))
  })

beforeEach(() => {
  jest.useFakeTimers({ now: TUESDAY })
})

afterEach(() => {
  jest.useRealTimers()
})

describe('the stamp through the real note mutator', () => {
  it('is stored in the default app-data domain beside the body, and read back from the stored content', () => {
    const stored = saveFromLiveDocument()

    expect(stored.text).toBe(BODY)
    expect(stored.appData['org.standardnotes.sn'][COLLABORATION_REVISION_KEY]).toEqual(stampFor(BODY))
    // The mutation that wrote the stamp is the one that set the note's modified date.
    expect(stored.appData['org.standardnotes.sn'].client_updated_at).toBe(new Date(TUESDAY).toISOString())
    expect(readCollaborationRevisionStamp(stored)).toEqual(stampFor(BODY))
  })

  it('is read from the note in memory too, where the modified date is still a Date', () => {
    const mutator = new NoteMutator(plainNote(), MutationType.UpdateUserTimestamps)
    mutator.text = BODY
    writeCollaborationRevisionStamp(mutator, stampFor(BODY))

    expect(readCollaborationRevisionStamp(mutator.getResult().content)).toEqual(stampFor(BODY))
  })

  it('is removed by a save with no live document, leaving content equal to a note that never had one', () => {
    const never = mutate(plainNote(), (mutator) => {
      mutator.text = 'typed alone'
    })
    const removed = mutate(noteOf(saveFromLiveDocument() as unknown as NoteContent), (mutator) => {
      mutator.text = 'typed alone'
      writeCollaborationRevisionStamp(mutator, undefined)
    })

    expect(COLLABORATION_REVISION_KEY in removed.appData['org.standardnotes.sn']).toBe(false)
    expect(readCollaborationRevisionStamp(removed)).toBeUndefined()
    expect(removed).toEqual(never)
  })
})

describe('a note nobody is collaborating on', () => {
  /** The note as it sits in memory after a save, not yet through any JSON round trip. */
  const savedInMemory = (change: (mutator: NoteMutator) => void): SNNote => {
    const mutator = new NoteMutator(plainNote(), MutationType.UpdateUserTimestamps)
    change(mutator)
    return new SNNote(mutator.getResult())
  }

  it('is still byte-equal to the same body saved on another device, so the item layer makes no copy of it', () => {
    // Every save from the editor runs the stamp writer; with no live document it writes "no
    // stamp". That must leave an ordinary note indistinguishable from one saved by a device that
    // has never heard of stamps: equal content is what resolves a conflict between two devices
    // as "keep the server's" instead of a conflicted copy (calendar sync relies on exactly this).
    const here = savedInMemory((mutator) => {
      mutator.text = 'the same body on both devices'
      writeCollaborationRevisionStamp(mutator, undefined)
    })
    const there = savedInMemory((mutator) => {
      mutator.text = 'the same body on both devices'
    })
    // The writer leaves nothing behind that even reads as an entry.
    expect(readCollaborationRevisionStamp(here.payload.content)).toBeUndefined()
    expect(JSON.stringify(here.payload.content.appData)).not.toContain(COLLABORATION_REVISION_KEY)

    expect(here.strategyWhenConflictingWithItem(there)).toBe(ConflictStrategy.KeepApply)
    expect(there.strategyWhenConflictingWithItem(here)).toBe(ConflictStrategy.KeepApply)
  })
})

describe('a client that does not know the stamp', () => {
  it('carries it along when it changes the body, where it describes nothing and is not read as a stamp', () => {
    const stored = mutate(noteOf(saveFromLiveDocument() as unknown as NoteContent), (mutator) => {
      mutator.text = '{"root":{"children":[{"text":"rewritten by something else"}]}}'
    })

    // Kept, stale: this is the dangerous shape, a state vouching for a body it never described.
    expect(stored.appData['org.standardnotes.sn'][COLLABORATION_REVISION_KEY]).toEqual(stampFor(BODY))
    expect(readCollaborationRevisionStamp(stored)).toBeUndefined()
  })

  it('carries it along when it renames the note later, where it no longer speaks for the latest write', () => {
    const live = noteOf(saveFromLiveDocument() as unknown as NoteContent)
    jest.setSystemTime(TUESDAY + A_MINUTE)

    const renamed = mutate(live, (mutator) => {
      mutator.title = 'Minutes, corrected'
    })

    // Same body, same stamp: only the note's modified date says a person wrote it again.
    expect(renamed.text).toBe(BODY)
    expect(renamed.appData['org.standardnotes.sn'][COLLABORATION_REVISION_KEY]).toEqual(stampFor(BODY, TUESDAY))
    expect(readCollaborationRevisionStamp(renamed)).toBeUndefined()
  })

  it('leaves it readable when it pins the note, which is not a person writing the note again', () => {
    const live = noteOf(saveFromLiveDocument() as unknown as NoteContent)
    jest.setSystemTime(TUESDAY + A_MINUTE)

    const pinned = mutate(
      live,
      (mutator) => {
        mutator.pinned = true
      },
      MutationType.NoUpdateUserTimestamps,
    )

    expect(readCollaborationRevisionStamp(pinned)).toEqual(stampFor(BODY, TUESDAY))
  })

  it('leaves nothing to read when it writes the note without the app data it did not understand', () => {
    const { appData: _dropped, ...rest } = saveFromLiveDocument()

    expect(readCollaborationRevisionStamp(rest)).toBeUndefined()
    expect(readCollaborationRevisionStamp({ ...rest, appData: { 'org.standardnotes.sn': {} } })).toBeUndefined()
  })

  it('duplicates it into a copy of the note, where it still describes the same body', () => {
    // A duplicate, a conflicted copy, a restore-as-copy: the same content under another uuid.
    const copy = JSON.parse(JSON.stringify(noteOf(saveFromLiveDocument() as unknown as NoteContent).payload.content))

    expect(readCollaborationRevisionStamp(copy)).toEqual(stampFor(BODY))
  })
})

describe('an older build restores a revision from history while people are live in the note', () => {
  /**
   * Exactly what the restore of a build that predates the stamp does: the revision's whole
   * content is written back over the note by a user-modifying mutation, and nothing strips the
   * stamp the revision was saved with.
   */
  const restoreWithAnOlderBuild = (revisionContent: StoredContent, current: SNNote): StoredContent =>
    mutate(current, (mutator) => {
      mutator.setCustomContent(revisionContent as unknown as NoteContent)
    })

  it('puts the old body back WITH its stamp, which is then not read as a stamp', () => {
    // Tuesday: the note is saved from the live document. This is what history keeps.
    const tuesdaysRevision = saveFromLiveDocument()
    expect(readCollaborationRevisionStamp(tuesdaysRevision)).toEqual(stampFor(BODY, TUESDAY))

    // Thursday: people have typed on; someone on an older build restores Tuesday's revision.
    jest.setSystemTime(TUESDAY + 2 * 24 * 60 * A_MINUTE)
    const thursdaysNote = noteOf(
      mutate(noteOf(tuesdaysRevision as unknown as NoteContent), (mutator) => {
        mutator.text = '{"root":{"children":[{"text":"Alpha Beta and two more days of work"}]}}'
        writeCollaborationRevisionStamp(
          mutator,
          stampFor('{"root":{"children":[{"text":"Alpha Beta and two more days of work"}]}}'),
        )
      }) as unknown as NoteContent,
    )
    jest.setSystemTime(TUESDAY + 2 * 24 * 60 * A_MINUTE + A_MINUTE)
    const restored = restoreWithAnOlderBuild(tuesdaysRevision, thursdaysNote)

    // The dangerous shape: Tuesday's body, Tuesday's stamp, intact and matching each other. The
    // live document holds every operation in it, so read as a stamp it would be "an older state
    // of the document" and every editor would carry on over the restore without a trace.
    expect(restored.text).toBe(BODY)
    expect(restored.appData['org.standardnotes.sn'][COLLABORATION_REVISION_KEY]).toEqual(stampFor(BODY, TUESDAY))

    // What voids it is the one thing a restore cannot avoid changing: when a person last wrote
    // the note. The revision is treated as unstamped, and kept as a copy as it always was.
    expect(readCollaborationRevisionStamp(restored)).toBeUndefined()
  })

  it('is told from the original save by the modified date alone, to the edge of the allowance', () => {
    const revision = saveFromLiveDocument()
    const domain = revision.appData['org.standardnotes.sn']
    const writtenAgain = (millisecondsLater: number): StoredContent => ({
      ...revision,
      appData: {
        'org.standardnotes.sn': { ...domain, client_updated_at: new Date(TUESDAY + millisecondsLater).toISOString() },
      },
    })

    expect(readCollaborationRevisionStamp(writtenAgain(0))).toBeDefined()
    expect(readCollaborationRevisionStamp(writtenAgain(STAMP_SAVE_WINDOW_MS))).toBeDefined()
    expect(readCollaborationRevisionStamp(writtenAgain(STAMP_SAVE_WINDOW_MS + 1))).toBeUndefined()
    // A modified date BEFORE the stamp is not a save that wrote it either.
    expect(readCollaborationRevisionStamp(writtenAgain(-1))).toBeUndefined()
    expect(
      readCollaborationRevisionStamp({
        ...revision,
        appData: { 'org.standardnotes.sn': { ...domain, client_updated_at: undefined } },
      }),
    ).toBeUndefined()
    expect(
      readCollaborationRevisionStamp({
        ...revision,
        appData: { 'org.standardnotes.sn': { ...domain, client_updated_at: 'not a date' } },
      }),
    ).toBeUndefined()
  })
})

describe('this build renames a note that is open in a live document', () => {
  it('writes the same stamp again as of the rename, so the unchanged body stays vouched for', () => {
    const live = noteOf(saveFromLiveDocument() as unknown as NoteContent)
    jest.setSystemTime(TUESDAY + A_MINUTE)

    const renamed = mutate(live, (mutator) => {
      mutator.title = 'Minutes, corrected'
      carryCollaborationRevisionStamp(mutator, Date.now())
    })

    expect(renamed.title).toBe('Minutes, corrected')
    expect(readCollaborationRevisionStamp(renamed)).toEqual(stampFor(BODY, TUESDAY + A_MINUTE))
  })

  it('does not invent a stamp for a note that has none, or revive one that was already void', () => {
    const never = mutate(plainNote(), (mutator) => {
      mutator.title = 'Renamed'
      carryCollaborationRevisionStamp(mutator, Date.now())
    })
    expect(COLLABORATION_REVISION_KEY in never.appData['org.standardnotes.sn']).toBe(false)

    // An older build changed the body and left the stamp behind; then this build renames.
    const stale = noteOf(
      mutate(noteOf(saveFromLiveDocument() as unknown as NoteContent), (mutator) => {
        mutator.text = '{"root":{"children":[{"text":"rewritten by something else"}]}}'
      }) as unknown as NoteContent,
    )
    jest.setSystemTime(TUESDAY + A_MINUTE)
    const renamed = mutate(stale, (mutator) => {
      mutator.title = 'Renamed'
      carryCollaborationRevisionStamp(mutator, Date.now())
    })

    expect(renamed.appData['org.standardnotes.sn'][COLLABORATION_REVISION_KEY]).toEqual(stampFor(BODY, TUESDAY))
    expect(readCollaborationRevisionStamp(renamed)).toBeUndefined()
  })

  it('ignores a mutator that cannot say what it was opened on', () => {
    const written: unknown[] = []

    carryCollaborationRevisionStamp(
      { setAppDataItem: (_key: string, value: unknown) => written.push(value) },
      Date.now(),
    )

    expect(written).toEqual([])
  })
})
