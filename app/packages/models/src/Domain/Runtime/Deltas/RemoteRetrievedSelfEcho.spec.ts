import { ContentType } from '@standardnotes/domain-core'
import { ServerSyncSavedContextualPayload } from '../../Abstract/Contextual/ServerSyncSaved'
import { UuidGenerator } from '@standardnotes/utils'
import { FillItemContent } from '../../Abstract/Content/ItemContent'
import { AppDataField } from '../../Abstract/Item/Types/AppDataField'
import { DefaultAppDomain } from '../../Abstract/Item/Types/DefaultAppDomain'
import {
  DecryptedPayload,
  DecryptedPayloadInterface,
  FullyFormedPayloadInterface,
  createLitePayloadFromDecrypted,
  PayloadTimestampDefaults,
} from '../../Abstract/Payload'
import { NoteContent } from '../../Syncable/Note'
import { PayloadCollection } from '../Collection/Payload/PayloadCollection'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { ServerSyncPushContextualPayload } from '../../Abstract/Contextual/ServerSyncPush'
import { HistoryEntry } from '../History/HistoryEntry'
import { HistoryMap } from '../History/HistoryMap'
import { DeltaRemoteRetrieved } from './RemoteRetrieved'
import { isStaleSelfEchoOfBase } from './Utilities/StaleSelfEcho'

/**
 * THE CLASS OF BUG THIS FILE EXISTS FOR
 *
 * The server can re-deliver, in `retrieved_items`, a row that this very client wrote — a clamped
 * `sync_token`, a resumed socket lane, a NULL `updated_with_session` on a pre-existing row. The
 * content is then not a conflict at all; it is our own older state coming back.
 *
 * `DeltaRemoteRetrieved` used to route that into `ConflictDelta` purely because the local payload
 * was `dirty`, and `GenericItem.strategyWhenConflictingWithItem` only ever compares *content*. So
 * once the user's edit had settled past the twenty-second `userModifiedDate` window and no history
 * revision happened to match, the answer was `DuplicateBaseKeepApply`: **the echoed older content
 * took the original uuid and the user's newer edit was exiled to a conflict copy.** On disk nothing
 * was lost. On screen the note the operator was looking at reverted.
 *
 * `e2e/tests/super-editor-last-edit-loss.spec.ts` cannot see any of this: it runs with no account,
 * so its "sync" is local IndexedDB and no remote-retrieved delta is ever produced. These tests
 * drive the real delta against a real dirty local payload instead.
 */
describe('remote retrieved self-echo', () => {
  const NOTE_UUID = 'operators-note-uuid'

  /** What the server holds, and what this client last successfully pushed. */
  const SERVER_TEXT = 'the paragraph I had already saved'
  /** The edit sitting in the editor, dirty, not yet acknowledged by the server. */
  const LOCAL_EDIT = 'the paragraph I had already saved, plus the sentence I just typed'
  /** What a genuine second device wrote. */
  const PEER_TEXT = 'a sentence my phone wrote while this tab was idle'

  /**
   * The `updated_at_timestamp` the server assigned to our own last acknowledged save, and which
   * the dirty local payload therefore still carries.
   */
  const ACKNOWLEDGED_TS = 1_700_000_000_000_000

  const SETTLED = 60_000
  const STILL_TYPING = 1_000

  let uuidCounter = 0

  beforeEach(() => {
    uuidCounter = 0
    UuidGenerator.SetGenerator(() => `generated-uuid-${++uuidCounter}`)
  })

  const noteContent = (text: string, userModifiedMsAgo: number): NoteContent =>
    FillItemContent<NoteContent>({
      title: 'Operator note',
      text,
      appData: {
        [DefaultAppDomain]: {
          [AppDataField.UserModifiedDate]: new Date(Date.now() - userModifiedMsAgo).toISOString(),
        },
      },
    } as Partial<NoteContent>)

  const notePayload = (options: {
    text: string
    dirty: boolean
    updatedAtTimestamp: number
    userModifiedMsAgo: number
  }): DecryptedPayloadInterface<NoteContent> =>
    new DecryptedPayload<NoteContent>({
      uuid: NOTE_UUID,
      content_type: ContentType.TYPES.Note,
      content: noteContent(options.text, options.userModifiedMsAgo),
      dirty: options.dirty,
      ...PayloadTimestampDefaults(),
      updated_at: new Date(options.updatedAtTimestamp / 1000),
      updated_at_timestamp: options.updatedAtTimestamp,
    })

  const collectionOf = (...payloads: FullyFormedPayloadInterface[]) => {
    const collection = new PayloadCollection()
    payloads.forEach((payload) => collection.set(payload))
    return ImmutablePayloadCollection.FromCollection(collection)
  }

  /** A history revision whose content is exactly `payload`'s — the "matching revision" case. */
  const historyMatching = (payload: DecryptedPayloadInterface<NoteContent>): HistoryMap => ({
    [NOTE_UUID]: [new HistoryEntry(payload)],
  })

  const run = (
    base: FullyFormedPayloadInterface | undefined,
    apply: FullyFormedPayloadInterface,
    options: {
      savedOrSaving?: ServerSyncPushContextualPayload[]
      historyMap?: HistoryMap
      acknowledged?: ServerSyncSavedContextualPayload[]
    } = {},
  ) => {
    const delta = new DeltaRemoteRetrieved(
      base ? collectionOf(base) : collectionOf(),
      collectionOf(apply),
      options.savedOrSaving ?? [],
      options.historyMap ?? {},
      undefined,
      options.acknowledged ?? [],
    )

    const result = delta.result()

    return {
      emits: result.emits,
      /** What now lives at the note's own uuid — i.e. what the user would see. */
      atOriginalUuid: result.emits.find((payload) => payload.uuid === NOTE_UUID),
      /** Any freshly minted conflict copy. */
      copies: result.emits.filter((payload) => payload.uuid !== NOTE_UUID),
    }
  }

  const textOf = (payload: FullyFormedPayloadInterface | undefined): string | undefined =>
    (payload as DecryptedPayloadInterface<NoteContent> | undefined)?.content.text

  describe('the predicate itself', () => {
    const at = (updatedAtTimestamp: number) =>
      notePayload({ text: 'x', dirty: false, updatedAtTimestamp, userModifiedMsAgo: 0 })

    it('calls an equal timestamp a self-echo: nobody wrote the row since we did', () => {
      expect(isStaleSelfEchoOfBase(at(ACKNOWLEDGED_TS), at(ACKNOWLEDGED_TS))).toBe(true)
    })

    it('calls an older timestamp a self-echo', () => {
      expect(isStaleSelfEchoOfBase(at(ACKNOWLEDGED_TS - 1), at(ACKNOWLEDGED_TS))).toBe(true)
    })

    it('does NOT call a newer timestamp a self-echo — that is a peer write', () => {
      expect(isStaleSelfEchoOfBase(at(ACKNOWLEDGED_TS + 1), at(ACKNOWLEDGED_TS))).toBe(false)
    })

    it('declines when the local item has never been synced (no comparable timestamp)', () => {
      expect(isStaleSelfEchoOfBase(at(ACKNOWLEDGED_TS), at(0))).toBe(false)
    })

    it('declines when the server sent no microsecond timestamp (legacy server)', () => {
      expect(isStaleSelfEchoOfBase(at(0), at(ACKNOWLEDGED_TS))).toBe(false)
    })

    it('declines when neither side has a comparable timestamp', () => {
      expect(isStaleSelfEchoOfBase(at(0), at(0))).toBe(false)
    })
  })

  it('ignores a retrieval covered by this response own save acknowledgement while a newer local edit stays dirty', () => {
    const base = notePayload({
      text: LOCAL_EDIT,
      dirty: true,
      updatedAtTimestamp: ACKNOWLEDGED_TS,
      userModifiedMsAgo: SETTLED,
    })
    const echo = notePayload({
      text: SERVER_TEXT,
      dirty: false,
      updatedAtTimestamp: ACKNOWLEDGED_TS + 100,
      userModifiedMsAgo: SETTLED,
    })
    const acknowledged = {
      uuid: NOTE_UUID,
      content_type: base.content_type,
      deleted: false,
      updated_at_timestamp: ACKNOWLEDGED_TS + 100,
    } as ServerSyncSavedContextualPayload
    const result = run(base, echo, {
      savedOrSaving: [{ uuid: NOTE_UUID }] as ServerSyncPushContextualPayload[],
      acknowledged: [acknowledged],
    })
    expect(result.emits).toHaveLength(0)
    expect(base.dirty).toBe(true)
    expect(textOf(base)).toBe(LOCAL_EDIT)
  })

  it('ignores an older page echo after this operation has already acknowledged and cleaned the note', () => {
    const base = notePayload({
      text: LOCAL_EDIT,
      dirty: false,
      updatedAtTimestamp: ACKNOWLEDGED_TS + 100,
      userModifiedMsAgo: SETTLED,
    })
    const echo = notePayload({
      text: SERVER_TEXT,
      dirty: false,
      updatedAtTimestamp: ACKNOWLEDGED_TS,
      userModifiedMsAgo: SETTLED,
    })
    expect(
      run(base, echo, { savedOrSaving: [{ uuid: NOTE_UUID }] as ServerSyncPushContextualPayload[] }).emits,
    ).toHaveLength(0)
  })

  it('accepts a genuine newer peer revision without copying an already-clean saved note', () => {
    const base = notePayload({
      text: SERVER_TEXT,
      dirty: false,
      updatedAtTimestamp: ACKNOWLEDGED_TS,
      userModifiedMsAgo: SETTLED,
    })
    const peer = notePayload({
      text: PEER_TEXT,
      dirty: false,
      updatedAtTimestamp: ACKNOWLEDGED_TS + 100,
      userModifiedMsAgo: SETTLED,
    })
    const result = run(base, peer, { savedOrSaving: [{ uuid: NOTE_UUID }] as ServerSyncPushContextualPayload[] })
    expect(result.emits).toHaveLength(1)
    expect(result.copies).toHaveLength(0)
    expect(textOf(result.atOriginalUuid)).toBe(PEER_TEXT)
  })

  it('still hydrates an already-clean body-stripped note from its full retrieval', () => {
    const full = notePayload({
      text: SERVER_TEXT,
      dirty: false,
      updatedAtTimestamp: ACKNOWLEDGED_TS,
      userModifiedMsAgo: SETTLED,
    })
    const base = createLitePayloadFromDecrypted(full)
    const result = run(base, full, { savedOrSaving: [{ uuid: NOTE_UUID }] as ServerSyncPushContextualPayload[] })
    expect(textOf(result.atOriginalUuid)).toBe(SERVER_TEXT)
    expect(result.copies).toHaveLength(0)
  })

  it.each([
    'newer-peer-write',
    'other-vault',
    'other-key-system',
    'other-type',
    'other-uuid',
    'no-upload',
    'missing-server-time',
    'deleted-ack',
  ])('preserves a genuine or unproved competing revision: %s', (scenario) => {
    const base = notePayload({
      text: LOCAL_EDIT,
      dirty: true,
      updatedAtTimestamp: ACKNOWLEDGED_TS,
      userModifiedMsAgo: SETTLED,
    })
    const echo = notePayload({
      text: PEER_TEXT,
      dirty: false,
      updatedAtTimestamp: scenario === 'missing-server-time' ? 0 : ACKNOWLEDGED_TS + 100,
      userModifiedMsAgo: SETTLED,
    })
    const acknowledged = {
      uuid: NOTE_UUID,
      content_type: base.content_type,
      deleted: false,
      updated_at_timestamp: ACKNOWLEDGED_TS + (scenario === 'newer-peer-write' ? 99 : 100),
      ...(scenario === 'other-vault' ? { shared_vault_uuid: 'elsewhere' } : {}),
      ...(scenario === 'other-key-system' ? { key_system_identifier: 'other-key-system' } : {}),
      ...(scenario === 'other-type' ? { content_type: ContentType.TYPES.Tag } : {}),
      ...(scenario === 'other-uuid' ? { uuid: 'different-item' } : {}),
      ...(scenario === 'deleted-ack' ? { deleted: true } : {}),
    } as ServerSyncSavedContextualPayload
    const result = run(base, echo, {
      savedOrSaving: scenario === 'no-upload' ? [] : ([{ uuid: NOTE_UUID }] as ServerSyncPushContextualPayload[]),
      acknowledged: [acknowledged],
    })
    expect(result.copies).toHaveLength(1)
    expect(textOf(result.atOriginalUuid)).toBe(PEER_TEXT)
  })

  /**
   * ARM 1 of 3 — base NOT dirty. The echo is authoritative and identical; applying it is a no-op.
   * The guard must not live on this arm, so the retrieval still lands.
   */
  describe('arm 1: base is not dirty', () => {
    it('applies the retrieved row as before, with no conflict copy', () => {
      const base = notePayload({
        text: SERVER_TEXT,
        dirty: false,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })
      const echo = notePayload({
        text: SERVER_TEXT,
        dirty: false,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

      const { emits, atOriginalUuid, copies } = run(base, echo)

      expect(emits).toHaveLength(1)
      expect(textOf(atOriginalUuid)).toEqual(SERVER_TEXT)
      expect(atOriginalUuid?.dirty).toBeFalsy()
      expect(copies).toHaveLength(0)
    })
  })

  /**
   * ARM 2 of 3 — base dirty, user still typing (inside GenericItem's twenty-second
   * `userModifiedDate` window). Pre-fix this answered `KeepBaseDuplicateApply`: the note did not
   * revert, but the client minted a conflict copy of *its own* previously-saved text, which the
   * operator then had to delete by hand. Post-fix nothing is emitted at all.
   */
  describe('arm 2: base dirty, edited within the twenty-second window', () => {
    it('leaves the dirty edit alone and mints no conflict copy of our own old text', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: STILL_TYPING,
      })
      const echo = notePayload({
        text: SERVER_TEXT,
        dirty: false,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

      const { emits, atOriginalUuid, copies } = run(base, echo)

      expect(copies).toHaveLength(0)
      expect(emits).toHaveLength(0)
      // Nothing was emitted, so what the user sees is still the untouched dirty base.
      expect(atOriginalUuid).toBeUndefined()
    })
  })

  /**
   * ARM 3 of 3 — base dirty, edit settled past twenty seconds. This is the reverting arm.
   */
  describe('arm 3: base dirty, edit settled beyond twenty seconds', () => {
    const settledDirtyBase = () =>
      notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

    const selfEcho = () =>
      notePayload({
        text: SERVER_TEXT,
        dirty: false,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

    /**
     * THE OPERATOR'S BUG. Pre-fix: `atOriginalUuid` carried SERVER_TEXT and a copy carried
     * LOCAL_EDIT — the visible revert. Restore the pre-fix behaviour (drop the
     * `isStaleSelfEchoOfBase` guard in RemoteRetrieved.ts, or make the predicate return false)
     * and this is the test that fails, naming the reverted text.
     */
    it('no matching history revision: the note does NOT revert to the echoed server text', () => {
      const { emits, atOriginalUuid, copies } = run(settledDirtyBase(), selfEcho())

      expect(textOf(atOriginalUuid)).not.toEqual(SERVER_TEXT)
      expect(copies).toHaveLength(0)
      expect(emits).toHaveLength(0)
    })

    it('no matching history revision: the local edit is not exiled to a conflict copy', () => {
      const { copies } = run(settledDirtyBase(), selfEcho())

      expect(copies.map((payload) => textOf(payload))).not.toContain(LOCAL_EDIT)
      expect(copies.some((payload) => payload.duplicate_of === NOTE_UUID)).toBe(false)
    })

    it('with a matching history revision: still nothing to apply, and still no revert', () => {
      const echo = selfEcho()

      const { emits, atOriginalUuid, copies } = run(settledDirtyBase(), echo, {
        historyMap: historyMatching(echo),
      })

      expect(textOf(atOriginalUuid)).not.toEqual(SERVER_TEXT)
      expect(copies).toHaveLength(0)
      expect(emits).toHaveLength(0)
    })

    /**
     * A strictly-older echo must not be "resolved" by stamping its timestamp onto our base
     * either: that would walk the client's `updated_at_timestamp` backwards and the next push
     * would be answered `sync_conflict` by the server's TimeDifferenceFilter.
     */
    it('a strictly OLDER echo does not walk our updated_at_timestamp backwards', () => {
      const stale = notePayload({
        text: SERVER_TEXT,
        dirty: false,
        updatedAtTimestamp: ACKNOWLEDGED_TS - 1_000_000,
        userModifiedMsAgo: SETTLED,
      })

      const { emits } = run(settledDirtyBase(), stale)

      expect(emits).toHaveLength(0)
      expect(emits.some((payload) => payload.updated_at_timestamp < ACKNOWLEDGED_TS)).toBe(false)
    })
  })

  /**
   * THE BEHAVIOUR THAT MUST NOT BE WEAKENED.
   *
   * A real second device advances the row's `updated_at_timestamp` strictly past the value our
   * base holds (UpdateExistingItem: `Math.max(now, existing.updatedAt + 1)`), so every one of
   * these must behave exactly as it did before the guard existed. If any of these starts emitting
   * nothing, the guard has become a data-loss bug.
   */
  describe('a genuine peer conflict is untouched', () => {
    const PEER_TS = ACKNOWLEDGED_TS + 1_000_000

    const peerWrite = () =>
      notePayload({
        text: PEER_TEXT,
        dirty: false,
        updatedAtTimestamp: PEER_TS,
        userModifiedMsAgo: STILL_TYPING,
      })

    it('settled local edit: server content takes the uuid and our edit becomes a conflict copy', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

      const { emits, atOriginalUuid, copies } = run(base, peerWrite())

      expect(emits).toHaveLength(2)
      expect(textOf(atOriginalUuid)).toEqual(PEER_TEXT)
      expect(atOriginalUuid?.dirty).toBe(false)
      expect(copies).toHaveLength(1)
      expect(textOf(copies[0])).toEqual(LOCAL_EDIT)
      expect(copies[0].duplicate_of).toEqual(NOTE_UUID)
      expect((copies[0] as DecryptedPayloadInterface<NoteContent>).content.conflict_of).toEqual(NOTE_UUID)
      expect(copies[0].dirty).toBe(true)
    })

    it('local edit still in progress: our edit keeps the uuid and the peer write becomes the copy', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: STILL_TYPING,
      })

      const { emits, atOriginalUuid, copies } = run(base, peerWrite())

      expect(emits).toHaveLength(2)
      expect(textOf(atOriginalUuid)).toEqual(LOCAL_EDIT)
      expect(atOriginalUuid?.updated_at_timestamp).toEqual(PEER_TS)
      expect(copies).toHaveLength(1)
      expect(textOf(copies[0])).toEqual(PEER_TEXT)
      expect(copies[0].duplicate_of).toEqual(NOTE_UUID)
    })

    it('peer write matching a history revision: our edit wins outright, no copy', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })
      const peer = peerWrite()

      const { emits, atOriginalUuid, copies } = run(base, peer, { historyMap: historyMatching(peer) })

      expect(emits).toHaveLength(1)
      expect(textOf(atOriginalUuid)).toEqual(LOCAL_EDIT)
      expect(copies).toHaveLength(0)
    })

    it('peer write with identical content: the retrieval simply lands', () => {
      const base = notePayload({
        text: PEER_TEXT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

      const { emits, atOriginalUuid, copies } = run(base, peerWrite())

      expect(emits).toHaveLength(1)
      expect(textOf(atOriginalUuid)).toEqual(PEER_TEXT)
      expect(atOriginalUuid?.dirty).toBe(false)
      expect(copies).toHaveLength(0)
    })

    it('a never-synced local item still conflicts: there is no timestamp to compare', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: 0,
        userModifiedMsAgo: SETTLED,
      })

      const { emits, atOriginalUuid, copies } = run(base, peerWrite())

      expect(emits).toHaveLength(2)
      expect(textOf(atOriginalUuid)).toEqual(PEER_TEXT)
      expect(copies).toHaveLength(1)
      expect(textOf(copies[0])).toEqual(LOCAL_EDIT)
    })

    it('a legacy server sending no timestamp still conflicts rather than being swallowed', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })
      const legacyPeerWrite = notePayload({
        text: PEER_TEXT,
        dirty: false,
        updatedAtTimestamp: 0,
        userModifiedMsAgo: STILL_TYPING,
      })

      const { emits, atOriginalUuid, copies } = run(base, legacyPeerWrite)

      expect(emits).toHaveLength(2)
      expect(textOf(atOriginalUuid)).toEqual(PEER_TEXT)
      expect(copies).toHaveLength(1)
      expect(textOf(copies[0])).toEqual(LOCAL_EDIT)
    })
  })

  /**
   * A pre-save timestamp still proves that a retrieval at or below that timestamp
   * is stale. A genuinely newer row needs an ACK or the ordinary conflict rules.
   */
  describe('an item saved in this same sync request', () => {
    it('keeps the local payload without manufacturing a conflict for its known-stale echo', () => {
      const base = notePayload({
        text: LOCAL_EDIT,
        dirty: true,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: STILL_TYPING,
      })
      const echo = notePayload({
        text: SERVER_TEXT,
        dirty: false,
        updatedAtTimestamp: ACKNOWLEDGED_TS,
        userModifiedMsAgo: SETTLED,
      })

      const { emits, atOriginalUuid, copies } = run(base, echo, {
        savedOrSaving: [{ uuid: NOTE_UUID }] as ServerSyncPushContextualPayload[],
      })

      expect(emits).toHaveLength(0)
      expect(atOriginalUuid).toBeUndefined()
      expect(copies).toHaveLength(0)
    })
  })
})
