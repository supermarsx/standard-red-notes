import {
  COMMENT_MUTATION_AUTHORSHIP_VERSION,
  MAX_COMMENT_ANCHOR_SNIPPET_LENGTH,
  MAX_COMMENT_AUTHOR_NAME_LENGTH,
  MAX_COMMENT_MENTIONS,
  MAX_COMMENT_MUTATION_AFFECTED_IDS,
  MAX_COMMENT_MUTATION_ID_LENGTH,
  MAX_COMMENT_MUTATION_RECORDS,
  MAX_COMMENT_REPLIES_PER_THREAD,
  MAX_COMMENT_TEXT_LENGTH,
  MAX_NOTE_COMMENTS,
  NoteCommentActorClock,
  NoteCommentMutationRecord,
  clockProofFromMutation,
  compactCommentMutationRecords,
  compareCommentMutationStamps,
  commentCollectionFitsBudgets,
  commentMutationRecordsFitBudgets,
  getBoundedNoteCommentMutationRecords,
  getBoundedNoteComments,
  normalizeComment,
  normalizeCommentMutationRecord,
} from './comments'

describe('comment mutation durability boundary', () => {
  const valid = {
    commentId: 'comment-1',
    operation: 'remove' as const,
    stamp: { counter: 1, actorUuid: 'actor-1', eventId: 'event-1' },
    affectedCommentIds: ['comment-1'],
  }

  it('orders equal Lamport counters deterministically by actor and event', () => {
    expect(
      compareCommentMutationStamps(
        { counter: 2, actorUuid: 'actor-a', eventId: 'event-z' },
        { counter: 2, actorUuid: 'actor-b', eventId: 'event-a' },
      ),
    ).toBeLessThan(0)
    expect(
      compareCommentMutationStamps(
        { counter: 2, actorUuid: 'actor-a', eventId: 'event-z' },
        { counter: 2, actorUuid: 'actor-a', eventId: 'event-a' },
      ),
    ).toBeGreaterThan(0)
    // This is intentionally code-unit order, not locale collation. Case and
    // punctuation must converge identically in every browser/runtime locale.
    expect(
      compareCommentMutationStamps(
        { counter: 2, actorUuid: 'actor-Z', eventId: 'event-z' },
        { counter: 2, actorUuid: 'actor-a', eventId: 'event-a' },
      ),
    ).toBeLessThan(0)
    expect(
      compareCommentMutationStamps(
        { counter: 2, actorUuid: 'same', eventId: 'event-!' },
        { counter: 2, actorUuid: 'same', eventId: 'event-A' },
      ),
    ).toBeLessThan(0)
  })

  it('rejects oversized authenticated identities and affected arrays without truncation', () => {
    expect(
      normalizeCommentMutationRecord({
        ...valid,
        commentId: 'x'.repeat(MAX_COMMENT_MUTATION_ID_LENGTH + 1),
      }),
    ).toBeNull()
    expect(
      normalizeCommentMutationRecord({
        ...valid,
        stamp: { ...valid.stamp, actorUuid: 'x'.repeat(MAX_COMMENT_MUTATION_ID_LENGTH + 1) },
      }),
    ).toBeNull()
    expect(
      normalizeCommentMutationRecord({
        ...valid,
        affectedCommentIds: Array.from(
          { length: MAX_COMMENT_MUTATION_AFFECTED_IDS + 1 },
          (_, index) => `comment-${index}`,
        ),
      }),
    ).toBeNull()
  })

  it('fails closed instead of discarding a malformed durable high-water entry', () => {
    const note = {
      getAppDomainValue: () => [valid, { ...valid, commentId: '', affectedCommentIds: [''] }],
    } as never

    expect(getBoundedNoteCommentMutationRecords(note)).toBeUndefined()
  })

  it('rejects oversized plaintext fields, anchors, and mention fanout without truncation', () => {
    const comment = {
      id: 'comment-1',
      authorUuid: 'actor-1',
      authorName: 'Alice',
      text: 'bounded',
      createdAt: new Date(0).toISOString(),
    }

    expect(normalizeComment({ ...comment, text: 'x'.repeat(MAX_COMMENT_TEXT_LENGTH + 1) })).toBeNull()
    expect(normalizeComment({ ...comment, authorName: 'x'.repeat(MAX_COMMENT_AUTHOR_NAME_LENGTH + 1) })).toBeNull()
    expect(
      normalizeComment({
        ...comment,
        anchor: { kind: 'super', blockKey: 'block-1', snippet: 'x'.repeat(MAX_COMMENT_ANCHOR_SNIPPET_LENGTH + 1) },
      }),
    ).toBeNull()
    expect(
      normalizeComment({
        ...comment,
        mentions: Array.from({ length: MAX_COMMENT_MENTIONS + 1 }, (_, index) => `actor-${index}`),
      }),
    ).toBeNull()
  })

  it('accepts only canonical UTC ISO timestamps and never runtime-dependent date strings', () => {
    const base = {
      id: 'comment-1',
      authorUuid: 'actor-1',
      authorName: 'Alice',
      text: 'bounded',
    }

    expect(normalizeComment({ ...base, createdAt: '2026-08-11T12:34:56.789Z' })?.createdAt).toBe(
      '2026-08-11T12:34:56.789Z',
    )
    expect(normalizeComment({ ...base, createdAt: '08/11/2026 12:34:56' })?.createdAt).toBe('1970-01-01T00:00:00.000Z')
    expect(normalizeComment({ ...base, createdAt: '2026-08-11T13:34:56.789+01:00' })?.createdAt).toBe(
      '1970-01-01T00:00:00.000Z',
    )
  })

  it('keeps independent trusted and quarantine limits for total comments and replies', () => {
    const makeComment = (id: string, parentId?: string) => ({
      id,
      authorUuid: 'actor-1',
      authorName: 'Alice',
      text: id,
      createdAt: new Date(0).toISOString(),
      ...(parentId ? { parentId } : {}),
    })
    const noteWith = (comments: unknown) => ({ getAppDomainValue: () => comments }) as never

    const oneOverTrusted = Array.from({ length: MAX_NOTE_COMMENTS + 1 }, (_, index) => makeComment(`comment-${index}`))
    expect(getBoundedNoteComments(noteWith(oneOverTrusted))).toHaveLength(MAX_NOTE_COMMENTS + 1)
    expect(commentCollectionFitsBudgets(oneOverTrusted)).toBe(false)
    expect(
      getBoundedNoteComments(
        noteWith(Array.from({ length: MAX_NOTE_COMMENTS * 2 + 1 }, (_, index) => makeComment(`comment-${index}`))),
      ),
    ).toBeUndefined()

    const oneOverTrustedReplies = [
      makeComment('root'),
      ...Array.from({ length: MAX_COMMENT_REPLIES_PER_THREAD + 1 }, (_, index) =>
        makeComment(`reply-${index}`, 'root'),
      ),
    ]
    expect(getBoundedNoteComments(noteWith(oneOverTrustedReplies))).toHaveLength(MAX_COMMENT_REPLIES_PER_THREAD + 2)
    expect(commentCollectionFitsBudgets(oneOverTrustedReplies)).toBe(false)
    expect(
      getBoundedNoteComments(
        noteWith([
          makeComment('root'),
          ...Array.from({ length: MAX_COMMENT_REPLIES_PER_THREAD * 2 + 1 }, (_, index) =>
            makeComment(`reply-${index}`, 'root'),
          ),
        ]),
      ),
    ).toBeUndefined()
  })

  it('keeps strict trusted and quarantined long-run tombstone ceilings', () => {
    const record = (index: number) => ({
      commentId: `comment-${index}`,
      operation: 'remove' as const,
      stamp: { counter: index + 1, actorUuid: 'actor-1', eventId: `event-${index}` },
      affectedCommentIds: [`comment-${index}`],
    })
    const noteWith = (mutations: unknown) => ({ getAppDomainValue: () => mutations }) as never

    expect(
      getBoundedNoteCommentMutationRecords(
        noteWith(Array.from({ length: MAX_COMMENT_MUTATION_RECORDS }, (_, index) => record(index))),
      ),
    ).toHaveLength(MAX_COMMENT_MUTATION_RECORDS)
    const oneOverTrusted = Array.from({ length: MAX_COMMENT_MUTATION_RECORDS + 1 }, (_, index) => record(index))
    expect(getBoundedNoteCommentMutationRecords(noteWith(oneOverTrusted))).toHaveLength(
      MAX_COMMENT_MUTATION_RECORDS + 1,
    )
    expect(commentMutationRecordsFitBudgets(oneOverTrusted)).toBe(false)
    expect(
      getBoundedNoteCommentMutationRecords(
        noteWith(Array.from({ length: MAX_COMMENT_MUTATION_RECORDS * 2 + 1 }, (_, index) => record(index))),
      ),
    ).toBeUndefined()
  })

  it('compacts the oldest deleted-id tombstone into its authenticated actor replay floor', () => {
    const mutations: NoteCommentMutationRecord[] = Array.from(
      { length: MAX_COMMENT_MUTATION_RECORDS + 1 },
      (_, index) => ({
        commentId: `comment-${index}`,
        operation: 'remove' as const,
        stamp: { counter: index + 1, actorUuid: 'actor-1', eventId: `event-${index}` },
        affectedCommentIds: [`comment-${index}`],
        authorship: {
          version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
          signingPublicKey: 'bounded-public-key',
          signature: `mutation-signature-${index}`,
          clockSignature: `clock-signature-${index}`,
        },
      }),
    )
    const highWater = clockProofFromMutation(mutations[mutations.length - 1])!
    const clocks: NoteCommentActorClock[] = [{ actorUuid: 'actor-1', highWater }]

    const compacted = compactCommentMutationRecords([], mutations, clocks)

    expect(compacted?.mutations).toHaveLength(MAX_COMMENT_MUTATION_RECORDS)
    expect(compacted?.mutations.some((record) => record.commentId === 'comment-0')).toBe(false)
    expect(compacted?.clocks[0].replayFloor).toEqual(clockProofFromMutation(mutations[0]))
  })

  it('never advances a global actor floor past an older retained target event', () => {
    const mutation = (counter: number, commentId: string): NoteCommentMutationRecord => ({
      commentId,
      operation: 'remove',
      stamp: { counter, actorUuid: 'actor-1', eventId: `event-${counter}` },
      affectedCommentIds: [commentId],
      authorship: {
        version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
        signingPublicKey: 'bounded-public-key',
        signature: `mutation-signature-${counter}`,
        clockSignature: `clock-signature-${counter}`,
      },
    })
    const retainedEarly = mutation(1, 'target-a')
    const obsoleteLater = mutation(2, 'target-b')
    const retainedLater = mutation(3, 'target-b')
    const first = compactCommentMutationRecords(
      [],
      [retainedEarly, obsoleteLater, retainedLater],
      [{ actorUuid: 'actor-1', highWater: clockProofFromMutation(retainedLater)! }],
    )

    expect(first?.mutations).toEqual([retainedEarly, obsoleteLater, retainedLater])
    expect(first?.clocks[0].replayFloor).toBeUndefined()

    const replacementForEarlyTarget = mutation(4, 'target-a')
    const second = compactCommentMutationRecords(
      [],
      [...first!.mutations, replacementForEarlyTarget],
      [{ actorUuid: 'actor-1', highWater: clockProofFromMutation(replacementForEarlyTarget)! }],
    )
    expect(second?.mutations).toEqual([retainedLater, replacementForEarlyTarget])
    expect(second?.clocks[0].replayFloor).toEqual(clockProofFromMutation(obsoleteLater))
  })
})
