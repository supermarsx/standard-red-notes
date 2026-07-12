import {
  AlertService,
  AbstractService,
  InternalEventBusInterface,
  StorageKey,
  ChallengePrompt,
  ChallengeValidation,
  ChallengeKeyboardType,
  ChallengeReason,
  ChallengePromptTitle,
  EncryptionService,
  SessionsClientInterface,
  SessionManagerResponse,
  SessionStrings,
  SignInStrings,
  INVALID_PASSWORD_COST,
  API_MESSAGE_FALLBACK_LOGIN_FAIL,
  API_MESSAGE_GENERIC_SYNC_FAIL,
  EXPIRED_PROTOCOL_VERSION,
  StrictSignInFailed,
  UNSUPPORTED_KEY_DERIVATION,
  UNSUPPORTED_PROTOCOL_VERSION,
  Challenge,
  InternalEventHandlerInterface,
  InternalEventInterface,
  ApiServiceEvent,
  SessionRefreshedData,
  SessionEvent,
  UserKeyPairChangedEventData,
  InternalFeatureService,
  InternalFeature,
  ProofOfWorkSolverInterface,
  ApplicationEvent,
  ApplicationStageChangedEventPayload,
  ApplicationStage,
  GetKeyPairs,
  IsApplicationUsingThirdPartyHost,
  WebSocketsService,
} from '@standardnotes/services'
import { Base64String, PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { sleep } from '@standardnotes/utils'
import {
  SessionBody,
  ErrorTag,
  HttpResponse,
  isErrorResponse,
  SessionListEntry,
  User,
  KeyParamsResponse,
  SignInResponse,
  ChangeCredentialsResponse,
  SessionListResponse,
  HttpSuccessResponse,
  getErrorFromErrorResponse,
} from '@standardnotes/responses'
import {
  CopyPayloadWithContentOverride,
  RootKeyWithKeyPairsInterface,
  isProtocolVersionExpired,
} from '@standardnotes/models'
import { LegacySession, MapperInterface, Result, Session, SessionToken } from '@standardnotes/domain-core'
import { KeyParamsFromApiResponse, SNRootKeyParams, SNRootKey } from '@standardnotes/encryption'
import * as Common from '@standardnotes/common'

import { RawStorageValue } from './Sessions/Types'
import { ShareToken } from './ShareToken'
import { LegacyApiService } from '../Api/ApiService'
import { DiskStorageService } from '../Storage/DiskStorageService'
import { Strings } from '@Lib/Strings'
import { UuidString } from '@Lib/Types/UuidString'
import { ChallengeResponse, ChallengeService } from '../Challenge'
import {
  ApiCallError,
  ErrorMessage,
  HttpServiceInterface,
  UserApiServiceInterface,
  UserRegistrationResponseBody,
} from '@standardnotes/api'
import { cleanedEmailString } from './cleanedEmailString'

export const MINIMUM_PASSWORD_LENGTH = 8
export const MissingAccountParams = 'missing-params'
const ThirtyMinutes = 30 * 60 * 1000

/**
 * Standard Red Notes: how many times we will solve-and-resubmit a proof-of-work
 * challenge for a single register / sign-in-params request before giving up and
 * surfacing an error. The server mints a FRESH challenge in every unsolved
 * response, so a second pass transparently replaces one that expired or was
 * consumed between fetch and submit; beyond that we stop rather than loop.
 */
const MAX_PROOF_OF_WORK_ATTEMPTS = 2
const PROOF_OF_WORK_FAILED_MESSAGE = 'Could not complete the anti-bot verification challenge. Please try again.'

/**
 * The session manager is responsible for loading initial user state, and any relevant
 * server credentials, such as the session token. It also exposes methods for registering
 * for a new account, signing into an existing one, or changing an account password.
 */
export class SessionManager
  extends AbstractService<SessionEvent>
  implements SessionsClientInterface, InternalEventHandlerInterface
{
  private user?: User
  private isSessionRenewChallengePresented = false
  private session?: Session | LegacySession
  /**
   * Standard Red Notes: platform solver for the proof-of-work anti-bot
   * challenge, registered by the host app (the web/desktop build wires a
   * Web-Worker-backed solver). Left unset on platforms that have not wired one;
   * a proof-of-work challenge is then surfaced to the caller unchanged, which is
   * safe because the server feature is opt-in (disabled by default).
   */
  private proofOfWorkSolver?: ProofOfWorkSolverInterface

  constructor(
    private storage: DiskStorageService,
    private apiService: LegacyApiService,
    private userApiService: UserApiServiceInterface,
    private alertService: AlertService,
    private encryptionService: EncryptionService,
    private crypto: PureCryptoInterface,
    private challengeService: ChallengeService,
    private webSocketsService: WebSocketsService,
    private httpService: HttpServiceInterface,
    private sessionStorageMapper: MapperInterface<Session, Record<string, unknown>>,
    private legacySessionStorageMapper: MapperInterface<LegacySession, Record<string, unknown>>,
    private workspaceIdentifier: string,
    private _getKeyPairs: GetKeyPairs,
    private isApplicationUsingThirdPartyHostUseCase: IsApplicationUsingThirdPartyHost,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
    apiService.setInvalidSessionObserver((revoked) => {
      if (revoked) {
        void this.notifyEvent(SessionEvent.Revoked)
      } else {
        void this.reauthenticateInvalidSession()
      }
    })
  }

  setProofOfWorkSolver(solver: ProofOfWorkSolverInterface): void {
    this.proofOfWorkSolver = solver
  }

  /**
   * Standard Red Notes: pull a proof-of-work challenge out of a server error
   * response. Returns undefined for any response that is not a well-formed
   * `proof-of-work-required` challenge, so callers fall through to their normal
   * error handling unchanged.
   */
  private extractProofOfWorkChallenge(
    error: { tag?: string; payload?: Record<string, unknown> } | undefined,
  ): { seed: string; difficulty: number; algorithm: string } | undefined {
    if (error?.tag !== ErrorTag.ProofOfWorkRequired) {
      return undefined
    }
    const pow = error.payload?.['pow'] as Record<string, unknown> | undefined
    if (!pow || typeof pow !== 'object') {
      return undefined
    }
    const seed = pow['seed']
    const difficulty = pow['difficulty']
    const algorithm = pow['algorithm']
    if (typeof seed !== 'string' || typeof difficulty !== 'number' || typeof algorithm !== 'string') {
      return undefined
    }
    return { seed, difficulty, algorithm }
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    switch (event.type) {
      case ApiServiceEvent.SessionRefreshed:
        this.httpService.setSession((event.payload as SessionRefreshedData).session)
        break

      case ApplicationEvent.ApplicationStageChanged: {
        const stage = (event.payload as ApplicationStageChangedEventPayload).stage
        if (stage === ApplicationStage.StorageDecrypted_09) {
          await this.initializeFromDisk()
        }
      }
    }
  }

  override deinit(): void {
    ;(this.encryptionService as unknown) = undefined
    ;(this.storage as unknown) = undefined
    ;(this.apiService as unknown) = undefined
    ;(this.alertService as unknown) = undefined
    ;(this.challengeService as unknown) = undefined
    ;(this.webSocketsService as unknown) = undefined
    this.user = undefined
    super.deinit()
  }

  public getWorkspaceDisplayIdentifier(): string {
    if (this.user) {
      return this.user.email
    } else {
      return this.workspaceIdentifier
    }
  }

  private memoizeUser(user?: User) {
    this.user = user

    this.apiService.setUser(user)
  }

  private async initializeFromDisk(): Promise<void> {
    this.memoizeUser(this.storage.getValue(StorageKey.User))

    if (!this.user) {
      const legacyUuidLookup = this.storage.getValue<string>(StorageKey.LegacyUuid)
      if (legacyUuidLookup) {
        this.memoizeUser({ uuid: legacyUuidLookup, email: legacyUuidLookup })
      }
    }

    const serverHost = this.storage.getValue<string | undefined>(StorageKey.ServerHost)
    if (serverHost) {
      void this.apiService.setHost(serverHost)
      this.httpService.setHost(serverHost)
    }

    const rawSession = this.storage.getValue<RawStorageValue>(StorageKey.Session)
    if (rawSession) {
      try {
        const session =
          'jwt' in rawSession
            ? this.legacySessionStorageMapper.toDomain(rawSession)
            : this.sessionStorageMapper.toDomain(rawSession)

        this.setSession(session, false)
      } catch (error) {
        console.error(`Could not deserialize session from storage: ${(error as Error).message}`)
      }
    }
  }

  private setSession(session: Session | LegacySession, persist = true): void {
    this.session = session

    this.httpService.setSession(session)

    this.apiService.setSession(session, persist)

    if (this.isSignedIntoFirstPartyServer()) {
      void this.webSocketsService.startWebSocketConnection()
    }
  }

  public online() {
    return !this.offline()
  }

  public offline() {
    return this.apiService.getSession() == undefined
  }

  public getUser(): User | undefined {
    return this.user
  }

  public getSureUser(): User {
    return this.user as User
  }

  isUserMissingKeyPair(): boolean {
    try {
      return this.getPublicKey() == undefined
    } catch (error) {
      return true
    }
  }

  public getPublicKey(): string {
    const keys = this._getKeyPairs.execute()

    return keys.getValue().encryption.publicKey
  }

  public getSigningPublicKey(): string {
    const keys = this._getKeyPairs.execute()

    return keys.getValue().signing.publicKey
  }

  public get userUuid(): string {
    const user = this.getUser()

    if (!user) {
      throw Error('Attempting to access userUuid when user is undefined')
    }

    return user.uuid
  }

  isCurrentSessionReadOnly(): boolean | undefined {
    if (this.session === undefined) {
      return undefined
    }

    if (this.session instanceof LegacySession) {
      return false
    }

    return this.session.isReadOnly()
  }

  public getSession() {
    return this.apiService.getSession()
  }

  public async signOut() {
    this.memoizeUser(undefined)

    const session = this.apiService.getSession()
    if (session && session instanceof Session) {
      await this.apiService.signOut()
      this.webSocketsService.closeWebSocketConnection()
    }
  }

  /** Unlike EncryptionService.hasAccount, isSignedIn can only be read once the application is unlocked */
  public isSignedIn(): boolean {
    return this.getUser() != undefined
  }

  public isSignedOut(): boolean {
    return !this.isSignedIn()
  }

  public isSignedIntoFirstPartyServer(): boolean {
    const isThirdPartyHostUsedOrError = this.isApplicationUsingThirdPartyHostUseCase.execute()
    if (isThirdPartyHostUsedOrError.isFailed()) {
      return false
    }
    const isThirdPartyHostUsed = isThirdPartyHostUsedOrError.getValue()

    return this.isSignedIn() && !isThirdPartyHostUsed
  }

  public async reauthenticateInvalidSession(
    cancelable = true,
    onResponse?: (response: HttpResponse) => void,
  ): Promise<void> {
    if (this.isSessionRenewChallengePresented) {
      return
    }
    this.isSessionRenewChallengePresented = true
    const challenge = new Challenge(
      [
        new ChallengePrompt(ChallengeValidation.None, undefined, SessionStrings.EmailInputPlaceholder, false),
        new ChallengePrompt(ChallengeValidation.None, undefined, SessionStrings.PasswordInputPlaceholder),
      ],
      ChallengeReason.Custom,
      cancelable,
      SessionStrings.EnterEmailAndPassword,
      SessionStrings.RecoverSession(this.getUser()?.email),
    )
    return new Promise((resolve) => {
      this.challengeService.addChallengeObserver(challenge, {
        onCancel: () => {
          this.isSessionRenewChallengePresented = false
        },
        onComplete: () => {
          this.isSessionRenewChallengePresented = false
        },
        onNonvalidatedSubmit: async (challengeResponse) => {
          const email = challengeResponse.values[0].value as string
          const password = challengeResponse.values[1].value as string
          const currentKeyParams = this.encryptionService.getAccountKeyParams()
          const { response } = await this.signIn(
            email,
            password,
            false,
            this.storage.isEphemeralSession(),
            currentKeyParams?.version,
          )
          if (isErrorResponse(response)) {
            this.challengeService.setValidationStatusForChallenge(
              challenge,
              (challengeResponse as ChallengeResponse).values[1],
              false,
            )
            onResponse?.(response)
          } else {
            resolve()
            this.challengeService.completeChallenge(challenge)
            void this.notifyEvent(SessionEvent.Restored)
            void this.alertService.alert(SessionStrings.SessionRestored)
          }
        },
      })
      void this.challengeService.promptForChallengeResponse(challenge)
    })
  }

  private async promptForU2FVerification(username: string): Promise<Record<string, unknown> | undefined> {
    const challenge = new Challenge(
      [
        new ChallengePrompt(
          ChallengeValidation.Authenticator,
          ChallengePromptTitle.U2F,
          undefined,
          false,
          undefined,
          undefined,
          {
            username,
          },
        ),
      ],
      ChallengeReason.Custom,
      true,
      SessionStrings.InputU2FDevice,
    )

    const response = await this.challengeService.promptForChallengeResponse(challenge)

    if (!response) {
      return undefined
    }

    return response.values[0].value as Record<string, unknown>
  }

  /**
   * Requests a magic-link one-time code from the server. When SMTP is configured
   * server-side the code is emailed and nothing is returned here; when it is not
   * configured the server returns the code so it can be shown on screen as a fallback.
   */
  private async requestMagicLinkCode(email: string): Promise<string | undefined> {
    try {
      const response = await this.httpService.post<{ emailed?: boolean; code?: string }>(
        '/v1/mfa/magic-link/request',
        { email },
      )

      if (isErrorResponse(response)) {
        return undefined
      }

      return response.data?.code
    } catch (error) {
      return undefined
    }
  }

  /**
   * Standard Red Notes: push-MFA aware second-factor prompt.
   *
   * Presents the interactive TOTP/magic-link code prompt exactly as before.
   * When the server's MFA error additionally carried a pending push-approval
   * challenge id (`mfa_approval_challenge_id`, see auth BaseAuthController
   * pkceParams), we CONCURRENTLY poll the unauthenticated status endpoint while
   * the prompt is open:
   *  - 'approved' -> the prompt is dismissed; the caller re-attempts sign-in.
   *  - 'denied'   -> the prompt is dismissed; the caller aborts the sign-in.
   *  - 'expired' (or the endpoint becoming unreachable) -> polling stops
   *    silently and the interactive code prompt remains fully usable.
   * Push approval is strictly ADDITIVE — the interactive code path is never
   * removed, mirroring the server's contract.
   */
  private async promptForMfaValue(options?: {
    onScreenCode?: string
    approvalChallengeId?: string
    approvedElsewhereButCodeStillRequired?: boolean
  }): Promise<{ mfaCode?: string; pushApprovalStatus?: 'approved' | 'denied' } | undefined> {
    let heading = options?.onScreenCode
      ? `${SessionStrings.EnterMfa} Your verification code is: ${options.onScreenCode}`
      : SessionStrings.EnterMfa
    if (options?.approvedElsewhereButCodeStillRequired) {
      heading = `${SessionStrings.MfaPushApprovedButCodeStillRequired} ${heading}`
    }

    const subheading = options?.approvalChallengeId ? SessionStrings.MfaPushApprovalHint : undefined

    const challenge = new Challenge(
      [
        new ChallengePrompt(
          ChallengeValidation.None,
          ChallengePromptTitle.Mfa,
          SessionStrings.MfaInputPlaceholder,
          false,
          ChallengeKeyboardType.Numeric,
        ),
      ],
      ChallengeReason.Custom,
      true,
      heading,
      subheading,
    )

    type PromptOutcome =
      | { kind: 'prompt'; response: ChallengeResponse | undefined }
      | { kind: 'poll'; status: 'approved' | 'denied' | 'expired' | 'unavailable' }

    const promptPromise = this.challengeService.promptForChallengeResponse(challenge)

    let pollingStopped = false
    const racers: Promise<PromptOutcome>[] = [
      promptPromise.then((response): PromptOutcome => ({ kind: 'prompt', response })),
    ]
    if (options?.approvalChallengeId) {
      racers.push(
        this.pollPendingMfaApprovalStatus(options.approvalChallengeId, () => pollingStopped).then(
          (status): PromptOutcome => ({ kind: 'poll', status }),
        ),
      )
    }

    let outcome = await Promise.race(racers)

    if (outcome.kind === 'poll') {
      if (outcome.status === 'approved' || outcome.status === 'denied') {
        try {
          this.challengeService.cancelChallenge(challenge)
        } catch (error) {
          void error
        }
        return { pushApprovalStatus: outcome.status }
      }
      /** Approval expired / endpoint unreachable: the code prompt is the only remaining path. */
      outcome = { kind: 'prompt', response: await promptPromise }
    }

    pollingStopped = true

    if (outcome.response) {
      this.challengeService.completeChallenge(challenge)
      return { mfaCode: outcome.response.values[0].value as string }
    }

    return undefined
  }

  /**
   * Standard Red Notes: poll the UNAUTHENTICATED push-approval status endpoint
   * with the high-entropy challenge id (the only credential the not-yet-signed-in
   * device holds). Resolves on any terminal status; resolves 'unavailable' when
   * asked to stop or after repeated request failures (never blocks the sign-in).
   */
  private async pollPendingMfaApprovalStatus(
    challengeId: string,
    isStopped: () => boolean,
  ): Promise<'approved' | 'denied' | 'expired' | 'unavailable'> {
    const PollIntervalMs = 3000
    const MaxConsecutiveFailures = 5

    let consecutiveFailures = 0

    while (!isStopped()) {
      await sleep(PollIntervalMs, false)
      if (isStopped()) {
        break
      }

      try {
        const response = await this.apiService.getPendingMfaApprovalStatus(challengeId)
        if (isErrorResponse(response)) {
          consecutiveFailures += 1
        } else {
          consecutiveFailures = 0
          const status = (response as { data?: { status?: string } }).data?.status
          if (status === 'approved' || status === 'denied' || status === 'expired') {
            return status
          }
        }
      } catch (error) {
        void error
        consecutiveFailures += 1
      }

      if (consecutiveFailures >= MaxConsecutiveFailures) {
        return 'unavailable'
      }
    }

    return 'unavailable'
  }

  async register(
    email: string,
    password: string,
    hvmToken: string,
    ephemeral: boolean,
    // Standard Red Notes: optional workspace name for "multiple accounts per
    // email" (WORKSPACES_PER_EMAIL_ENABLED). Trailing optional param so existing
    // callers are unaffected; ignored by the server unless the flag is on.
    workspaceIdentifier?: string,
    // Standard Red Notes: optional invite-URL token (INVITE-URL signup control).
    // Trailing optional param so existing callers are unaffected; only sent to the
    // server when the client captured a `?invite=<token>` param.
    inviteToken?: string,
  ): Promise<UserRegistrationResponseBody> {
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      throw new ApiCallError(
        ErrorMessage.InsufficientPasswordMessage.replace('%LENGTH%', MINIMUM_PASSWORD_LENGTH.toString()),
      )
    }

    const { wrappingKey, canceled } = await this.challengeService.getWrappingKeyIfApplicable()
    if (canceled) {
      throw new ApiCallError(ErrorMessage.PasscodeRequired)
    }

    email = cleanedEmailString(email)

    const rootKey = await this.encryptionService.createRootKey<RootKeyWithKeyPairsInterface>(
      email,
      password,
      Common.KeyParamsOrigination.Registration,
    )
    const serverPassword = rootKey.serverPassword as string
    const keyParams = rootKey.keyParams

    // Standard Red Notes: proof-of-work anti-bot loop. The first attempt carries
    // no proof; if the server has registration PoW enabled it answers with a
    // `proof-of-work-required` challenge, which we solve off the UI thread and
    // resubmit. Each unsolved response embeds a fresh challenge, so a bounded
    // number of passes transparently handles one that expired/was consumed. When
    // PoW is disabled (the default) the first attempt already succeeds and none
    // of this runs.
    let powSeed: string | undefined
    let powNonce: string | undefined
    let proofOfWorkAttempts = 0

    for (;;) {
      const registerResponse = await this.userApiService.register({
        email,
        serverPassword,
        hvmToken,
        keyParams,
        ephemeral,
        workspaceIdentifier,
        powSeed,
        powNonce,
        inviteToken,
      })

      if (isErrorResponse(registerResponse)) {
        const error = getErrorFromErrorResponse(registerResponse)
        const challenge = this.extractProofOfWorkChallenge(error)
        if (challenge && this.proofOfWorkSolver && proofOfWorkAttempts < MAX_PROOF_OF_WORK_ATTEMPTS) {
          proofOfWorkAttempts++
          try {
            powNonce = await this.proofOfWorkSolver.solve(challenge.seed, challenge.difficulty, challenge.algorithm)
            powSeed = challenge.seed
          } catch {
            throw new ApiCallError(PROOF_OF_WORK_FAILED_MESSAGE)
          }
          continue
        }
        throw new ApiCallError(error.message)
      }

      // Standard Red Notes: APPROVAL / waitlist queue. When approval mode is on the
      // server creates the account pending and returns `pendingApproval: true` with
      // NO session — there is nothing to authenticate. Return the terminal response
      // as-is so the caller can show "awaiting approval" instead of signing in.
      if (registerResponse.data.pendingApproval) {
        return registerResponse.data
      }

      await this.handleAuthentication({
        rootKey,
        wrappingKey,
        session: registerResponse.data.session,
        user: registerResponse.data.user,
      })

      return registerResponse.data
    }
  }

  private async retrieveKeyParams(dto: {
    email: string
    mfaCode?: string
    authenticatorResponse?: Record<string, unknown>
    // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
    workspaceIdentifier?: string
    /**
     * Standard Red Notes: push-MFA. Set on the re-attempt that follows an
     * 'approved' push approval, so a server build that does not (yet) consume
     * approvals at the second-factor gate cannot send us into an
     * approve -> retry -> approve loop: the retry falls back to the interactive
     * code prompt (with an explanatory heading) instead of polling again.
     */
    disallowPushApproval?: boolean
    /**
     * Standard Red Notes: proof-of-work solution echoed back on the resubmit
     * after a `proof-of-work-required` challenge, plus the attempt counter that
     * bounds the solve-and-retry loop.
     */
    powSeed?: string
    powNonce?: string
    proofOfWorkAttempts?: number
  }): Promise<{
    keyParams?: SNRootKeyParams
    response: HttpResponse<KeyParamsResponse>
    mfaCode?: string
  }> {
    const response = await this.apiService.getAccountKeyParams(dto)

    if (isErrorResponse(response) || !response.data) {
      const error = isErrorResponse(response) ? response.data.error : undefined

      // Standard Red Notes: proof-of-work anti-bot challenge. When sign-in PoW is
      // enabled the server returns this (BEFORE the MFA gate) with a fresh
      // challenge. Solve it off the UI thread and resubmit; each unsolved
      // response carries a new challenge, so an expired/consumed one is replaced
      // on the next bounded pass. Must run before the MFA handling below, whose
      // tag list would otherwise fall through and surface the raw error. When PoW
      // is disabled (the default) or no solver is registered, we skip this and
      // handle the response exactly as before.
      const challenge = this.extractProofOfWorkChallenge(error)
      if (challenge) {
        const attempts = dto.proofOfWorkAttempts ?? 0
        if (this.proofOfWorkSolver && attempts < MAX_PROOF_OF_WORK_ATTEMPTS) {
          let nonce: string
          try {
            nonce = await this.proofOfWorkSolver.solve(challenge.seed, challenge.difficulty, challenge.algorithm)
          } catch {
            return { response: this.apiService.createErrorResponse(PROOF_OF_WORK_FAILED_MESSAGE) }
          }

          return this.retrieveKeyParams({
            email: dto.email,
            mfaCode: dto.mfaCode,
            authenticatorResponse: dto.authenticatorResponse,
            workspaceIdentifier: dto.workspaceIdentifier,
            disallowPushApproval: dto.disallowPushApproval,
            powSeed: challenge.seed,
            powNonce: nonce,
            proofOfWorkAttempts: attempts + 1,
          })
        }

        // No solver, or attempts exhausted: surface the challenge error as-is.
        return { response }
      }

      if (dto.mfaCode) {
        await this.alertService.alert(SignInStrings.IncorrectMfa)
      }

      if (response.data && [ErrorTag.U2FRequired, ErrorTag.MfaRequired].includes(error?.tag as ErrorTag)) {
        const isU2FRequired = error?.tag === ErrorTag.U2FRequired

        if (isU2FRequired) {
          const result = await this.promptForU2FVerification(dto.email)
          if (!result) {
            return {
              response: this.apiService.createErrorResponse(
                SignInStrings.SignInCanceledMissingMfa,
                undefined,
                ErrorTag.ClientCanceledMfa,
              ),
            }
          }

          return this.retrieveKeyParams({
            email: dto.email,
            authenticatorResponse: result,
            workspaceIdentifier: dto.workspaceIdentifier,
          })
        }

        let onScreenMagicLinkCode: string | undefined
        const isMagicLinkRequired =
          error?.tag === ErrorTag.MfaRequired && /email/i.test(error?.message ?? '') && !dto.mfaCode
        if (isMagicLinkRequired) {
          onScreenMagicLinkCode = await this.requestMagicLinkCode(dto.email)
        }

        /**
         * Standard Red Notes: push-MFA. The MFA error may carry the id of a
         * pending approval the server just created and pushed to the user's
         * other authenticated sessions (as an MFA_APPROVAL_REQUESTED websocket
         * frame + the pending-approvals inbox). While the code prompt is open
         * we also poll that approval, so an approve/deny on a trusted device
         * resolves this sign-in without typing a code.
         */
        const rawApprovalChallengeId = error?.payload?.['mfa_approval_challenge_id']
        const approvalChallengeId =
          !dto.disallowPushApproval && typeof rawApprovalChallengeId === 'string' && rawApprovalChallengeId.length > 0
            ? rawApprovalChallengeId
            : undefined

        const mfaResult = await this.promptForMfaValue({
          onScreenCode: onScreenMagicLinkCode,
          approvalChallengeId,
          approvedElsewhereButCodeStillRequired: dto.disallowPushApproval,
        })
        if (!mfaResult) {
          return {
            response: this.apiService.createErrorResponse(
              SignInStrings.SignInCanceledMissingMfa,
              undefined,
              ErrorTag.ClientCanceledMfa,
            ),
          }
        }

        if (mfaResult.pushApprovalStatus === 'denied') {
          return {
            response: this.apiService.createErrorResponse(
              SignInStrings.SignInDeniedFromTrustedDevice,
              undefined,
              ErrorTag.ClientCanceledMfa,
            ),
          }
        }

        if (mfaResult.pushApprovalStatus === 'approved') {
          /**
           * The server's documented continuation: an approved (and, via the
           * status poll, consumed) challenge means the second factor is
           * satisfied and the client re-attempts the normal sign-in. If this
           * server build does not consume approvals at the MFA gate yet, the
           * retry lands back on the interactive code prompt (guarded by
           * disallowPushApproval above).
           */
          return this.retrieveKeyParams({
            email: dto.email,
            workspaceIdentifier: dto.workspaceIdentifier,
            disallowPushApproval: true,
          })
        }

        return this.retrieveKeyParams({
          email: dto.email,
          mfaCode: mfaResult.mfaCode,
          workspaceIdentifier: dto.workspaceIdentifier,
        })
      } else {
        return { response }
      }
    }
    /** Make sure to use client value for identifier/email */
    const keyParams = KeyParamsFromApiResponse(response.data, dto.email)
    if (!keyParams || !keyParams.version) {
      return {
        response: this.apiService.createErrorResponse(API_MESSAGE_FALLBACK_LOGIN_FAIL),
      }
    }
    return { keyParams, response, mfaCode: dto.mfaCode }
  }

  public async signIn(
    email: string,
    password: string,
    strict = false,
    ephemeral = false,
    minAllowedVersion?: Common.ProtocolVersion,
    hvmToken?: string,
    // Standard Red Notes: optional workspace name for "multiple accounts per
    // email" (WORKSPACES_PER_EMAIL_ENABLED). Trailing optional param so all
    // existing call sites are unaffected. Threaded down to key-params lookup and
    // the sign-in request; ignored by the server unless the feature flag is on.
    workspaceIdentifier?: string,
  ): Promise<SessionManagerResponse> {
    const result = await this.performSignIn(
      email,
      password,
      strict,
      ephemeral,
      minAllowedVersion,
      hvmToken,
      workspaceIdentifier,
    )
    if (
      isErrorResponse(result.response) &&
      getErrorFromErrorResponse(result.response).tag !== ErrorTag.ClientValidationError &&
      getErrorFromErrorResponse(result.response).tag !== ErrorTag.ClientCanceledMfa
    ) {
      const cleanedEmail = cleanedEmailString(email)
      if (cleanedEmail !== email) {
        /**
         * Try signing in with trimmed + lowercase version of email
         */
        return this.performSignIn(
          cleanedEmail,
          password,
          strict,
          ephemeral,
          minAllowedVersion,
          hvmToken,
          workspaceIdentifier,
        )
      } else {
        return result
      }
    } else {
      return result
    }
  }

  private async performSignIn(
    email: string,
    password: string,
    strict = false,
    ephemeral = false,
    minAllowedVersion?: Common.ProtocolVersion,
    hvmToken?: string,
    workspaceIdentifier?: string,
  ): Promise<SessionManagerResponse> {
    const paramsResult = await this.retrieveKeyParams({
      email,
      workspaceIdentifier,
    })
    if (isErrorResponse(paramsResult.response)) {
      return {
        response: paramsResult.response,
      }
    }
    const keyParams = paramsResult.keyParams as SNRootKeyParams
    if (!this.encryptionService.supportedVersions().includes(keyParams.version)) {
      if (this.encryptionService.isVersionNewerThanLibraryVersion(keyParams.version)) {
        return {
          response: this.apiService.createErrorResponse(UNSUPPORTED_PROTOCOL_VERSION),
        }
      } else {
        return {
          response: this.apiService.createErrorResponse(EXPIRED_PROTOCOL_VERSION),
        }
      }
    }

    if (isProtocolVersionExpired(keyParams.version)) {
      /* Cost minimums only apply to now outdated versions (001 and 002) */
      const minimum = this.encryptionService.costMinimumForVersion(keyParams.version)
      if (keyParams.content002.pw_cost < minimum) {
        return {
          response: this.apiService.createErrorResponse(INVALID_PASSWORD_COST),
        }
      }

      const expiredMessages = Strings.Confirm.ProtocolVersionExpired(keyParams.version)
      const confirmed = await this.alertService.confirm(
        expiredMessages.Message,
        expiredMessages.Title,
        expiredMessages.ConfirmButton,
      )

      if (!confirmed) {
        return {
          response: this.apiService.createErrorResponse(API_MESSAGE_FALLBACK_LOGIN_FAIL),
        }
      }
    }

    if (!this.encryptionService.platformSupportsKeyDerivation(keyParams)) {
      return {
        response: this.apiService.createErrorResponse(UNSUPPORTED_KEY_DERIVATION),
      }
    }

    if (strict) {
      minAllowedVersion = this.encryptionService.getLatestVersion()
    }

    if (minAllowedVersion != undefined) {
      if (!Common.leftVersionGreaterThanOrEqualToRight(keyParams.version, minAllowedVersion)) {
        return {
          response: this.apiService.createErrorResponse(StrictSignInFailed(keyParams.version, minAllowedVersion)),
        }
      }
    }
    const rootKey = await this.encryptionService.computeRootKey(password, keyParams)
    const signInResponse = await this.bypassChecksAndSignInWithRootKey(
      email,
      rootKey,
      ephemeral,
      hvmToken,
      workspaceIdentifier,
    )

    return {
      response: signInResponse,
    }
  }

  public async bypassChecksAndSignInWithRootKey(
    email: string,
    rootKey: SNRootKey,
    ephemeral = false,
    hvmToken?: string,
    // Standard Red Notes: optional workspace name (WORKSPACES_PER_EMAIL_ENABLED).
    workspaceIdentifier?: string,
  ): Promise<HttpResponse<SignInResponse>> {
    const { wrappingKey, canceled } = await this.challengeService.getWrappingKeyIfApplicable()

    if (canceled) {
      return this.apiService.createErrorResponse(
        SignInStrings.PasscodeRequired,
        undefined,
        ErrorTag.ClientValidationError,
      )
    }

    const signInResponse = await this.apiService.signIn({
      email,
      serverPassword: rootKey.serverPassword as string,
      ephemeral,
      hvmToken,
      workspaceIdentifier,
    })

    if (!signInResponse.data || isErrorResponse(signInResponse)) {
      return signInResponse
    }

    const updatedKeyParams = signInResponse.data.key_params
    const expandedRootKey = new SNRootKey(
      CopyPayloadWithContentOverride(rootKey.payload, {
        keyParams: updatedKeyParams || rootKey.keyParams.getPortableValue(),
      }),
    )

    await this.handleSuccessAuthResponse(signInResponse, expandedRootKey, wrappingKey)

    return signInResponse
  }

  public async changeCredentials(parameters: {
    currentServerPassword: string
    newRootKey: RootKeyWithKeyPairsInterface
    wrappingKey?: SNRootKey
    newEmail?: string
  }): Promise<SessionManagerResponse> {
    const userUuid = this.getSureUser().uuid
    const rawResponse = await this.apiService.changeCredentials({
      userUuid,
      currentServerPassword: parameters.currentServerPassword,
      newServerPassword: parameters.newRootKey.serverPassword as string,
      newKeyParams: parameters.newRootKey.keyParams,
      newEmail: parameters.newEmail ? cleanedEmailString(parameters.newEmail) : undefined,
    })

    const oldKeys = this._getKeyPairs.execute()

    const processedResponse = await this.processChangeCredentialsResponse(
      rawResponse,
      parameters.newRootKey,
      parameters.wrappingKey,
    )

    if (!isErrorResponse(rawResponse)) {
      if (InternalFeatureService.get().isFeatureEnabled(InternalFeature.Vaults)) {
        const eventData: UserKeyPairChangedEventData = {
          previous: !oldKeys.isFailed()
            ? {
                encryption: oldKeys.getValue().encryption,
                signing: oldKeys.getValue().signing,
              }
            : undefined,
          current: {
            encryption: parameters.newRootKey.encryptionKeyPair,
            signing: parameters.newRootKey.signingKeyPair,
          },
        }

        void this.notifyEvent(SessionEvent.UserKeyPairChanged, eventData)
      }
    }

    return processedResponse
  }

  public async getSessionsList(): Promise<HttpResponse<SessionListEntry[]>> {
    const response = await this.apiService.getSessionsList()

    if (isErrorResponse(response)) {
      return response
    }

    response.data = response.data.sort((s1: SessionListEntry, s2: SessionListEntry) => {
      return new Date(s1.updated_at) < new Date(s2.updated_at) ? 1 : -1
    })

    return response
  }

  public async revokeSession(sessionId: UuidString): Promise<HttpResponse<SessionListResponse>> {
    return this.apiService.deleteSession(sessionId)
  }

  public async revokeAllOtherSessions(): Promise<void> {
    const response = await this.getSessionsList()
    if (isErrorResponse(response) || !response.data) {
      const error = isErrorResponse(response) ? response.data?.error : undefined
      throw new Error(error?.message ?? API_MESSAGE_GENERIC_SYNC_FAIL)
    }

    const otherSessions = response.data.filter((session) => !session.current)
    await Promise.all(otherSessions.map((session) => this.revokeSession(session.uuid)))
  }

  private async processChangeCredentialsResponse(
    response: HttpResponse<ChangeCredentialsResponse>,
    newRootKey: SNRootKey,
    wrappingKey?: SNRootKey,
  ): Promise<SessionManagerResponse> {
    if (isErrorResponse(response)) {
      return {
        response: response,
      }
    }

    await this.handleSuccessAuthResponse(response, newRootKey, wrappingKey)

    return {
      response: response,
      keyParams: response.data?.key_params,
    }
  }

  private decodeDemoShareToken(token: Base64String): ShareToken {
    const jsonString = this.crypto.base64Decode(token)
    return JSON.parse(jsonString)
  }

  public async populateSessionFromDemoShareToken(token: Base64String): Promise<void> {
    const sharePayload = this.decodeDemoShareToken(token)

    await this.signIn(sharePayload.email, sharePayload.password, false, true)
  }

  private async populateSession(
    rootKey: SNRootKey,
    user: User,
    session: Session | LegacySession,
    host: string,
    wrappingKey?: SNRootKey,
  ) {
    await this.encryptionService.setRootKey(rootKey, wrappingKey)

    this.memoizeUser(user)
    this.storage.setValue(StorageKey.User, user)

    void this.apiService.setHost(host)
    this.httpService.setHost(host)

    this.setSession(session)
  }

  async handleAuthentication(dto: {
    session: SessionBody
    user: {
      uuid: string
      email: string
    }
    rootKey: SNRootKey
    wrappingKey?: SNRootKey
  }): Promise<void> {
    const sessionOrError = this.createSession(
      dto.session.access_token,
      dto.session.access_expiration,
      dto.session.refresh_token,
      dto.session.refresh_expiration,
      dto.session.readonly_access,
    )
    if (sessionOrError.isFailed()) {
      console.error(sessionOrError.getError())

      return
    }

    await this.populateSession(
      dto.rootKey,
      dto.user,
      sessionOrError.getValue(),
      this.apiService.getHost(),
      dto.wrappingKey,
    )
  }

  /**
   * @deprecated use handleAuthentication instead
   */
  private async handleSuccessAuthResponse(
    response: HttpSuccessResponse<SignInResponse | ChangeCredentialsResponse>,
    rootKey: SNRootKey,
    wrappingKey?: SNRootKey,
  ) {
    const { data } = response
    const user = data.user

    const isLegacyJwtResponse = data.token != undefined
    if (isLegacyJwtResponse) {
      const sessionOrError = LegacySession.create(data.token as string)
      if (!sessionOrError.isFailed() && user) {
        await this.populateSession(rootKey, user, sessionOrError.getValue(), this.apiService.getHost(), wrappingKey)
      }
    } else if (data.session) {
      const sessionOrError = this.createSession(
        data.session.access_token,
        data.session.access_expiration,
        data.session.refresh_token,
        data.session.refresh_expiration,
        data.session.readonly_access,
      )
      if (sessionOrError.isFailed()) {
        console.error(sessionOrError.getError())

        return
      }
      if (!user) {
        console.error('No user in response')

        return
      }

      await this.populateSession(rootKey, user, sessionOrError.getValue(), this.apiService.getHost(), wrappingKey)
    }
  }

  private createSession(
    accessTokenValue: string,
    accessExpiration: number,
    refreshTokenValue: string,
    refreshExpiration: number,
    readonlyAccess: boolean,
  ): Result<Session> {
    const accessTokenOrError = SessionToken.create(accessTokenValue, accessExpiration)
    if (accessTokenOrError.isFailed()) {
      return Result.fail(`Could not create session: ${accessTokenOrError.getError()}`)
    }
    const accessToken = accessTokenOrError.getValue()

    const refreshTokenOrError = SessionToken.create(refreshTokenValue, refreshExpiration)
    if (refreshTokenOrError.isFailed()) {
      return Result.fail(`Could not create session: ${refreshTokenOrError.getError()}`)
    }
    const refreshToken = refreshTokenOrError.getValue()

    const sessionOrError = Session.create(accessToken, refreshToken, readonlyAccess)
    if (sessionOrError.isFailed()) {
      return Result.fail(`Could not create session: ${sessionOrError.getError()}`)
    }

    return Result.ok(sessionOrError.getValue())
  }

  async refreshSessionIfExpiringSoon(): Promise<boolean> {
    const session = this.getSession()

    if (!session) {
      return false
    }
    if (session instanceof LegacySession) {
      return false
    }

    const accessTokenExpiration = new Date(session.accessToken.expiresAt)
    const refreshTokenExpiration = new Date(session.refreshToken.expiresAt)

    const willAccessTokenExpireSoon = accessTokenExpiration.getTime() - Date.now() < ThirtyMinutes
    const willRefreshTokenExpireSoon = refreshTokenExpiration.getTime() - Date.now() < ThirtyMinutes

    if (willAccessTokenExpireSoon || willRefreshTokenExpireSoon) {
      const refreshSessionResultOrError = await this.httpService.refreshSession()
      if (refreshSessionResultOrError.isFailed()) {
        return false
      }

      const refreshSessionResult = refreshSessionResultOrError.getValue()

      return isErrorResponse(refreshSessionResult)
    }

    return false
  }
}
