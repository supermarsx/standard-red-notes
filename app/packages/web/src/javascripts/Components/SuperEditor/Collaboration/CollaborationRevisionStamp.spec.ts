/**
 * @jest-environment node
 */
import * as Y from 'yjs'
import {
  COLLABORATION_REVISION_KEY,
  MAX_STAMP_CLIENTS,
  MAX_STAMP_DELETED_RUNS,
  STAMP_SAVE_WINDOW_MS,
  createCollaborationRevisionStamp,
  documentStateCovers,
  fingerprintText,
  readCollaborationRevisionStamp,
  removeCollaborationRevisionStamp,
  writeCollaborationRevisionStamp,
  type CollaborationRevisionStamp,
  type CollaborativeDocumentState,
} from './CollaborationRevisionStamp'
import { documentStateOf } from './CollaborativeDocumentRegistry'

const EPOCH = 'room_epoch_0000000000000001'
/** When the save that wrote a stamp was made; the note's own modified date of that save. */
const AT = Date.UTC(2026, 9, 6, 9, 30)

/** A stamp written at AT. */
const stampOf = (epoch: string, documentState: CollaborativeDocumentState, text: string) =>
  createCollaborationRevisionStamp(epoch, documentState, text, AT)

/** A document with its own client id, the way two people's editors each hold one. */
function documentOf(clientId: number): Y.Doc {
  const document = new Y.Doc()
  document.clientID = clientId
  return document
}

const type = (document: Y.Doc, text: string): void => {
  const body = document.getText('body')
  body.insert(body.length, text)
}

const erase = (document: Y.Doc, text: string): void => {
  const body = document.getText('body')
  const index = body.toString().indexOf(text)
  expect(index).toBeGreaterThanOrEqual(0)
  body.delete(index, text.length)
}

const bodyOf = (document: Y.Doc): string => document.getText('body').toString()

/** Deliver everything `from` holds to `to`, as the relay does. */
const relay = (from: Y.Doc, to: Y.Doc): void => Y.applyUpdate(to, Y.encodeStateAsUpdate(from))

/** A document state written out by hand. */
const state = (
  vector: Array<[number, number]>,
  deleted: Array<[number, Array<[number, number]>]> = [],
): CollaborativeDocumentState => ({ stateVector: new Map(vector), deleted: new Map(deleted) })

/** The note content a save writes: the body, and the stamp in the default app-data domain. */
const contentWith = (text: string, stamp: unknown, modifiedAt: unknown = new Date(AT).toISOString()) => ({
  text,
  appData: { 'org.standardnotes.sn': { [COLLABORATION_REVISION_KEY]: stamp, client_updated_at: modifiedAt } },
})

describe('a stamp tells an older state of the same document from anything else', () => {
  it('is covered by a document that has received everything the stamped body was serialized from', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'Alpha ')
    relay(alice, bob)
    type(bob, 'Beta ')
    relay(bob, alice)

    // Alice saves here. Bob then types more: his document is AHEAD of her stored revision.
    const stamp = stampOf(EPOCH, documentStateOf(alice), 'Alpha Beta ')
    type(bob, 'Gamma')

    expect(stamp).toEqual({
      v: 1,
      epoch: EPOCH,
      sv: [
        [1, 6],
        [2, 5],
      ],
      ds: [],
      text: fingerprintText('Alpha Beta '),
      at: AT,
    })
    expect(documentStateCovers(documentStateOf(bob), stamp!)).toBe(true)
    // And of course the document it came from covers it.
    expect(documentStateCovers(documentStateOf(alice), stamp!)).toBe(true)
  })

  it('is NOT covered while even one operation behind it has not arrived', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'shared')
    relay(alice, bob)

    // Alice goes offline and types one more character, then her save reaches the server.
    type(alice, '!')
    const stamp = stampOf(EPOCH, documentStateOf(alice), 'shared!')!
    expect(documentStateCovers(documentStateOf(bob), stamp)).toBe(false)

    // The relay delivers it: now nothing in her revision is missing from Bob's document.
    relay(alice, bob)
    expect(documentStateCovers(documentStateOf(bob), stamp)).toBe(true)
  })

  it('is not covered when two people diverged, in either direction', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'base')
    relay(alice, bob)
    type(alice, ' from alice')
    type(bob, ' from bob')

    const hers = stampOf(EPOCH, documentStateOf(alice), 'base from alice')!
    const his = stampOf(EPOCH, documentStateOf(bob), 'base from bob')!

    expect(documentStateCovers(documentStateOf(bob), hers)).toBe(false)
    expect(documentStateCovers(documentStateOf(alice), his)).toBe(false)
  })

  it('is not covered by a document rebuilt from text, which shares no operation with it', () => {
    const before = documentOf(1)
    type(before, 'the same words')
    const stamp = stampOf(EPOCH, documentStateOf(before), 'the same words')!

    // A later session bootstraps a NEW document from the saved text: identical words, new lineage.
    const rebuilt = documentOf(77)
    type(rebuilt, 'the same words and more')

    expect(documentStateCovers(documentStateOf(rebuilt), stamp)).toBe(false)
  })
})

describe('a deletion is part of the state, although it advances no vector', () => {
  it('does not judge the revision of someone who ONLY deleted covered, until the deletion has arrived', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'Keep this. Remove this.')
    relay(alice, bob)

    // Alice is out of the room. She deletes a sentence and types nothing; her save reaches the
    // server. Bob, still in the room, holds every operation she ever made.
    erase(alice, ' Remove this.')
    const stamp = stampOf(EPOCH, documentStateOf(alice), 'Keep this.')!

    // The vectors cannot tell the two documents apart: a deletion is not an operation of its own.
    expect([...documentStateOf(alice).stateVector]).toEqual([...documentStateOf(bob).stateVector])
    expect(stamp.ds).toEqual([[1, [10, 13]]])
    // Judged by the vector alone her revision would be "an older state of Bob's document", no
    // copy would be kept, and Bob's next save would put the sentence back with nothing to show
    // that she had removed it.
    expect(bodyOf(bob)).toBe('Keep this. Remove this.')
    expect(documentStateCovers(documentStateOf(bob), stamp)).toBe(false)

    // The relay delivers her deletion: now Bob's document really does contain her revision.
    relay(alice, bob)
    expect(bodyOf(bob)).toBe('Keep this.')
    expect(documentStateCovers(documentStateOf(bob), stamp)).toBe(true)
  })

  it('is covered by a document that has deleted the same text and more', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'one two three four')
    relay(alice, bob)
    erase(alice, ' two')
    const stamp = stampOf(EPOCH, documentStateOf(alice), 'one three four')!

    relay(alice, bob)
    erase(bob, ' four')

    expect(documentStateCovers(documentStateOf(bob), stamp)).toBe(true)
  })

  it('is not covered when each of two people deleted something the other did not', () => {
    const alice = documentOf(1)
    const bob = documentOf(2)
    type(alice, 'one two three four')
    relay(alice, bob)
    erase(alice, ' two')
    erase(bob, ' four')

    const hers = stampOf(EPOCH, documentStateOf(alice), 'one three four')!
    const his = stampOf(EPOCH, documentStateOf(bob), 'one two three')!

    // Same vectors, the same NUMBER of deleted characters would nearly be true too: only the
    // sets themselves show that neither document contains the other.
    expect(documentStateCovers(documentStateOf(bob), hers)).toBe(false)
    expect(documentStateCovers(documentStateOf(alice), his)).toBe(false)
  })

  it('costs one run for a large paste that was removed again, however large', () => {
    const alice = documentOf(1)
    type(alice, 'kept')
    type(alice, 'p'.repeat(5_000))
    erase(alice, 'p'.repeat(5_000))

    expect(stampOf(EPOCH, documentStateOf(alice), 'kept')?.ds).toEqual([[1, [4, 5_000]]])
  })
})

describe('documentStateCovers', () => {
  const stamp = (ds: Array<[number, number[]]>) => ({ sv: [[1, 20]] as Array<[number, number]>, ds })

  it('finds a deleted run inside the document runs, across runs that touch', () => {
    // The stamp deletes clocks 3..8; the document deleted 2..5 and 5..9 as two runs.
    expect(
      documentStateCovers(
        state(
          [[1, 20]],
          [
            [
              1,
              [
                [2, 3],
                [5, 4],
              ],
            ],
          ],
        ),
        stamp([[1, [3, 5]]]),
      ),
    ).toBe(true)
  })

  it('refuses a run that sticks out of the document runs by one operation at either end', () => {
    const local = state([[1, 20]], [[1, [[4, 4]]]])

    expect(documentStateCovers(local, stamp([[1, [4, 4]]]))).toBe(true)
    expect(documentStateCovers(local, stamp([[1, [3, 5]]]))).toBe(false)
    expect(documentStateCovers(local, stamp([[1, [4, 5]]]))).toBe(false)
  })

  it('refuses a run with a hole in the middle of it on the document side', () => {
    const local = state(
      [[1, 20]],
      [
        [
          1,
          [
            [2, 2],
            [5, 2],
          ],
        ],
      ],
    )

    expect(documentStateCovers(local, stamp([[1, [2, 5]]]))).toBe(false)
    // Each run alone, read as gap-from-the-previous-run, is there.
    expect(documentStateCovers(local, stamp([[1, [2, 2, 1, 2]]]))).toBe(true)
  })

  it('refuses a deletion of an operation by a client the document has deleted nothing of', () => {
    expect(documentStateCovers(state([[1, 20]]), stamp([[1, [0, 1]]]))).toBe(false)
  })
})

describe('createCollaborationRevisionStamp', () => {
  it('lists the clients in a stable order whatever order the state iterates in', () => {
    const forwards = stampOf(
      EPOCH,
      state(
        [
          [9, 5],
          [3, 4],
        ],
        [
          [9, [[0, 1]]],
          [3, [[1, 2]]],
        ],
      ),
      'x',
    )
    const backwards = stampOf(
      EPOCH,
      state(
        [
          [3, 4],
          [9, 5],
        ],
        [
          [3, [[1, 2]]],
          [9, [[0, 1]]],
        ],
      ),
      'x',
    )

    expect(forwards?.sv).toEqual([
      [3, 4],
      [9, 5],
    ])
    expect(forwards?.ds).toEqual([
      [3, [1, 2]],
      [9, [0, 1]],
    ])
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards))
  })

  it('writes each deleted run as its distance from the run before it and its length', () => {
    const stamp = stampOf(
      EPOCH,
      state(
        [[1, 40]],
        [
          [
            1,
            [
              [2, 3],
              [10, 1],
              [11, 4],
              [39, 1],
            ],
          ],
        ],
      ),
      'x',
    )

    expect(stamp?.ds).toEqual([[1, [2, 3, 5, 1, 0, 4, 24, 1]]])
  })

  it('has nothing to say about an empty document', () => {
    expect(stampOf(EPOCH, state([]), '')).toBeUndefined()
    expect(stampOf(EPOCH, documentStateOf(new Y.Doc()), '')).toBeUndefined()
    // A client that is known but has contributed nothing is not listed, and alone is still empty.
    expect(stampOf(EPOCH, state([[4, 0]]), '')).toBeUndefined()
  })

  it('refuses a time that is not one', () => {
    expect(createCollaborationRevisionStamp(EPOCH, state([[1, 1]]), 'x', AT)?.at).toBe(AT)
    expect(createCollaborationRevisionStamp(EPOCH, state([[1, 1]]), 'x', -1)).toBeUndefined()
    expect(createCollaborationRevisionStamp(EPOCH, state([[1, 1]]), 'x', 1.5)).toBeUndefined()
    expect(createCollaborationRevisionStamp(EPOCH, state([[1, 1]]), 'x', Number.NaN)).toBeUndefined()
  })

  it('refuses a missing epoch, an impossible vector, or more writers than a stamp may carry', () => {
    expect(stampOf('', state([[1, 1]]), 'x')).toBeUndefined()
    expect(stampOf('e'.repeat(129), state([[1, 1]]), 'x')).toBeUndefined()
    expect(stampOf(EPOCH, state([[-1, 1]]), 'x')).toBeUndefined()
    expect(stampOf(EPOCH, state([[1, 1.5]]), 'x')).toBeUndefined()
    expect(stampOf(EPOCH, state([[2 ** 32, 1]]), 'x')).toBeUndefined()

    const crowd = Array.from({ length: MAX_STAMP_CLIENTS + 1 }, (_, index) => [index + 1, 1] as [number, number])
    expect(stampOf(EPOCH, state(crowd), 'x')).toBeUndefined()
    expect(stampOf(EPOCH, state(crowd.slice(1)), 'x')?.sv).toHaveLength(MAX_STAMP_CLIENTS)
  })

  it.each<[string, Array<[number, Array<[number, number]>]>]>([
    [
      'runs that overlap',
      [
        [
          1,
          [
            [2, 4],
            [5, 2],
          ],
        ],
      ],
    ],
    [
      'runs out of order',
      [
        [
          1,
          [
            [8, 1],
            [2, 1],
          ],
        ],
      ],
    ],
    ['a run of no length', [[1, [[2, 0]]]]],
    ['a run past the operations the document holds', [[1, [[18, 3]]]]],
    ['a fractional clock', [[1, [[2.5, 1]]]]],
    ['a deletion for a client the vector does not list', [[7, [[0, 1]]]]],
  ])('refuses a delete set no document can have: %s', (_name, deleted) => {
    expect(stampOf(EPOCH, state([[1, 20]], deleted), 'x')).toBeUndefined()
  })

  it('carries exactly as many deleted runs as a stamp may carry, and says nothing about a document with more', () => {
    const runs = (count: number): Array<[number, number]> =>
      Array.from({ length: count }, (_, index) => [index * 2, 1] as [number, number])
    const held = (MAX_STAMP_DELETED_RUNS + 1) * 2

    const full = stampOf(EPOCH, state([[1, held]], [[1, runs(MAX_STAMP_DELETED_RUNS)]]), 'x')
    expect(full?.ds[0][1]).toHaveLength(MAX_STAMP_DELETED_RUNS * 2)

    // No stamp at all, not a stamp without its delete set: an unprovable revision is copied.
    expect(stampOf(EPOCH, state([[1, held]], [[1, runs(MAX_STAMP_DELETED_RUNS + 1)]]), 'x')).toBeUndefined()
    // The bound is on the document, however its runs are spread over clients.
    expect(
      stampOf(
        EPOCH,
        state(
          [
            [1, held],
            [2, held],
          ],
          [
            [1, runs(MAX_STAMP_DELETED_RUNS)],
            [2, runs(1)],
          ],
        ),
        'x',
      ),
    ).toBeUndefined()
  })
})

describe('readCollaborationRevisionStamp', () => {
  const stamp = stampOf(
    EPOCH,
    state(
      [
        [1, 6],
        [2, 5],
      ],
      [[2, [[1, 2]]]],
    ),
    'Alpha Beta ',
  ) as CollaborationRevisionStamp

  it('returns the stamp a save wrote beside its own body, through a JSON round trip', () => {
    const stored = JSON.parse(JSON.stringify(contentWith('Alpha Beta ', stamp)))

    expect(stamp.ds).toEqual([[2, [1, 2]]])
    expect(readCollaborationRevisionStamp(stored)).toEqual(stamp)
  })

  it('refuses a stamp left beside a body it was not written with', () => {
    // What a client that does not edit the shared document does: it rewrites `text` and carries
    // the rest of the content, the old stamp included, along. Trusting that stamp would discard
    // a body nobody merged as "already contained".
    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta and an import', stamp))).toBeUndefined()
    expect(readCollaborationRevisionStamp(contentWith('alpha beta ', stamp))).toBeUndefined()
    expect(readCollaborationRevisionStamp(contentWith('', stamp))).toBeUndefined()
  })

  it.each([
    ['no stamp at all', undefined],
    ['a removed stamp', null],
    ['a stamp of another version', { ...stamp, v: 2 }],
    ['a stamp without an epoch', { ...stamp, epoch: '' }],
    ['a stamp with an empty vector', { ...stamp, sv: [] }],
    ['a vector entry that is not a pair', { ...stamp, sv: [[1, 6, 9]] }],
    ['a negative clock', { ...stamp, sv: [[1, -1]] }],
    ['a zero clock', { ...stamp, sv: [[1, 0]] }],
    ['a fractional client id', { ...stamp, sv: [[1.5, 6]] }],
    [
      'the same client twice',
      {
        ...stamp,
        sv: [
          [1, 6],
          [1, 7],
        ],
      },
    ],
    ['a string where a number belongs', { ...stamp, sv: [['1', 6]] }],
    ['a missing fingerprint', { ...stamp, text: undefined }],
    ['no time of its save', { ...stamp, at: undefined }],
    ['a time that is not a whole number', { ...stamp, at: AT + 0.5 }],
    ['a time written as text', { ...stamp, at: String(AT) }],
    ['a fingerprint of another length', { ...stamp, text: [stamp.text[0] + 1, stamp.text[1]] }],
    // A stamp that says nothing about deletions proves nothing about them.
    ['no delete set', { ...stamp, ds: undefined }],
    ['a delete set that is not a list', { ...stamp, ds: {} }],
    ['a delete-set entry that is not a pair', { ...stamp, ds: [[2, [1, 2], 9]] }],
    ['runs that are not a list', { ...stamp, ds: [[2, '1,2']] }],
    ['an empty list of runs', { ...stamp, ds: [[2, []]] }],
    ['a run without its length', { ...stamp, ds: [[2, [1, 2, 1]]] }],
    ['a run of no length', { ...stamp, ds: [[2, [1, 0]]] }],
    ['a negative gap', { ...stamp, ds: [[2, [-1, 2]]] }],
    ['a fractional gap', { ...stamp, ds: [[2, [0.5, 2]]] }],
    ['a run past the operations the document holds', { ...stamp, ds: [[2, [4, 2]]] }],
    ['runs that together pass the operations the document holds', { ...stamp, ds: [[2, [0, 3, 1, 2]]] }],
    ['a deletion for a client the vector does not list', { ...stamp, ds: [[7, [0, 1]]] }],
    [
      'the same client twice in the delete set',
      {
        ...stamp,
        ds: [
          [2, [0, 1]],
          [2, [2, 1]],
        ],
      },
    ],
    [
      'more delete-set entries than clients',
      {
        ...stamp,
        ds: [
          [1, [0, 1]],
          [2, [0, 1]],
          [3, [0, 1]],
        ],
      },
    ],
  ])('refuses %s', (_name, candidate) => {
    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta ', candidate))).toBeUndefined()
  })

  it('is the stamp of the save that last modified the note, and of no earlier one', () => {
    const modified = (millisecondsAfterTheStamp: number, form: (time: number) => unknown = (time) => new Date(time)) =>
      readCollaborationRevisionStamp(contentWith('Alpha Beta ', stamp, form(AT + millisecondsAfterTheStamp)))

    // In memory the modified date is a Date; stored, an ISO string. Either is read.
    expect(modified(0)).toEqual(stamp)
    expect(modified(3, (time) => new Date(time).toISOString())).toEqual(stamp)
    expect(modified(STAMP_SAVE_WINDOW_MS)).toEqual(stamp)
    // Something wrote the note again: a rename, a restore of this very revision.
    expect(modified(STAMP_SAVE_WINDOW_MS + 1)).toBeUndefined()
    expect(modified(24 * 60 * 60 * 1000)).toBeUndefined()
    // A stamp from after the last time a person wrote the note describes no save of it.
    expect(modified(-1)).toBeUndefined()
    // No modified date at all is not a save that anyone made.
    expect(
      readCollaborationRevisionStamp({
        text: 'Alpha Beta ',
        appData: { 'org.standardnotes.sn': { [COLLABORATION_REVISION_KEY]: stamp } },
      }),
    ).toBeUndefined()
    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta ', stamp, null))).toBeUndefined()
    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta ', stamp, 'yesterday'))).toBeUndefined()
    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta ', stamp, {}))).toBeUndefined()
  })

  it('accepts runs that end exactly at the last operation the document holds', () => {
    const exact = { ...stamp, ds: [[2, [0, 3, 1, 1]]] }

    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta ', exact))?.ds).toEqual([[2, [0, 3, 1, 1]]])
  })

  it('refuses more deleted runs than a stamp may carry', () => {
    const flat = (count: number): number[] => Array.from({ length: count * 2 }, () => 1)
    const held = (MAX_STAMP_DELETED_RUNS + 1) * 2
    const withRuns = (count: number) => ({ ...stamp, sv: [[1, held]], ds: [[1, flat(count)]] })

    expect(readCollaborationRevisionStamp(contentWith('Alpha Beta ', withRuns(MAX_STAMP_DELETED_RUNS)))).toBeDefined()
    expect(
      readCollaborationRevisionStamp(contentWith('Alpha Beta ', withRuns(MAX_STAMP_DELETED_RUNS + 1))),
    ).toBeUndefined()
  })

  it('refuses content that is not note content', () => {
    expect(readCollaborationRevisionStamp(undefined)).toBeUndefined()
    expect(readCollaborationRevisionStamp('text')).toBeUndefined()
    expect(readCollaborationRevisionStamp({ text: 'Alpha Beta ' })).toBeUndefined()
    expect(readCollaborationRevisionStamp({ text: 'Alpha Beta ', appData: {} })).toBeUndefined()
    expect(readCollaborationRevisionStamp({ text: 7, appData: contentWith('x', stamp).appData })).toBeUndefined()
  })
})

describe('writeCollaborationRevisionStamp', () => {
  const stamp = stampOf(EPOCH, state([[1, 1]]), 'x') as CollaborationRevisionStamp

  it('writes the stamp under its key, and removes it with undefined so the content compares as never stamped', () => {
    const written: Array<[string, unknown]> = []
    const mutator = { setAppDataItem: (key: string, value: unknown) => written.push([key, value]) }

    writeCollaborationRevisionStamp(mutator, stamp)
    writeCollaborationRevisionStamp(mutator, undefined)

    expect(written).toEqual([
      [COLLABORATION_REVISION_KEY, stamp],
      [COLLABORATION_REVISION_KEY, undefined],
    ])
    // Content is compared and stored as JSON: an undefined key is no key at all.
    expect(JSON.stringify(contentWith('x', undefined))).not.toContain(COLLABORATION_REVISION_KEY)
    expect(JSON.stringify(contentWith('x', null))).toContain(COLLABORATION_REVISION_KEY)
  })
})

describe('removeCollaborationRevisionStamp', () => {
  it('removes the stamp through a note mutator, and leaves a bare stand-in for one alone', () => {
    const written: Array<[string, unknown]> = []

    removeCollaborationRevisionStamp({ setAppDataItem: (key: string, value: unknown) => written.push([key, value]) })
    expect(written).toEqual([[COLLABORATION_REVISION_KEY, undefined]])

    expect(() => removeCollaborationRevisionStamp({})).not.toThrow()
    expect(() => removeCollaborationRevisionStamp(undefined)).not.toThrow()
    expect(() => removeCollaborationRevisionStamp(null)).not.toThrow()
  })
})

describe('fingerprintText', () => {
  it('is the same for the same body and different for a different one, including a reordering', () => {
    expect(fingerprintText('Alpha Beta')).toEqual(fingerprintText('Alpha Beta'))
    expect(fingerprintText('Alpha Beta')).not.toEqual(fingerprintText('Beta Alpha'))
    expect(fingerprintText('Alpha Beta')).not.toEqual(fingerprintText('Alpha Beta '))
    expect(fingerprintText('')).toEqual([0, fingerprintText('')[1]])
  })
})
