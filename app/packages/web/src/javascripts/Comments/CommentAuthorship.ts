import { WebCrypto } from '@/Application/Crypto'
import type { WebApplication } from '@/Application/WebApplication'
import type { NoteEncryptionIdentity } from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'
import type { SNNote } from '@standardnotes/snjs'
import {
  COMMENT_AUTHORSHIP_VERSION,
  COMMENT_MUTATION_AUTHORSHIP_VERSION,
  AuthenticatedNoteCommentMutationRecord,
  CommentMutationClockProof,
  MAX_COMMENT_AUTHOR_NAME_LENGTH,
  NoteCommentActorClock,
  NoteComment,
  NoteCommentMutationRecord,
  UnsignedNoteCommentMutationRecord,
  clockProofFromMutation,
  compareCommentMutationStamps,
  getBoundedNoteCommentActorClocks,
  getBoundedNoteCommentMutationRecords,
  getBoundedNoteComments,
  isAuthorNamespacedCommentId,
  normalizeComment,
  normalizeCommentMutationClockProof,
  normalizeCommentMutationRecord,
  sortCommentsByCreatedAt,
} from './comments'

const COMMENT_AUTHORSHIP_DOMAIN = 'standard-red-notes:note-comment-authorship:v1'
const COMMENT_MUTATION_AUTHORSHIP_DOMAIN = 'standard-red-notes:note-comment-mutation-authorship:v1'
const COMMENT_MUTATION_CLOCK_DOMAIN = 'standard-red-notes:note-comment-mutation-clock:v1'
const MAX_TRUSTED_SIGNING_KEY_HISTORY = 32

export type DisplayNoteComment = NoteComment & {
  authorshipStatus: 'verified' | 'legacy'
  displayAuthorName: string
  verifiedAuthorUuid?: string
}

export type DisplayNoteComments = {
  comments: DisplayNoteComment[]
  quarantinedCount: number
}

export type CommentAuthorshipVerification =
  | { status: 'verified'; comment: NoteComment; displayAuthorName: string }
  | { status: 'legacy'; comment: NoteComment }
  | { status: 'invalid' }

export type CommentMutationAuthorshipVerification =
  | { status: 'verified'; mutation: AuthenticatedNoteCommentMutationRecord }
  | { status: 'legacy'; mutation: NoteCommentMutationRecord }
  | { status: 'invalid' }

export type VerifiedCommentMutationState = {
  mutations: AuthenticatedNoteCommentMutationRecord[]
  clocks: NoteCommentActorClock[]
  quarantinedMutations: NoteCommentMutationRecord[]
  quarantinedClocks: NoteCommentActorClock[]
}

function canonicalAnchor(comment: NoteComment): unknown {
  const anchor = comment.anchor
  if (!anchor) {
    return null
  }
  return anchor.kind === 'super'
    ? ['super', anchor.blockKey, anchor.snippet ?? null]
    : ['plain', anchor.start, anchor.end, anchor.snippet ?? null]
}

/**
 * A versioned, deterministic signing message. `resolved` is deliberately absent:
 * it is collaborative mutable state. Every author-controlled immutable field,
 * including the untrusted legacy name snapshot, is covered.
 */
export function canonicalCommentAuthorshipMessage(noteUuid: string, value: NoteComment): string | undefined {
  const comment = normalizeComment(value)
  if (!noteUuid || !comment) {
    return undefined
  }
  return JSON.stringify([
    COMMENT_AUTHORSHIP_DOMAIN,
    noteUuid,
    comment.id,
    comment.authorUuid,
    comment.authorName,
    comment.text,
    comment.createdAt,
    canonicalAnchor(comment),
    comment.parentId ?? null,
    comment.mentions ?? [],
  ])
}

export function canonicalCommentMutationClockMessage(
  noteUuid: string,
  value: CommentMutationClockProof | NoteCommentMutationRecord,
): string | undefined {
  const stamp = 'stamp' in value ? value.stamp : undefined
  if (!noteUuid || !stamp) {
    return undefined
  }
  return JSON.stringify([COMMENT_MUTATION_CLOCK_DOMAIN, noteUuid, stamp.counter, stamp.actorUuid, stamp.eventId])
}

export function canonicalCommentMutationAuthorshipMessage(
  noteUuid: string,
  value: NoteCommentMutationRecord,
): string | undefined {
  const mutation = normalizeCommentMutationRecord(value)
  if (!noteUuid || !mutation) {
    return undefined
  }
  return JSON.stringify([
    COMMENT_MUTATION_AUTHORSHIP_DOMAIN,
    noteUuid,
    mutation.operation,
    mutation.commentId,
    mutation.affectedCommentIds,
    mutation.stamp.counter,
    mutation.stamp.actorUuid,
    mutation.stamp.eventId,
    mutation.operation === 'resolve' ? mutation.resolved : null,
  ])
}

function trustedContactForAuthor(application: WebApplication, authorUuid: string) {
  const self = application.contacts.getSelfContact()
  if (self?.contactUuid === authorUuid) {
    return self
  }
  const contact = application.contacts.findContact(authorUuid)
  return contact?.contactUuid === authorUuid ? contact : undefined
}

function contactTrustsSigningKey(
  contact: ReturnType<WebApplication['contacts']['findContact']>,
  signingPublicKey: string,
): boolean {
  if (!contact) {
    return false
  }
  let keySet: typeof contact.publicKeySet | undefined = contact.publicKeySet
  const seen = new Set<object>()
  for (let depth = 0; keySet && depth < MAX_TRUSTED_SIGNING_KEY_HISTORY; depth += 1) {
    if (seen.has(keySet)) {
      return false
    }
    seen.add(keySet)
    if (keySet.signing === signingPublicKey) {
      return true
    }
    keySet = keySet.previousKeySet
  }
  return false
}

function currentSelfKeyMatches(application: WebApplication, authorUuid: string, signingPublicKey: string): boolean {
  try {
    const user = application.sessions.getUser()
    const signingKeyPair = application.encryption.getRootKey()?.signingKeyPair
    return user?.uuid === authorUuid && signingKeyPair?.publicKey === signingPublicKey
  } catch {
    return false
  }
}

function trustedDisplayName(contact: ReturnType<WebApplication['contacts']['findContact']>, isSelf: boolean): string {
  if (isSelf) {
    return 'You'
  }
  const name = contact?.name?.trim()
  return name ? name.slice(0, MAX_COMMENT_AUTHOR_NAME_LENGTH) : 'Verified collaborator'
}

export function verifyCommentAuthorship(
  application: WebApplication,
  noteUuid: string,
  value: NoteComment,
): CommentAuthorshipVerification {
  const comment = normalizeComment(value)
  if (!comment) {
    return { status: 'invalid' }
  }
  if (!comment.authorship) {
    return { status: 'legacy', comment }
  }

  try {
    const message = canonicalCommentAuthorshipMessage(noteUuid, comment)
    if (!message) {
      return { status: 'invalid' }
    }
    const contact = trustedContactForAuthor(application, comment.authorUuid)
    const isSelf = application.sessions.getUser()?.uuid === comment.authorUuid
    if (
      !contactTrustsSigningKey(contact, comment.authorship.signingPublicKey) &&
      !currentSelfKeyMatches(application, comment.authorUuid, comment.authorship.signingPublicKey)
    ) {
      return { status: 'invalid' }
    }
    if (!WebCrypto.sodiumCryptoSignVerify(message, comment.authorship.signature, comment.authorship.signingPublicKey)) {
      return { status: 'invalid' }
    }
    return {
      status: 'verified',
      comment,
      displayAuthorName: trustedDisplayName(contact, isSelf),
    }
  } catch {
    return { status: 'invalid' }
  }
}

type PersistableCommentVerification = Exclude<CommentAuthorshipVerification, { status: 'invalid' }>

function partitionPersistableComments(
  application: WebApplication,
  noteUuid: string,
  comments: NoteComment[],
): { accepted: PersistableCommentVerification[]; quarantinedCount: number } {
  const acceptedById = new Map<string, PersistableCommentVerification>()
  let quarantinedCount = 0
  for (const comment of comments) {
    const verification = verifyCommentAuthorship(application, noteUuid, comment)
    if (verification.status === 'invalid') {
      quarantinedCount += 1
      continue
    }
    const existing = acceptedById.get(verification.comment.id)
    const verificationRank = verification.status === 'verified' ? 2 : 1
    const existingRank = existing?.status === 'verified' ? 2 : existing ? 1 : 0
    if (
      !existing ||
      verificationRank > existingRank ||
      (verificationRank === existingRank && JSON.stringify(verification.comment) < JSON.stringify(existing.comment))
    ) {
      acceptedById.set(verification.comment.id, verification)
    }
  }
  const ordered = sortCommentsByCreatedAt([...acceptedById.values()].map((value) => value.comment))
  return {
    accepted: ordered.map((comment) => acceptedById.get(comment.id)!),
    quarantinedCount,
  }
}

function signingKeyIsTrustedForActor(
  application: WebApplication,
  actorUuid: string,
  signingPublicKey: string,
): boolean {
  const contact = trustedContactForAuthor(application, actorUuid)
  return (
    contactTrustsSigningKey(contact, signingPublicKey) ||
    currentSelfKeyMatches(application, actorUuid, signingPublicKey)
  )
}

export function verifyCommentMutationClockProof(
  application: WebApplication,
  noteUuid: string,
  value: CommentMutationClockProof,
  expectedActorUuid = value.stamp.actorUuid,
): CommentMutationClockProof | undefined {
  try {
    const proof = normalizeCommentMutationClockProof(value)
    if (
      !proof ||
      proof.stamp.actorUuid !== expectedActorUuid ||
      !signingKeyIsTrustedForActor(application, expectedActorUuid, proof.signingPublicKey)
    ) {
      return undefined
    }
    const message = canonicalCommentMutationClockMessage(noteUuid, proof)
    if (!message || !WebCrypto.sodiumCryptoSignVerify(message, proof.signature, proof.signingPublicKey)) {
      return undefined
    }
    return proof
  } catch {
    return undefined
  }
}

export function verifyCommentMutationAuthorship(
  application: WebApplication,
  noteUuid: string,
  value: NoteCommentMutationRecord,
): CommentMutationAuthorshipVerification {
  const mutation = normalizeCommentMutationRecord(value)
  if (!mutation) {
    return { status: 'invalid' }
  }
  if (!mutation.authorship) {
    return { status: 'legacy', mutation }
  }
  try {
    if (!signingKeyIsTrustedForActor(application, mutation.stamp.actorUuid, mutation.authorship.signingPublicKey)) {
      return { status: 'invalid' }
    }
    const message = canonicalCommentMutationAuthorshipMessage(noteUuid, mutation)
    const clockMessage = canonicalCommentMutationClockMessage(noteUuid, mutation)
    if (
      !message ||
      !clockMessage ||
      !WebCrypto.sodiumCryptoSignVerify(message, mutation.authorship.signature, mutation.authorship.signingPublicKey) ||
      !WebCrypto.sodiumCryptoSignVerify(
        clockMessage,
        mutation.authorship.clockSignature,
        mutation.authorship.signingPublicKey,
      )
    ) {
      return { status: 'invalid' }
    }
    return { status: 'verified', mutation: mutation as AuthenticatedNoteCommentMutationRecord }
  } catch {
    return { status: 'invalid' }
  }
}

/** Capture the public signing identity before an operation enters its queue. */
export function captureCommentSigningPublicKey(
  application: WebApplication,
  expectedIdentity: NoteEncryptionIdentity,
): string | undefined {
  try {
    const user = application.sessions.getUser()
    const signingKeyPair = application.encryption.getRootKey()?.signingKeyPair
    const sessionSigningPublicKey = application.sessions.getSigningPublicKey()
    if (
      user !== expectedIdentity.sessionUser ||
      user.uuid !== expectedIdentity.userUuid ||
      !signingKeyPair ||
      signingKeyPair.publicKey !== sessionSigningPublicKey
    ) {
      return undefined
    }
    return signingKeyPair.publicKey
  } catch {
    return undefined
  }
}

/** Sign only while the queued operation still belongs to the captured session/key. */
export function attestLocalComment(
  application: WebApplication,
  expectedIdentity: NoteEncryptionIdentity,
  expectedSigningPublicKey: string,
  value: NoteComment,
): NoteComment | undefined {
  try {
    const comment = normalizeComment(value)
    const userBefore = application.sessions.getUser()
    const rootKeyBefore = application.encryption.getRootKey()
    const signingKeyPair = rootKeyBefore?.signingKeyPair
    if (
      !comment ||
      !isAuthorNamespacedCommentId(comment.id, comment.authorUuid) ||
      userBefore !== expectedIdentity.sessionUser ||
      userBefore.uuid !== expectedIdentity.userUuid ||
      comment.authorUuid !== expectedIdentity.userUuid ||
      !signingKeyPair ||
      signingKeyPair.publicKey !== expectedSigningPublicKey ||
      application.sessions.getSigningPublicKey() !== expectedSigningPublicKey
    ) {
      return undefined
    }

    const unsigned = { ...comment }
    delete unsigned.authorship
    const message = canonicalCommentAuthorshipMessage(expectedIdentity.noteUuid, unsigned)
    if (!message) {
      return undefined
    }
    const signature = WebCrypto.sodiumCryptoSign(message, signingKeyPair.privateKey)
    const signed = normalizeComment({
      ...unsigned,
      authorship: {
        version: COMMENT_AUTHORSHIP_VERSION,
        signingPublicKey: expectedSigningPublicKey,
        signature,
      },
    })

    if (
      !signed ||
      application.sessions.getUser() !== userBefore ||
      application.encryption.getRootKey() !== rootKeyBefore ||
      application.sessions.getSigningPublicKey() !== expectedSigningPublicKey
    ) {
      return undefined
    }
    return signed
  } catch {
    return undefined
  }
}

export function attestLocalCommentMutation(
  application: WebApplication,
  expectedIdentity: NoteEncryptionIdentity,
  expectedSigningPublicKey: string,
  value: UnsignedNoteCommentMutationRecord,
): AuthenticatedNoteCommentMutationRecord | undefined {
  try {
    const mutation = normalizeCommentMutationRecord(value)
    const userBefore = application.sessions.getUser()
    const rootKeyBefore = application.encryption.getRootKey()
    const signingKeyPair = rootKeyBefore?.signingKeyPair
    if (
      !mutation ||
      mutation.authorship ||
      userBefore !== expectedIdentity.sessionUser ||
      userBefore.uuid !== expectedIdentity.userUuid ||
      mutation.stamp.actorUuid !== expectedIdentity.userUuid ||
      !signingKeyPair ||
      signingKeyPair.publicKey !== expectedSigningPublicKey ||
      application.sessions.getSigningPublicKey() !== expectedSigningPublicKey
    ) {
      return undefined
    }
    const message = canonicalCommentMutationAuthorshipMessage(expectedIdentity.noteUuid, mutation)
    const clockMessage = canonicalCommentMutationClockMessage(expectedIdentity.noteUuid, mutation)
    if (!message || !clockMessage) {
      return undefined
    }
    const signed = normalizeCommentMutationRecord({
      ...mutation,
      authorship: {
        version: COMMENT_MUTATION_AUTHORSHIP_VERSION,
        signingPublicKey: expectedSigningPublicKey,
        signature: WebCrypto.sodiumCryptoSign(message, signingKeyPair.privateKey),
        clockSignature: WebCrypto.sodiumCryptoSign(clockMessage, signingKeyPair.privateKey),
      },
    })
    if (
      !signed?.authorship ||
      application.sessions.getUser() !== userBefore ||
      application.encryption.getRootKey() !== rootKeyBefore ||
      application.sessions.getSigningPublicKey() !== expectedSigningPublicKey
    ) {
      return undefined
    }
    return signed as AuthenticatedNoteCommentMutationRecord
  } catch {
    return undefined
  }
}

export function clockProofForAuthenticatedMutation(
  mutation: AuthenticatedNoteCommentMutationRecord,
): CommentMutationClockProof {
  return clockProofFromMutation(mutation)!
}

/**
 * Partition persisted replay state without allowing unverifiable/legacy proofs
 * to influence trusted ordering. Quarantined entries remain available for an
 * exact storage rewrite if contact/key trust is temporarily unavailable.
 */
export function readVerifiedCommentMutationState(
  application: WebApplication,
  noteUuid: string,
  note: SNNote,
): VerifiedCommentMutationState | undefined {
  const storedMutations = getBoundedNoteCommentMutationRecords(note)
  const storedClocks = getBoundedNoteCommentActorClocks(note)
  if (!storedMutations || !storedClocks) {
    return undefined
  }

  const quarantinedMutations: NoteCommentMutationRecord[] = []
  const verifiedByEvent = new Map<string, AuthenticatedNoteCommentMutationRecord>()
  const conflictingEvents = new Set<string>()
  for (const stored of storedMutations) {
    const verification = verifyCommentMutationAuthorship(application, noteUuid, stored)
    if (verification.status !== 'verified') {
      quarantinedMutations.push(stored)
      continue
    }
    const mutation = verification.mutation
    const eventKey = `${mutation.stamp.actorUuid}\u0000${mutation.stamp.counter}\u0000${mutation.stamp.eventId}`
    const existing = verifiedByEvent.get(eventKey)
    if (existing && JSON.stringify(existing) !== JSON.stringify(mutation)) {
      conflictingEvents.add(eventKey)
      quarantinedMutations.push(existing, mutation)
      verifiedByEvent.delete(eventKey)
      continue
    }
    if (!conflictingEvents.has(eventKey)) {
      verifiedByEvent.set(eventKey, mutation)
    } else {
      quarantinedMutations.push(mutation)
    }
  }

  const quarantinedClocks: NoteCommentActorClock[] = []
  const clocksByActor = new Map<string, NoteCommentActorClock>()
  for (const clock of storedClocks) {
    const highWater = verifyCommentMutationClockProof(application, noteUuid, clock.highWater, clock.actorUuid)
    const replayFloor = clock.replayFloor
      ? verifyCommentMutationClockProof(application, noteUuid, clock.replayFloor, clock.actorUuid)
      : undefined
    if (!highWater || (clock.replayFloor && !replayFloor)) {
      quarantinedClocks.push(clock)
      continue
    }
    const existing = clocksByActor.get(clock.actorUuid)
    const nextHighWater =
      existing && compareCommentMutationStamps(existing.highWater.stamp, highWater.stamp) >= 0
        ? existing.highWater
        : highWater
    const nextReplayFloor = [existing?.replayFloor, replayFloor]
      .filter((value): value is CommentMutationClockProof => Boolean(value))
      .sort((left, right) => compareCommentMutationStamps(right.stamp, left.stamp))[0]
    clocksByActor.set(clock.actorUuid, {
      actorUuid: clock.actorUuid,
      highWater: nextHighWater,
      ...(nextReplayFloor ? { replayFloor: nextReplayFloor } : {}),
    })
  }

  for (const mutation of verifiedByEvent.values()) {
    const proof = clockProofFromMutation(mutation)
    if (!proof) {
      quarantinedMutations.push(mutation)
      continue
    }
    const clock = clocksByActor.get(mutation.stamp.actorUuid)
    if (!clock || compareCommentMutationStamps(proof.stamp, clock.highWater.stamp) > 0) {
      clocksByActor.set(mutation.stamp.actorUuid, {
        actorUuid: mutation.stamp.actorUuid,
        highWater: proof,
        ...(clock?.replayFloor ? { replayFloor: clock.replayFloor } : {}),
      })
    }
  }

  const mutations = [...verifiedByEvent.values()].filter((mutation) => {
    const floor = clocksByActor.get(mutation.stamp.actorUuid)?.replayFloor
    return !floor || compareCommentMutationStamps(mutation.stamp, floor.stamp) > 0
  })
  return {
    mutations,
    clocks: [...clocksByActor.values()],
    quarantinedMutations,
    quarantinedClocks,
  }
}

export function commentsAllowedForPersistence(
  application: WebApplication,
  noteUuid: string,
  comments: NoteComment[],
): NoteComment[] {
  return partitionPersistableComments(application, noteUuid, comments).accepted.map((value) => value.comment)
}

export function readDisplayNoteComments(application: WebApplication, note: SNNote): DisplayNoteComments {
  const stored = getBoundedNoteComments(note)
  if (!stored) {
    return { comments: [], quarantinedCount: 1 }
  }
  const partitioned = partitionPersistableComments(application, note.uuid, stored)
  const comments: DisplayNoteComment[] = []
  for (const verification of partitioned.accepted) {
    if (verification.status === 'legacy') {
      comments.push({
        ...verification.comment,
        authorshipStatus: 'legacy',
        displayAuthorName: 'Legacy comment',
      })
      continue
    }
    comments.push({
      ...verification.comment,
      authorshipStatus: 'verified',
      displayAuthorName: verification.displayAuthorName,
      verifiedAuthorUuid: verification.comment.authorUuid,
    })
  }
  return { comments, quarantinedCount: partitioned.quarantinedCount }
}
