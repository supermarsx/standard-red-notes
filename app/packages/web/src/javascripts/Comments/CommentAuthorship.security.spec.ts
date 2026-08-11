import { WebCrypto } from '@/Application/Crypto'
import type { WebApplication } from '@/Application/WebApplication'
import type { NoteEncryptionIdentity } from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'
import {
  COMMENT_AUTHORSHIP_VERSION,
  MAX_COMMENT_SIGNATURE_LENGTH,
  MAX_COMMENT_SIGNING_PUBLIC_KEY_LENGTH,
  NoteComment,
  NoteCommentMutationRecord,
  NoteCommentsKey,
  UnsignedNoteCommentMutationRecord,
  clockProofFromMutation,
  normalizeComment,
} from './comments'
import {
  attestLocalComment,
  attestLocalCommentMutation,
  canonicalCommentAuthorshipMessage,
  captureCommentSigningPublicKey,
  readDisplayNoteComments,
  verifyCommentAuthorship,
  verifyCommentMutationAuthorship,
  verifyCommentMutationClockProof,
} from './CommentAuthorship'

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
const baseComment = (): NoteComment => ({
  id: 'author-1:comment-1',
  authorUuid: 'author-1',
  authorName: 'Untrusted snapshot',
  text: 'Signed body',
  createdAt: '2026-08-11T12:34:56.789Z',
  anchor: { kind: 'super', blockKey: 'block-1', snippet: 'Context' },
  parentId: 'parent-1',
  mentions: ['member-1', 'member-2'],
})

const keySet = (signing: string, previousSigning?: string) => ({
  encryption: 'unused',
  signing,
  timestamp: new Date(0),
  previousKeySet: previousSigning
    ? {
        encryption: 'unused-previous',
        signing: previousSigning,
        timestamp: new Date(0),
      }
    : undefined,
})

describe('comment authorship attestation', () => {
  let currentPair: ReturnType<typeof WebCrypto.sodiumCryptoSignSeedKeypair>
  let previousPair: ReturnType<typeof WebCrypto.sodiumCryptoSignSeedKeypair>
  let unrelatedPair: ReturnType<typeof WebCrypto.sodiumCryptoSignSeedKeypair>

  beforeAll(async () => {
    await WebCrypto.initialize()
    currentPair = WebCrypto.sodiumCryptoSignSeedKeypair('11'.repeat(32))
    previousPair = WebCrypto.sodiumCryptoSignSeedKeypair('22'.repeat(32))
    unrelatedPair = WebCrypto.sodiumCryptoSignSeedKeypair('33'.repeat(32))
  })

  function applicationFor(
    options: {
      sessionUser?: { uuid: string; email: string }
      rootPair?: typeof currentPair
      contactCurrentKey?: string
      contactPreviousKey?: string
      contactName?: string
    } = {},
  ) {
    const sessionUser = options.sessionUser ?? { uuid: 'viewer-1', email: 'viewer@example.test' }
    const rootPair = options.rootPair ?? unrelatedPair
    const contact = options.contactCurrentKey
      ? {
          contactUuid: 'author-1',
          name: options.contactName ?? 'Locally trusted Alice',
          publicKeySet: keySet(options.contactCurrentKey, options.contactPreviousKey),
        }
      : undefined
    let rootKey = { signingKeyPair: rootPair }
    return {
      application: {
        sessions: {
          getUser: () => sessionUser,
          getSigningPublicKey: () => rootKey.signingKeyPair.publicKey,
        },
        encryption: { getRootKey: () => rootKey },
        contacts: {
          getSelfContact: () => undefined,
          findContact: (uuid: string) => (uuid === contact?.contactUuid ? contact : undefined),
        },
      } as never as WebApplication,
      replaceRootPair: (pair: typeof currentPair) => {
        rootKey = { signingKeyPair: pair }
      },
      sessionUser,
    }
  }

  function signedWith(pair: typeof currentPair, comment = baseComment(), noteUuid = 'note-1'): NoteComment {
    const message = canonicalCommentAuthorshipMessage(noteUuid, comment)!
    return {
      ...comment,
      authorship: {
        version: COMMENT_AUTHORSHIP_VERSION,
        signingPublicKey: pair.publicKey,
        signature: WebCrypto.sodiumCryptoSign(message, pair.privateKey),
      },
    }
  }

  it('binds the note and every immutable field while allowing collaborative resolved state', () => {
    const { application } = applicationFor({
      contactCurrentKey: currentPair.publicKey,
    })
    const signed = signedWith(currentPair)

    expect(verifyCommentAuthorship(application, 'note-1', signed).status).toBe('verified')
    expect(verifyCommentAuthorship(application, 'note-1', { ...signed, resolved: true }).status).toBe('verified')
    expect(verifyCommentAuthorship(application, 'note-2', signed).status).toBe('invalid')

    const tampered: NoteComment[] = [
      { ...signed, id: 'author-1:comment-2' },
      { ...signed, authorUuid: 'author-2' },
      { ...signed, authorName: 'Forged display snapshot' },
      { ...signed, text: 'Forged body' },
      { ...signed, createdAt: '2026-08-11T12:34:57.789Z' },
      { ...signed, anchor: { kind: 'super', blockKey: 'block-2' } },
      { ...signed, parentId: 'parent-2' },
      { ...signed, mentions: ['member-3'] },
    ]
    for (const comment of tampered) {
      expect(verifyCommentAuthorship(application, 'note-1', comment).status).toBe('invalid')
    }
  })

  it('accepts current and bounded previous trusted-contact keys but not an unrelated key', () => {
    const { application } = applicationFor({
      contactCurrentKey: currentPair.publicKey,
      contactPreviousKey: previousPair.publicKey,
    })
    expect(verifyCommentAuthorship(application, 'note-1', signedWith(currentPair)).status).toBe('verified')
    expect(verifyCommentAuthorship(application, 'note-1', signedWith(previousPair)).status).toBe('verified')
    expect(verifyCommentAuthorship(application, 'note-1', signedWith(unrelatedPair)).status).toBe('invalid')
  })

  it('uses only trusted local names, keeps unsigned legacy neutral, and quarantines invalid proofs', () => {
    const { application } = applicationFor({
      contactCurrentKey: currentPair.publicKey,
      contactName: 'Local contact name',
    })
    const verified = signedWith(currentPair)
    const forged = {
      ...signedWith(unrelatedPair),
      id: 'author-1:forged-1',
      authorName: 'Pretend to be Alice',
    }
    const legacy = { ...baseComment(), id: 'legacy-1', authorName: 'Pretend to be viewer' }
    const note = {
      uuid: 'note-1',
      getAppDomainValue: (key: unknown) => (key === NoteCommentsKey ? [verified, forged, legacy] : undefined),
    }

    const result = readDisplayNoteComments(application, note as never)
    expect(result.quarantinedCount).toBe(1)
    expect(result.comments).toEqual([
      expect.objectContaining({
        id: 'author-1:comment-1',
        authorshipStatus: 'verified',
        displayAuthorName: 'Local contact name',
        verifiedAuthorUuid: 'author-1',
      }),
      expect.objectContaining({
        id: 'legacy-1',
        authorshipStatus: 'legacy',
        displayAuthorName: 'Legacy comment',
      }),
    ])
    expect(result.comments[1]).not.toHaveProperty('verifiedAuthorUuid')
  })

  it('signs only for the captured session and exact unchanged root signing key', () => {
    const sessionUser = { uuid: 'author-1', email: 'author@example.test' }
    const harness = applicationFor({ sessionUser, rootPair: currentPair })
    const identity: NoteEncryptionIdentity = {
      noteUuid: 'note-1',
      userUuid: sessionUser.uuid,
      sessionUser,
      sourceId: 'source-1',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const captured = captureCommentSigningPublicKey(harness.application, identity)
    expect(captured).toBe(currentPair.publicKey)
    const signed = attestLocalComment(harness.application, identity, captured!, baseComment())
    expect(signed?.authorship?.signingPublicKey).toBe(currentPair.publicKey)
    expect(verifyCommentAuthorship(harness.application, 'note-1', signed!).status).toBe('verified')

    harness.replaceRootPair(previousPair)
    expect(attestLocalComment(harness.application, identity, captured!, baseComment())).toBeUndefined()
  })

  it('binds mutation operation, targets, actor clock, event, and note to the trusted signer', () => {
    const sessionUser = { uuid: 'author-1', email: 'author@example.test' }
    const harness = applicationFor({ sessionUser, rootPair: currentPair })
    const identity: NoteEncryptionIdentity = {
      noteUuid: 'note-1',
      userUuid: sessionUser.uuid,
      sessionUser,
      sourceId: 'source-1',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const unsigned: UnsignedNoteCommentMutationRecord = {
      operation: 'remove',
      commentId: 'author-1:comment-1',
      affectedCommentIds: ['author-1:comment-1', 'author-2:reply-1'],
      stamp: { counter: 7, actorUuid: 'author-1', eventId: 'event-7' },
    }
    const signed = attestLocalCommentMutation(harness.application, identity, currentPair.publicKey, unsigned)!

    expect(verifyCommentMutationAuthorship(harness.application, 'note-1', signed).status).toBe('verified')
    expect(verifyCommentMutationAuthorship(harness.application, 'note-2', signed).status).toBe('invalid')
    const tampered: NoteCommentMutationRecord[] = [
      { ...signed, operation: 'resolve', affectedCommentIds: [signed.commentId], resolved: true },
      { ...signed, commentId: 'author-1:comment-2' },
      { ...signed, affectedCommentIds: ['author-1:comment-1'] },
      { ...signed, stamp: { ...signed.stamp, counter: 8 } },
      { ...signed, stamp: { ...signed.stamp, actorUuid: 'author-2' } },
      { ...signed, stamp: { ...signed.stamp, eventId: 'fresh-envelope' } },
    ]
    for (const mutation of tampered) {
      expect(verifyCommentMutationAuthorship(harness.application, 'note-1', mutation).status).toBe('invalid')
    }

    const clockProof = clockProofFromMutation(signed)!
    expect(verifyCommentMutationClockProof(harness.application, 'note-1', clockProof)).toEqual(clockProof)
    expect(
      verifyCommentMutationClockProof(harness.application, 'note-1', {
        ...clockProof,
        stamp: { ...clockProof.stamp, counter: 8 },
      }),
    ).toBeUndefined()
  })

  it('rejects malformed or oversized proof fields during normalization', () => {
    const comment = baseComment()
    expect(
      normalizeComment({
        ...comment,
        authorship: {
          version: COMMENT_AUTHORSHIP_VERSION,
          signingPublicKey: 'x'.repeat(MAX_COMMENT_SIGNING_PUBLIC_KEY_LENGTH + 1),
          signature: 'bounded',
        },
      }),
    ).toBeNull()
    expect(
      normalizeComment({
        ...comment,
        authorship: {
          version: COMMENT_AUTHORSHIP_VERSION,
          signingPublicKey: 'bounded',
          signature: 'x'.repeat(MAX_COMMENT_SIGNATURE_LENGTH + 1),
        },
      }),
    ).toBeNull()
    expect(
      normalizeComment({ ...comment, authorship: { version: 2, signingPublicKey: 'key', signature: 'sig' } }),
    ).toBeNull()
  })
})
