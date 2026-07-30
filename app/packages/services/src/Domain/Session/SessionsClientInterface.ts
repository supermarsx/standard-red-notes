import { UserRegistrationResponseBody } from '@standardnotes/api'
import { SNRootKey } from '@standardnotes/encryption'
import { RootKeyInterface, ProtocolVersion } from '@standardnotes/models'
import {
  SessionBody,
  SignInResponse,
  User,
  HttpResponse,
  SessionListEntry,
  SessionListResponse,
} from '@standardnotes/responses'
import { Base64String } from '@standardnotes/sncrypto-common'

import { ProofOfWorkSolverInterface } from './ProofOfWorkSolverInterface'
import { SessionManagerResponse } from './SessionManagerResponse'

export type SessionRevocationFailure = {
  sessionId: string
  message: string
}

export type RevokeAllOtherSessionsResult = {
  requestedSessionIds: string[]
  revokedSessionIds: string[]
  failures: SessionRevocationFailure[]
  sessions: SessionListEntry[]
}

export interface SessionsClientInterface {
  getWorkspaceDisplayIdentifier(): string
  populateSessionFromDemoShareToken(token: Base64String): Promise<void>
  /**
   * Standard Red Notes: register the platform proof-of-work solver used to
   * answer a `proof-of-work-required` challenge during register / sign-in. When
   * unset, such a challenge is surfaced to the caller unchanged (safe: a stock
   * server never requires a proof — the feature is opt-in, disabled by default).
   */
  setProofOfWorkSolver(solver: ProofOfWorkSolverInterface): void

  getUser(): User | undefined
  isSignedIn(): boolean
  isSignedOut(): boolean
  get userUuid(): string
  getSureUser(): User
  isSignedIntoFirstPartyServer(): boolean

  getSessionsList(): Promise<HttpResponse<SessionListEntry[]>>
  refreshSessionIfExpiringSoon(): Promise<boolean>
  revokeSession(sessionId: string): Promise<HttpResponse<SessionListResponse>>
  revokeAllOtherSessions(): Promise<RevokeAllOtherSessionsResult>

  isCurrentSessionReadOnly(): boolean | undefined
  register(
    email: string,
    password: string,
    hvmToken: string,
    ephemeral: boolean,
    // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
    workspaceIdentifier?: string,
    // Standard Red Notes: optional invite-URL token (INVITE-URL signup control).
    inviteToken?: string,
  ): Promise<UserRegistrationResponseBody>
  signIn(
    email: string,
    password: string,
    strict: boolean,
    ephemeral: boolean,
    minAllowedVersion?: ProtocolVersion,
    hvmToken?: string,
    // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
    workspaceIdentifier?: string,
  ): Promise<SessionManagerResponse>
  bypassChecksAndSignInWithRootKey(
    email: string,
    rootKey: RootKeyInterface,
    ephemeral: boolean,
    hvmToken?: string,
    // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
    workspaceIdentifier?: string,
  ): Promise<HttpResponse<SignInResponse>>
  signOut(): Promise<void>
  changeCredentials(parameters: {
    currentServerPassword: string
    newRootKey: RootKeyInterface
    wrappingKey?: RootKeyInterface
    newEmail?: string
  }): Promise<SessionManagerResponse>
  handleAuthentication(dto: {
    session: SessionBody
    user: {
      uuid: string
      email: string
    }
    rootKey: SNRootKey
    wrappingKey?: SNRootKey
  }): Promise<void>

  getPublicKey(): string
  getSigningPublicKey(): string
  isUserMissingKeyPair(): boolean
}
