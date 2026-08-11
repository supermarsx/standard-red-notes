import { NotesController } from './NotesController'
import { DefaultAppDomain } from '@standardnotes/snjs'
import { WebCrypto } from '@/Application/Crypto'
import {
  MAX_COMMENT_MUTATION_RECORDS,
  MAX_NOTE_COMMENTS,
  COMMENT_AUTHORSHIP_VERSION,
  COMMENT_MUTATION_AUTHORSHIP_VERSION,
  NoteComment,
  NoteCommentActorClocksKey,
  NoteCommentMutationsKey,
  NoteCommentsKey,
  NoteCommentMutationRecord,
  clockProofFromMutation,
  getBoundedNoteCommentActorClocks,
  getNoteCommentMutationRecords,
  getNoteComments,
} from '../../Comments/comments'
import {
  canonicalCommentAuthorshipMessage,
  canonicalCommentMutationAuthorshipMessage,
  canonicalCommentMutationClockMessage,
  readDisplayNoteComments,
} from '../../Comments/CommentAuthorship'

jest.mock('@/Application/Crypto', () => {
  const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto')
  return {
    WebCrypto: {
      initialize: async () => undefined,
      sodiumCryptoSignSeedKeypair: () => {
        const pair = crypto.generateKeyPairSync('ed25519')
        return {
          publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        }
      },
      sodiumCryptoSign: (message: string, privateKey: string) =>
        crypto
          .sign(
            null,
            Buffer.from(message, 'utf8'),
            crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
          )
          .toString('base64'),
      sodiumCryptoSignVerify: (message: string, signature: string, publicKey: string) =>
        crypto.verify(
          null,
          Buffer.from(message, 'utf8'),
          crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
          Buffer.from(signature, 'base64'),
        ),
    },
  }
})

const commentId = (id: string, authorUuid = 'user-1') => `${authorUuid}:${id}`

const comment = (id: string): NoteComment => ({
  id: commentId(id),
  authorUuid: 'user-1',
  authorName: 'Alice',
  text: id,
  createdAt: new Date(0).toISOString(),
})

let signingPair: ReturnType<typeof WebCrypto.sodiumCryptoSignSeedKeypair>

type TrustedCommentContact = {
  contactUuid: string
  name: string
  publicKeySet: {
    encryption: string
    signing: string
    timestamp: Date
    previousKeySet?: {
      encryption: string
      signing: string
      timestamp: Date
    }
  }
}

const signedMutation = (
  counter: number,
  operation: NoteCommentMutationRecord['operation'],
  id: string,
  affectedCommentIds = [id],
  options: {
    actorUuid?: string
    eventId?: string
    pair?: typeof signingPair
    resolved?: boolean
  } = {},
): NoteCommentMutationRecord => {
  const pair = options.pair ?? signingPair
  const unsigned: NoteCommentMutationRecord = {
    commentId: id,
    operation,
    affectedCommentIds,
    stamp: {
      counter,
      actorUuid: options.actorUuid ?? 'user-1',
      eventId: options.eventId ?? `event-${counter}`,
    },
    ...(operation === 'resolve' ? { resolved: options.resolved ?? false } : {}),
  }
  const message = canonicalCommentMutationAuthorshipMessage('note-1', unsigned)!
  const clockMessage = canonicalCommentMutationClockMessage('note-1', unsigned)!
  return {
    ...unsigned,
    authorship: {
      version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
      signingPublicKey: pair.publicKey,
      signature: WebCrypto.sodiumCryptoSign(message, pair.privateKey),
      clockSignature: WebCrypto.sodiumCryptoSign(clockMessage, pair.privateKey),
    },
  }
}

const signedComment = (value: NoteComment, pair: typeof signingPair = signingPair): NoteComment => {
  const message = canonicalCommentAuthorshipMessage('note-1', value)!
  return {
    ...value,
    authorship: {
      version: COMMENT_AUTHORSHIP_VERSION,
      signingPublicKey: pair.publicKey,
      signature: WebCrypto.sodiumCryptoSign(message, pair.privateKey),
    },
  }
}

beforeAll(async () => {
  await WebCrypto.initialize()
  signingPair = WebCrypto.sodiumCryptoSignSeedKeypair('44'.repeat(32))
})

function createHarness() {
  const appData = new Map<unknown, unknown>()
  const appDataRead = jest.fn((key: unknown) => appData.get(key))
  const note = {
    uuid: 'note-1',
    user_uuid: 'user-1',
    locked: false,
    payload: { content: {} },
    key_system_identifier: 'key-system-1',
    shared_vault_uuid: 'shared-vault-1',
    getAppDomainValue: appDataRead,
  }
  let authoritative: typeof note | undefined = note
  let authorized = true
  let currentSessionReadOnly = false
  let currentUser = { uuid: 'user-1', email: 'alice@example.com' }
  let readonlyVaultMember = false
  let accountRootKey = {
    masterKey: 'test-root-key',
    keyVersion: '004',
    keyParams: { getPortableValue: () => ({ version: '004' }) },
    signingKeyPair: signingPair,
  }
  let selfContact: TrustedCommentContact | undefined
  const trustedContacts = new Map<string, TrustedCommentContact>()
  const vault = {
    uuid: 'vault-1',
    systemIdentifier: 'key-system-1',
    sharing: { sharedVaultUuid: 'shared-vault-1' },
    isSharedVaultListing: () => true,
  }
  const setAppDataItem = jest.fn((key: unknown, value: unknown) => {
    if (value === undefined) {
      appData.delete(key)
    } else {
      appData.set(key, value)
    }
  })
  let changeBarrier: Promise<void> | undefined
  const emitPayload = jest.fn()
  const sync = jest.fn().mockResolvedValue(undefined)
  const getFullContentPayload = jest.fn(async () => ({
    uuid: note.uuid,
    key_system_identifier: note.key_system_identifier,
    shared_vault_uuid: note.shared_vault_uuid,
    content: {
      appData: { [DefaultAppDomain]: Object.fromEntries(appData) },
    },
  }))
  const changeItem = jest.fn(async (_note: unknown, mutate: (mutator: unknown) => void) => {
    const barrier = changeBarrier
    changeBarrier = undefined
    await barrier
    mutate({ setAppDataItem })
    emitPayload()
    return authoritative
  })
  const application = {
    items: { findItem: jest.fn(() => authoritative) },
    isAuthorizedToRenderItem: jest.fn(() => authorized),
    sessions: {
      getUser: () => currentUser,
      isSignedIn: () => true,
      isCurrentSessionReadOnly: () => currentSessionReadOnly,
      getSigningPublicKey: () => accountRootKey.signingKeyPair.publicKey,
    },
    vaults: { getItemVault: () => vault },
    vaultLocks: {
      getUnlockedVaultRootKey: () => ({
        key: 'test-vault-root-key',
        uuid: 'vault-root-key-1',
        systemIdentifier: 'key-system-1',
        keyParams: { creationTimestamp: 1 },
        token: 'encrypted-root-key-metadata',
        serverUpdatedAtTimestamp: 1,
      }),
    },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => readonlyVaultMember },
    encryption: {
      getRootKey: () => accountRootKey,
    },
    contacts: { getSelfContact: () => selfContact, findContact: (uuid: string) => trustedContacts.get(uuid) },
    mutator: { changeItem },
    sync: { sync, getFullContentPayload },
  }
  const recreateController = () => {
    const controller = Object.create(NotesController.prototype) as NotesController
    Object.assign(controller as object, {
      application,
      commentMutationQueues: new WeakMap<object, Map<string, Promise<void>>>(),
    })
    return controller
  }
  const controller = recreateController()
  return {
    application,
    appDataRead,
    changeItem,
    controller,
    emitPayload,
    getFullContentPayload,
    note,
    seedAppData: (key: unknown, value: unknown) => {
      appData.set(key, value)
    },
    deferNextChange: () => {
      let release!: () => void
      changeBarrier = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        changeBarrier = undefined
        release()
      }
    },
    setAuthorized: (value: boolean) => {
      authorized = value
    },
    setReadonlySession: (value: boolean) => {
      currentSessionReadOnly = value
    },
    setReadonlyVaultMember: (value: boolean) => {
      readonlyVaultMember = value
    },
    replaceSessionUser: () => {
      currentUser = { uuid: 'user-1', email: 'alice@example.com' }
    },
    replaceSigningPair: (pair: typeof signingPair) => {
      accountRootKey = { ...accountRootKey, signingKeyPair: pair }
    },
    trustCurrentAndPreviousSelfKeys: (current: typeof signingPair, previous: typeof signingPair) => {
      selfContact = {
        contactUuid: currentUser.uuid,
        name: currentUser.email,
        publicKeySet: {
          encryption: 'current-encryption-key',
          signing: current.publicKey,
          timestamp: new Date(1),
          previousKeySet: {
            encryption: 'previous-encryption-key',
            signing: previous.publicKey,
            timestamp: new Date(0),
          },
        },
      }
    },
    removeAuthoritativeItem: () => {
      authoritative = undefined
    },
    recreateController,
    trustContact: (contactUuid: string, name: string, pair: typeof signingPair) => {
      trustedContacts.set(contactUuid, {
        contactUuid,
        name,
        publicKeySet: {
          encryption: `encryption-${contactUuid}`,
          signing: pair.publicKey,
          timestamp: new Date(1),
        },
      })
    },
  }
}

describe('NotesController comment mutation serialization and authorization', () => {
  it('serializes concurrent local writes so counters advance and neither comment is lost', async () => {
    const harness = createHarness()

    const [first, second] = await Promise.all([
      harness.controller.upsertNoteComment(harness.note as never, comment('comment-1')),
      harness.controller.upsertNoteComment(harness.note as never, comment('comment-2')),
    ])

    expect(first?.mutation.stamp.counter).toBe(1)
    expect(second?.mutation.stamp.counter).toBe(2)
    expect(getNoteComments(harness.note as never).map(({ id }) => id)).toEqual([
      commentId('comment-1'),
      commentId('comment-2'),
    ])
    expect(getNoteCommentMutationRecords(harness.note as never).map((record) => record.stamp.counter)).toEqual([1, 2])
  })

  it('does not fall back to a retained note or read plaintext after access loss/removal', async () => {
    const harness = createHarness()
    harness.setAuthorized(false)
    harness.appDataRead.mockClear()

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('blocked')),
    ).resolves.toBeUndefined()
    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'remove',
        commentId: commentId('comment-1'),
        mutation: {
          commentId: commentId('comment-1'),
          operation: 'remove',
          affectedCommentIds: [commentId('comment-1')],
          stamp: { counter: 1, actorUuid: 'user-2', eventId: 'event-1' },
        },
      }),
    ).resolves.toBe(false)
    expect(harness.appDataRead).not.toHaveBeenCalled()
    expect(harness.changeItem).not.toHaveBeenCalled()

    harness.setAuthorized(true)
    harness.removeAuthoritativeItem()
    await expect(
      harness.controller.removeNoteComment(harness.note as never, commentId('comment-1')),
    ).resolves.toBeUndefined()
    expect(harness.appDataRead).not.toHaveBeenCalled()
    expect(harness.application.items.findItem).toHaveBeenCalled()
  })

  it('persists comments and high-water records in the same metadata mutation', async () => {
    const harness = createHarness()

    await harness.controller.upsertNoteComment(harness.note as never, comment('comment-1'))

    const writes = harness.changeItem.mock.calls[0]
    expect(writes).toBeDefined()
    expect(getNoteComments(harness.note as never)).toHaveLength(1)
    expect(getNoteCommentMutationRecords(harness.note as never)).toHaveLength(1)
    expect(harness.note.getAppDomainValue(NoteCommentsKey)).toBeDefined()
    expect(harness.note.getAppDomainValue(NoteCommentMutationsKey)).toBeDefined()
  })

  it('rebases at the mutation boundary so a newly authoritative comment is not overwritten', async () => {
    const harness = createHarness()
    const releaseChange = harness.deferNextChange()
    const pending = harness.controller.upsertNoteComment(harness.note as never, comment('local-comment'))
    await Promise.resolve()

    harness.seedAppData(NoteCommentsKey, [comment('remote-comment')])
    harness.seedAppData(NoteCommentMutationsKey, [
      signedMutation(7, 'upsert', commentId('remote-comment'), [commentId('remote-comment')], {
        eventId: 'remote-event',
      }),
    ])
    releaseChange()
    await pending

    expect(
      getNoteComments(harness.note as never)
        .map(({ id }) => id)
        .sort(),
    ).toEqual([commentId('local-comment'), commentId('remote-comment')])
    expect(
      getNoteCommentMutationRecords(harness.note as never)
        .map(({ stamp }) => stamp.counter)
        .sort(),
    ).toEqual([7, 8])
  })

  it('returns the exact rebased resolved comment when remote text advances during rehydration', async () => {
    const harness = createHarness()
    harness.seedAppData(NoteCommentsKey, [comment('comment-1')])
    harness.seedAppData(NoteCommentMutationsKey, [
      signedMutation(1, 'upsert', commentId('comment-1'), [commentId('comment-1')], {
        eventId: 'initial-event',
      }),
    ])
    const releaseChange = harness.deferNextChange()
    const pending = harness.controller.setNoteCommentResolved(harness.note as never, commentId('comment-1'), true)
    await Promise.resolve()

    harness.seedAppData(NoteCommentsKey, [{ ...comment('comment-1'), text: 'newer remote text' }])
    harness.seedAppData(NoteCommentMutationsKey, [
      signedMutation(9, 'upsert', commentId('comment-1'), [commentId('comment-1')], {
        eventId: 'remote-event',
      }),
    ])
    releaseChange()

    await expect(pending).resolves.toEqual({
      comment: expect.objectContaining({ id: commentId('comment-1'), text: 'newer remote text', resolved: true }),
      mutation: expect.objectContaining({
        commentId: commentId('comment-1'),
        operation: 'resolve',
        stamp: expect.objectContaining({ counter: 10 }),
      }),
    })
    expect(getNoteComments(harness.note as never)).toEqual([
      expect.objectContaining({ id: commentId('comment-1'), text: 'newer remote text', resolved: true }),
    ])
  })

  it('compacts old tombstones into a signed actor floor so long-lived notes accept future ids', async () => {
    const harness = createHarness()
    const mutations = Array.from({ length: MAX_COMMENT_MUTATION_RECORDS }, (_, index) =>
      signedMutation(index + 1, 'remove', commentId(`comment-${index}`), [commentId(`comment-${index}`)], {
        eventId: `event-${index}`,
      }),
    )
    harness.seedAppData(NoteCommentsKey, [comment('comment-0')])
    harness.seedAppData(NoteCommentMutationsKey, mutations)

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, { ...comment('comment-0'), text: 'updated' }),
    ).resolves.toBeDefined()
    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('one-too-many')),
    ).resolves.toBeDefined()

    expect(getNoteCommentMutationRecords(harness.note as never)).toHaveLength(MAX_COMMENT_MUTATION_RECORDS)
    expect(getNoteComments(harness.note as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: commentId('comment-0'), text: 'updated' }),
        expect.objectContaining({ id: commentId('one-too-many') }),
      ]),
    )
    expect(getBoundedNoteCommentActorClocks(harness.note as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUuid: 'user-1',
          replayFloor: expect.objectContaining({ stamp: expect.objectContaining({ counter: expect.any(Number) }) }),
        }),
      ]),
    )
    expect(harness.note.getAppDomainValue(NoteCommentActorClocksKey)).toBeDefined()
  })

  it('preserves an unverifiable actor clock without letting it block a trusted local actor', async () => {
    const harness = createHarness()
    const invalidProof = {
      ...clockProofFromMutation(signedMutation(Number.MAX_SAFE_INTEGER, 'remove', commentId('poisoned-target')))!,
      signature: 'invalid-but-bounded-proof',
    }
    harness.seedAppData(NoteCommentActorClocksKey, [{ actorUuid: 'user-1', highWater: invalidProof }])

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('must-still-write')),
    ).resolves.toBeDefined()

    expect(getNoteComments(harness.note as never)).toEqual([
      expect.objectContaining({ id: commentId('must-still-write') }),
    ])
    expect(getBoundedNoteCommentActorClocks(harness.note as never)).toHaveLength(2)
  })

  it('keeps a trusted MAX_SAFE_INTEGER clock scoped to its remote actor after reload', async () => {
    const harness = createHarness()
    const remotePair = WebCrypto.sodiumCryptoSignSeedKeypair('88'.repeat(32))
    harness.trustContact('user-2', 'Bob', remotePair)
    const remoteComment = signedComment(
      {
        ...comment('remote-max-clock'),
        id: commentId('remote-max-clock', 'user-2'),
        authorUuid: 'user-2',
        authorName: 'Bob',
      },
      remotePair,
    )
    const remoteMutation = signedMutation(Number.MAX_SAFE_INTEGER, 'upsert', remoteComment.id, [remoteComment.id], {
      actorUuid: 'user-2',
      eventId: 'remote-max-event',
      pair: remotePair,
    })

    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: remoteComment,
        mutation: remoteMutation,
      }),
    ).resolves.toBe(true)

    const reloadedController = harness.recreateController()
    const local = await reloadedController.upsertNoteComment(harness.note as never, comment('local-after-remote-max'))

    expect(local?.mutation.stamp).toMatchObject({ actorUuid: 'user-1', counter: 1 })
    expect(getBoundedNoteCommentActorClocks(harness.note as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUuid: 'user-2',
          highWater: expect.objectContaining({ stamp: expect.objectContaining({ counter: Number.MAX_SAFE_INTEGER }) }),
        }),
        expect.objectContaining({
          actorUuid: 'user-1',
          highWater: expect.objectContaining({ stamp: expect.objectContaining({ counter: 1 }) }),
        }),
      ]),
    )
  })

  it('rejects a captured creation below its compacted signed actor floor at the persistence boundary', async () => {
    const harness = createHarness()
    const floorMutation = signedMutation(100, 'remove', commentId('compacted-comment'), undefined, {
      eventId: 'floor-event',
    })
    const floorProof = clockProofFromMutation(floorMutation)!
    harness.seedAppData(NoteCommentActorClocksKey, [
      { actorUuid: 'user-1', highWater: floorProof, replayFloor: floorProof },
    ])
    const replayedComment = signedComment(comment('compacted-comment'))

    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: replayedComment,
        mutation: signedMutation(99, 'upsert', replayedComment.id, [replayedComment.id], {
          eventId: 'captured-event',
        }),
      }),
    ).resolves.toBe(false)

    await expect(
      harness.recreateController().applyRemoteCommentMutation('note-1', {
        operation: 'remove',
        commentId: floorMutation.commentId,
        mutation: floorMutation,
      }),
    ).resolves.toBe(false)

    expect(getNoteComments(harness.note as never)).toEqual([])
  })

  it('advances every signer floor for a cross-author cascade and rejects compacted events after reload', async () => {
    const harness = createHarness()
    const remotePair = WebCrypto.sodiumCryptoSignSeedKeypair('99'.repeat(32))
    harness.trustContact('user-2', 'Bob', remotePair)

    const parent = await harness.controller.upsertNoteComment(harness.note as never, comment('cascade-parent'))
    expect(parent).toBeDefined()
    const replyComment = signedComment(
      {
        ...comment('cascade-reply'),
        id: commentId('cascade-reply', 'user-2'),
        authorUuid: 'user-2',
        authorName: 'Bob',
        parentId: parent!.comment.id,
      },
      remotePair,
    )
    const replyCreation = signedMutation(1, 'upsert', replyComment.id, [replyComment.id], {
      actorUuid: 'user-2',
      eventId: 'reply-creation',
      pair: remotePair,
    })
    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: replyComment,
        mutation: replyCreation,
      }),
    ).resolves.toBe(true)

    const cascadeRemoval = await harness.controller.removeNoteComment(harness.note as never, parent!.comment.id)
    expect(cascadeRemoval?.affectedCommentIds).toEqual(expect.arrayContaining([parent!.comment.id, replyComment.id]))
    expect(getNoteCommentMutationRecords(harness.note as never)).toEqual([cascadeRemoval])
    expect(getBoundedNoteCommentActorClocks(harness.note as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUuid: 'user-1',
          replayFloor: expect.objectContaining({ stamp: parent!.mutation.stamp }),
        }),
        expect.objectContaining({
          actorUuid: 'user-2',
          replayFloor: expect.objectContaining({ stamp: replyCreation.stamp }),
        }),
      ]),
    )

    const reloadedController = harness.recreateController()
    await expect(
      reloadedController.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: parent!.comment,
        mutation: parent!.mutation,
      }),
    ).resolves.toBe(false)
    await expect(
      reloadedController.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: replyComment,
        mutation: replyCreation,
      }),
    ).resolves.toBe(false)

    await expect(
      reloadedController.upsertNoteComment(harness.note as never, comment('cascade-parent')),
    ).resolves.toBeDefined()
    const replyRecreation = signedMutation(2, 'upsert', replyComment.id, [replyComment.id], {
      actorUuid: 'user-2',
      eventId: 'reply-recreation',
      pair: remotePair,
    })
    await expect(
      reloadedController.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: replyComment,
        mutation: replyRecreation,
      }),
    ).resolves.toBe(true)

    expect(getNoteCommentMutationRecords(harness.note as never)).not.toContainEqual(cascadeRemoval)
    await expect(
      harness.recreateController().applyRemoteCommentMutation('note-1', {
        operation: 'remove',
        commentId: cascadeRemoval!.commentId,
        mutation: cascadeRemoval!,
      }),
    ).resolves.toBe(false)
    expect(getNoteComments(harness.note as never).map(({ id }) => id)).toEqual(
      expect.arrayContaining([parent!.comment.id, replyComment.id]),
    )
  })

  it('aborts a queued mutation before payload emission when the same uuid signs in again', async () => {
    const harness = createHarness()
    const releaseChange = harness.deferNextChange()

    const pending = harness.controller.upsertNoteComment(harness.note as never, comment('old-session-comment'))
    await Promise.resolve()
    harness.replaceSessionUser()
    releaseChange()

    await expect(pending).resolves.toBeUndefined()
    expect(harness.emitPayload).not.toHaveBeenCalled()
    expect(harness.application.sync.sync).not.toHaveBeenCalled()
    expect(getNoteComments(harness.note as never)).toEqual([])
  })

  it('does not let a stalled prior-session queue block a replacement same-uuid session', async () => {
    const harness = createHarness()
    const releaseOldSession = harness.deferNextChange()
    const oldSessionMutation = harness.controller.upsertNoteComment(
      harness.note as never,
      comment('old-session-comment'),
    )
    for (let attempt = 0; attempt < 8 && harness.changeItem.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve()
    }
    expect(harness.changeItem).toHaveBeenCalledTimes(1)

    harness.replaceSessionUser()
    const replacementMutation = harness.controller.upsertNoteComment(
      harness.note as never,
      comment('replacement-session-comment'),
    )
    await expect(replacementMutation).resolves.toBeDefined()

    releaseOldSession()
    await expect(oldSessionMutation).resolves.toBeUndefined()
    expect(getNoteComments(harness.note as never)).toEqual([
      expect.objectContaining({ id: commentId('replacement-session-comment') }),
    ])
  })

  it('refuses comment writes for read-only sessions and shared-vault members', async () => {
    const sessionHarness = createHarness()
    sessionHarness.setReadonlySession(true)
    await expect(
      sessionHarness.controller.upsertNoteComment(sessionHarness.note as never, comment('session-readonly')),
    ).resolves.toBeUndefined()
    expect(sessionHarness.changeItem).not.toHaveBeenCalled()
    expect(sessionHarness.application.sync.sync).not.toHaveBeenCalled()

    const vaultHarness = createHarness()
    vaultHarness.setReadonlyVaultMember(true)
    await expect(
      vaultHarness.controller.upsertNoteComment(vaultHarness.note as never, comment('vault-readonly')),
    ).resolves.toBeUndefined()
    expect(vaultHarness.changeItem).not.toHaveBeenCalled()
    expect(vaultHarness.application.sync.sync).not.toHaveBeenCalled()
  })

  it('does not acknowledge a comment mutation when independent local-storage proof is missing', async () => {
    const harness = createHarness()
    harness.getFullContentPayload.mockResolvedValueOnce(undefined as never)

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('memory-only')),
    ).resolves.toBeUndefined()

    expect(harness.emitPayload).toHaveBeenCalledTimes(1)
    expect(harness.application.sync.sync).toHaveBeenCalledTimes(2)
    expect(harness.application.sync.sync).toHaveBeenCalledWith()
    expect(harness.application.sync.sync).toHaveBeenCalledWith(
      expect.objectContaining({ awaitAll: true, mode: 'LocalOnly' }),
    )
  })

  it('aborts a queued local comment when the account signing key changes before serialization', async () => {
    const harness = createHarness()
    const release = harness.deferNextChange()
    const pending = harness.controller.upsertNoteComment(harness.note as never, comment('rotated-before-write'))
    harness.replaceSigningPair(WebCrypto.sodiumCryptoSignSeedKeypair('55'.repeat(32)))

    release()

    await expect(pending).resolves.toBeUndefined()
    expect(harness.emitPayload).not.toHaveBeenCalled()
    expect(harness.application.sync.sync).not.toHaveBeenCalled()
  })

  it('preserves quarantined signed comments across unrelated writes until trust is restored', async () => {
    const harness = createHarness()
    const previousPair = signingPair
    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('historical-comment')),
    ).resolves.toBeDefined()

    const currentPair = WebCrypto.sodiumCryptoSignSeedKeypair('77'.repeat(32))
    harness.replaceSigningPair(currentPair)
    expect(readDisplayNoteComments(harness.application as never, harness.note as never)).toMatchObject({
      comments: [],
      quarantinedCount: 1,
    })

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('unrelated-current-comment')),
    ).resolves.toBeDefined()
    expect(getNoteComments(harness.note as never).map(({ id }) => id)).toEqual([
      commentId('historical-comment'),
      commentId('unrelated-current-comment'),
    ])

    harness.trustCurrentAndPreviousSelfKeys(currentPair, previousPair)
    expect(readDisplayNoteComments(harness.application as never, harness.note as never)).toMatchObject({
      comments: [
        expect.objectContaining({ id: commentId('historical-comment'), authorshipStatus: 'verified' }),
        expect.objectContaining({ id: commentId('unrelated-current-comment'), authorshipStatus: 'verified' }),
      ],
      quarantinedCount: 0,
    })
  })

  it('never lets an invalid duplicate id shadow or erase the legitimate signed comment', async () => {
    const harness = createHarness()
    const historical = await harness.controller.upsertNoteComment(harness.note as never, {
      ...comment('duplicate-target'),
      text: 'legitimate body',
    })
    const forgedDuplicate = { ...historical!.comment, text: 'forged shadow body' }
    harness.seedAppData(NoteCommentsKey, [historical!.comment, forgedDuplicate])

    expect(readDisplayNoteComments(harness.application as never, harness.note as never)).toMatchObject({
      comments: [expect.objectContaining({ id: historical!.comment.id, text: 'legitimate body' })],
      quarantinedCount: 1,
    })

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('unrelated-after-duplicate')),
    ).resolves.toBeDefined()
    expect(getNoteComments(harness.note as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: historical!.comment.id, text: 'legitimate body' }),
        expect.objectContaining({ id: commentId('unrelated-after-duplicate') }),
      ]),
    )
    expect(getNoteComments(harness.note as never)).toHaveLength(2)
  })

  it('does not charge a full bounded quarantine against the trusted comment budget', async () => {
    const harness = createHarness()
    const quarantined = Array.from({ length: MAX_NOTE_COMMENTS }, (_, index) => ({
      ...comment(`quarantined-${index}`),
      authorship: {
        version: COMMENT_AUTHORSHIP_VERSION,
        signingPublicKey: signingPair.publicKey,
        signature: `invalid-signature-${index}`,
      },
    }))
    harness.seedAppData(NoteCommentsKey, quarantined)

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('trusted-after-full-quarantine')),
    ).resolves.toBeDefined()

    expect(getNoteComments(harness.note as never)).toHaveLength(MAX_NOTE_COMMENTS + 1)
    expect(readDisplayNoteComments(harness.application as never, harness.note as never)).toMatchObject({
      comments: [expect.objectContaining({ id: commentId('trusted-after-full-quarantine') })],
      quarantinedCount: MAX_NOTE_COMMENTS,
    })
  })

  it('does not acknowledge or relay a locally signed comment when the disk proof signature differs', async () => {
    const harness = createHarness()
    harness.getFullContentPayload.mockImplementationOnce(async () => {
      const stored = harness.appDataRead(NoteCommentsKey) as NoteComment[]
      const corrupted = stored.map((entry) => ({
        ...entry,
        authorship: entry.authorship ? { ...entry.authorship, signature: 'corrupted-but-bounded' } : undefined,
      }))
      return {
        uuid: harness.note.uuid,
        key_system_identifier: harness.note.key_system_identifier,
        shared_vault_uuid: harness.note.shared_vault_uuid,
        content: {
          appData: {
            [DefaultAppDomain]: {
              [NoteCommentsKey]: corrupted,
              [NoteCommentMutationsKey]: harness.appDataRead(NoteCommentMutationsKey),
              [NoteCommentActorClocksKey]: harness.appDataRead(NoteCommentActorClocksKey),
            },
          },
        },
      }
    })

    await expect(
      harness.controller.upsertNoteComment(harness.note as never, comment('disk-signature-mismatch')),
    ).resolves.toBeUndefined()
    expect(harness.emitPayload).toHaveBeenCalledTimes(1)
    expect(harness.application.sync.sync).toHaveBeenCalledTimes(2)
  })

  it('rejects an unknown-key remote authorship proof before any persistence work', async () => {
    const harness = createHarness()
    const forgedPair = WebCrypto.sodiumCryptoSignSeedKeypair('66'.repeat(32))
    const forged = comment('forged-remote-author')
    const message = canonicalCommentAuthorshipMessage(harness.note.uuid, forged)!
    forged.authorship = {
      version: COMMENT_AUTHORSHIP_VERSION,
      signingPublicKey: forgedPair.publicKey,
      signature: WebCrypto.sodiumCryptoSign(message, forgedPair.privateKey),
    }

    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: forged,
        mutation: signedMutation(1, 'upsert', forged.id, [forged.id], {
          actorUuid: 'spoofed-actor',
          eventId: 'forged-event',
          pair: forgedPair,
        }),
      }),
    ).resolves.toBe(false)
    expect(harness.changeItem).not.toHaveBeenCalled()
    expect(harness.application.sync.sync).not.toHaveBeenCalled()
  })

  it('does not let a trusted second author replace or delete another author comment', async () => {
    const harness = createHarness()
    const victim = await harness.controller.upsertNoteComment(harness.note as never, {
      ...comment('victim'),
      text: 'original victim text',
    })
    const attackerPair = WebCrypto.sodiumCryptoSignSeedKeypair('aa'.repeat(32))
    harness.trustContact('user-2', 'Mallory', attackerPair)
    const validAttackerComment = signedComment(
      {
        ...comment('replacement'),
        id: commentId('replacement', 'user-2'),
        authorUuid: 'user-2',
        authorName: 'Mallory',
        text: 'attacker replacement',
      },
      attackerPair,
    )
    const namespaceSpoof = { ...validAttackerComment, id: victim!.comment.id }
    const replacementMutation = signedMutation(1, 'upsert', victim!.comment.id, [victim!.comment.id], {
      actorUuid: 'user-2',
      eventId: 'cross-author-replacement',
      pair: attackerPair,
    })

    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'upsert',
        comment: namespaceSpoof,
        mutation: replacementMutation,
      }),
    ).resolves.toBe(false)
    const crossAuthorRemoval = signedMutation(2, 'remove', victim!.comment.id, [victim!.comment.id], {
      actorUuid: 'user-2',
      eventId: 'cross-author-removal',
      pair: attackerPair,
    })
    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'remove',
        commentId: victim!.comment.id,
        mutation: crossAuthorRemoval,
      }),
    ).resolves.toBe(false)
    expect(getNoteComments(harness.note as never)).toEqual([
      expect.objectContaining({ id: victim!.comment.id, text: 'original victim text' }),
    ])
  })

  it('rejects a remove event that smuggles an unrelated id into its cascade', async () => {
    const harness = createHarness()
    const victim = await harness.controller.upsertNoteComment(harness.note as never, comment('cascade-scope'))
    const overbroadRemoval = signedMutation(
      2,
      'remove',
      victim!.comment.id,
      [victim!.comment.id, commentId('unrelated-target')],
      { eventId: 'overbroad-cascade' },
    )

    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'remove',
        commentId: victim!.comment.id,
        mutation: overbroadRemoval,
      }),
    ).resolves.toBe(false)
    expect(getNoteComments(harness.note as never)).toEqual([expect.objectContaining({ id: victim!.comment.id })])
  })

  it('rejects a freshly restamped captured event whose original signature no longer matches', async () => {
    const harness = createHarness()
    const captured = signedMutation(1, 'remove', commentId('restamp-target'), undefined, {
      eventId: 'captured-remove',
    })
    const restamped = {
      ...captured,
      stamp: { ...captured.stamp, counter: 500, eventId: 'fresh-envelope' },
    }

    await expect(
      harness.controller.applyRemoteCommentMutation('note-1', {
        operation: 'remove',
        commentId: restamped.commentId,
        mutation: restamped,
      }),
    ).resolves.toBe(false)
    expect(harness.changeItem).not.toHaveBeenCalled()
  })
})
