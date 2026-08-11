import { joinPaths } from '@standardnotes/utils'
import {
  AbstractService,
  LegacyApiServiceInterface,
  InternalEventBusInterface,
  IntegrityApiInterface,
  ItemsServerInterface,
  StorageKey,
  ApiServiceEvent,
  KeyValueStoreInterface,
  API_MESSAGE_GENERIC_SYNC_FAIL,
  API_MESSAGE_GENERIC_TOKEN_REFRESH_FAIL,
  API_MESSAGE_CHANGE_CREDENTIALS_IN_PROGRESS,
  API_MESSAGE_FAILED_ACCESS_PURCHASE,
  API_MESSAGE_FAILED_CREATE_FILE_TOKEN,
  API_MESSAGE_FAILED_GET_SETTINGS,
  API_MESSAGE_FAILED_OFFLINE_ACTIVATION,
  API_MESSAGE_FAILED_OFFLINE_FEATURES,
  API_MESSAGE_FAILED_UPDATE_SETTINGS,
  API_MESSAGE_GENERIC_CHANGE_CREDENTIALS_FAIL,
  API_MESSAGE_GENERIC_INTEGRITY_CHECK_FAIL,
  API_MESSAGE_GENERIC_INVALID_LOGIN,
  API_MESSAGE_GENERIC_SINGLE_ITEM_SYNC_FAIL,
  API_MESSAGE_INVALID_SESSION,
  API_MESSAGE_LOGIN_IN_PROGRESS,
  API_MESSAGE_TOKEN_REFRESH_IN_PROGRESS,
  ApiServiceEventData,
} from '@standardnotes/services'
import { DownloadFileParams, FileOwnershipType, FilesApiInterface } from '@standardnotes/files'
import { ServerSyncPushContextualPayload, SNFeatureRepo } from '@standardnotes/models'
import {
  User,
  HttpStatusCode,
  KeyParamsResponse,
  SignInResponse,
  SignOutResponse,
  ChangeCredentialsResponse,
  RawSyncResponse,
  SessionRenewalResponse,
  SessionListResponse,
  ListSettingsResponse,
  UpdateSettingResponse,
  GetSettingResponse,
  DeleteSettingResponse,
  PostSubscriptionTokensResponse,
  GetOfflineFeaturesResponse,
  CreateValetTokenResponse,
  StartUploadSessionResponse,
  UploadFileChunkResponse,
  CloseUploadSessionResponse,
  DownloadFileChunkResponse,
  IntegrityPayload,
  CheckIntegrityResponse,
  GetSingleItemResponse,
  HttpResponse,
  HttpResponseMeta,
  ErrorTag,
  HttpRequestParams,
  HttpRequest,
  HttpVerb,
  ApiEndpointParam,
  ClientDisplayableError,
  CreateValetTokenPayload,
  HttpErrorResponse,
  HttpSuccessResponse,
  isErrorResponse,
  MoveFileResponse,
  ValetTokenOperation,
  MetaEndpointResponse,
} from '@standardnotes/responses'
import { LegacySession, MapperInterface, Session, SessionToken } from '@standardnotes/domain-core'
import { HttpServiceInterface } from '@standardnotes/api'
import { SNRootKeyParams } from '@standardnotes/encryption'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { Paths } from './Paths'
import { DiskStorageService } from '../Storage/DiskStorageService'
import { UuidString } from '../../Types/UuidString'
import { SettingsServerInterface, MfaSecretResponse } from '../Settings/SettingsServerInterface'
import { Strings } from '@Lib/Strings'
import { AnyFeatureDescription } from '@standardnotes/features'

/** Legacy api version field to be specified in params when calling v0 APIs. */
const V0_API_VERSION = '20240226'

type InvalidSessionObserver = (revoked: boolean) => void

export class LegacyApiService
  extends AbstractService<ApiServiceEvent, ApiServiceEventData>
  implements
    LegacyApiServiceInterface,
    FilesApiInterface,
    IntegrityApiInterface,
    ItemsServerInterface,
    SettingsServerInterface
{
  private session: Session | LegacySession | null
  public user?: User
  private authenticating = false
  private changing = false
  private refreshingSession = false
  private invalidSessionObserver?: InvalidSessionObserver
  private filesHost?: string

  constructor(
    private httpService: HttpServiceInterface,
    private storageService: DiskStorageService,
    private host: string,
    private inMemoryStore: KeyValueStoreInterface<string>,
    private crypto: PureCryptoInterface,
    private sessionStorageMapper: MapperInterface<Session, Record<string, unknown>>,
    private legacySessionStorageMapper: MapperInterface<LegacySession, Record<string, unknown>>,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)

    this.session = null
  }

  override deinit(): void {
    ;(this.httpService as unknown) = undefined
    ;(this.storageService as unknown) = undefined
    this.invalidSessionObserver = undefined
    this.session = null
    super.deinit()
  }

  public setUser(user?: User): void {
    this.user = user
  }

  /**
   * When a we receive a 401 error from the server, we'll notify the observer.
   * Note that this applies only to sessions that are totally invalid. Sessions that
   * are expired but can be renewed are still considered to be valid. In those cases,
   * the server response is 498.
   * If the session has been revoked, then the observer will have its first
   * argument set to true.
   */
  public setInvalidSessionObserver(observer: InvalidSessionObserver): void {
    this.invalidSessionObserver = observer
  }

  public loadHost(): string {
    const storedValue = this.storageService.getValue<string | undefined>(StorageKey.ServerHost)
    this.host = storedValue || this.host
    return this.host
  }

  public async setHost(host: string): Promise<void> {
    this.host = host
    this.storageService.setValue(StorageKey.ServerHost, host)
  }

  public getHost(): string {
    return this.host
  }

  public getFilesHost(): string {
    if (!this.filesHost) {
      throw Error('Attempting to access undefined filesHost')
    }
    return this.filesHost
  }

  public setSession(session: Session | LegacySession, persist = true): void {
    this.session = session
    if (persist) {
      let sessionProjection: Record<string, unknown>
      if (session instanceof Session) {
        sessionProjection = this.sessionStorageMapper.toProjection(session)
      } else {
        sessionProjection = this.legacySessionStorageMapper.toProjection(session)
      }

      this.storageService.setValue(StorageKey.Session, sessionProjection)
    }
  }

  public getSession(): Session | LegacySession | null {
    return this.session
  }

  public get apiVersion() {
    return V0_API_VERSION
  }

  private params(inParams: Record<string | number | symbol, unknown>): HttpRequestParams {
    const params = {
      ...inParams,
      ...{
        [ApiEndpointParam.ApiVersion]: this.apiVersion,
      },
    }
    return params
  }

  public createErrorResponse(message: string, status?: HttpStatusCode, tag?: ErrorTag): HttpErrorResponse {
    return { data: { error: { message, tag } }, status: status ?? HttpStatusCode.BadRequest }
  }

  private errorResponseWithFallbackMessage(response: HttpErrorResponse, message: string): HttpErrorResponse {
    if (response.data.error && !response.data.error.message) {
      response.data.error.message = message
    }

    return response
  }

  public processMetaObject(meta: HttpResponseMeta) {
    if (meta.auth && meta.auth.userUuid && meta.auth.roles) {
      void this.notifyEvent(ApiServiceEvent.MetaReceived, {
        userUuid: meta.auth.userUuid,
        userRoles: meta.auth.roles,
      })
    }

    if (meta.server?.filesServerUrl) {
      this.filesHost = meta.server?.filesServerUrl
    }
  }

  private processSuccessResponseForMetaBody<T>(response: HttpSuccessResponse<T>) {
    if (response.meta) {
      this.processMetaObject(response.meta)
    }
  }

  private async request<T>(params: {
    verb: HttpVerb
    url: string
    fallbackErrorMessage: string
    params?: HttpRequestParams
    rawBytes?: Uint8Array
    authentication?: string
    customHeaders?: Record<string, string>[]
    responseType?: XMLHttpRequestResponseType
    external?: boolean
  }): Promise<HttpResponse<T>> {
    try {
      const response = await this.httpService.runHttp<T>(params)
      if (isErrorResponse(response)) {
        return this.errorResponseWithFallbackMessage(response, params.fallbackErrorMessage)
      } else {
        this.processSuccessResponseForMetaBody(response)
        return response
      }
    } catch (errorResponse) {
      return this.errorResponseWithFallbackMessage(errorResponse as HttpErrorResponse, params.fallbackErrorMessage)
    }
  }

  /**
   * @param mfaCode     The mfa challenge response value.
   */
  async getAccountKeyParams(dto: {
    email: string
    mfaCode?: string
    authenticatorResponse?: Record<string, unknown>
    /**
     * Standard Red Notes: an app-specific password. When present and valid, the
     * server treats the interactive 2FA challenge as satisfied for this sign-in
     * only (see auth server VerifyAppPassword). Used by headless clients such as
     * the MCP bridge so they do not need a live TOTP code.
     */
    appPassword?: string
    /**
     * Standard Red Notes: a trusted-device token. When present and valid, the
     * server treats the interactive 2FA challenge as satisfied for this sign-in
     * only (see auth server VerifyTrustedDevice). If omitted, the token stored by
     * this browser (if any) is used automatically.
     */
    trustedDeviceToken?: string
    /**
     * Standard Red Notes: optional workspace name for "multiple accounts per
     * email" (WORKSPACES_PER_EMAIL_ENABLED). Sent as workspace_identifier so the
     * server can resolve the specific workspace's key params. Omitted entirely
     * when unset, keeping the request identical to today.
     */
    workspaceIdentifier?: string
    /**
     * Standard Red Notes: proof-of-work solution (seed echoed from the server's
     * challenge + the solved nonce). Sent as pow_seed/pow_nonce only when
     * resubmitting after a `proof-of-work-required` response; omitted entirely
     * otherwise so the request is byte-for-byte identical to today when the
     * feature is unused.
     */
    powSeed?: string
    powNonce?: string
  }): Promise<HttpResponse<KeyParamsResponse>> {
    const codeVerifier = this.crypto.generateRandomKey(256)
    this.inMemoryStore.setValue(StorageKey.CodeVerifier, codeVerifier)

    const codeChallenge = this.crypto.base64URLEncode(await this.crypto.sha256(codeVerifier))

    const params = this.params({
      email: dto.email,
      code_challenge: codeChallenge,
    }) as Record<string, unknown>

    if (dto.workspaceIdentifier !== undefined && dto.workspaceIdentifier.length > 0) {
      params['workspace_identifier'] = dto.workspaceIdentifier
    }

    if (dto.mfaCode !== undefined) {
      params['mfa_code'] = dto.mfaCode
    }

    if (dto.authenticatorResponse) {
      params.authenticator_response = dto.authenticatorResponse
    }

    // Standard Red Notes: proof-of-work anti-bot solution. Present only on a
    // resubmit after a `proof-of-work-required` challenge; absent otherwise.
    if (dto.powSeed !== undefined && dto.powNonce !== undefined) {
      params['pow_seed'] = dto.powSeed
      params['pow_nonce'] = dto.powNonce
    }

    if (dto.appPassword !== undefined && dto.appPassword.length > 0) {
      params['app_password'] = dto.appPassword
    }

    // Standard Red Notes: trusted-device 2FA bypass. If this browser previously
    // marked itself trusted, present the stored device token so the server can
    // skip the interactive second factor for THIS sign-in. The server fails
    // closed: a wrong/expired/revoked token is ignored and the normal MFA prompt
    // still appears. Trust never bypasses the account password.
    const trustedDeviceToken = dto.trustedDeviceToken ?? this.readTrustedDeviceTokenFromStorage()
    if (trustedDeviceToken !== undefined && trustedDeviceToken.length > 0) {
      params['trusted_device_token'] = trustedDeviceToken
    }

    return this.request({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v2.keyParams),
      fallbackErrorMessage: API_MESSAGE_GENERIC_INVALID_LOGIN,
      params,
      /** A session is optional here, if valid, endpoint bypasses 2FA and returns additional params */
      authentication: this.getSessionAccessToken(),
    })
  }

  /**
   * Standard Red Notes: reads the trusted-device token persisted by the web
   * Security preferences pane (sn_trusted_device_token in localStorage). Returns
   * undefined when storage is unavailable (e.g. non-browser runtime or private
   * mode), in which case the normal interactive 2FA flow applies.
   */
  private readTrustedDeviceTokenFromStorage(): string | undefined {
    try {
      if (typeof localStorage === 'undefined') {
        return undefined
      }
      return localStorage.getItem('sn_trusted_device_token') ?? undefined
    } catch {
      return undefined
    }
  }

  async signIn(dto: {
    email: string
    serverPassword: string
    ephemeral: boolean
    hvmToken?: string
    /**
     * Standard Red Notes: optional workspace name for "multiple accounts per
     * email" (WORKSPACES_PER_EMAIL_ENABLED). Sent as workspace_identifier so the
     * server resolves the specific workspace before verifying the password.
     */
    workspaceIdentifier?: string
  }): Promise<HttpResponse<SignInResponse>> {
    if (this.authenticating) {
      return this.createErrorResponse(API_MESSAGE_LOGIN_IN_PROGRESS, HttpStatusCode.BadRequest)
    }
    this.authenticating = true
    const url = joinPaths(this.host, Paths.v2.signIn)
    const params = this.params({
      email: dto.email,
      password: dto.serverPassword,
      ephemeral: dto.ephemeral,
      code_verifier: this.inMemoryStore.getValue(StorageKey.CodeVerifier) as string,
      hvm_token: dto.hvmToken,
      ...(dto.workspaceIdentifier && dto.workspaceIdentifier.length > 0
        ? { workspace_identifier: dto.workspaceIdentifier }
        : {}),
    })

    const response = await this.request<SignInResponse>({
      verb: HttpVerb.Post,
      url,
      params,
      fallbackErrorMessage: API_MESSAGE_GENERIC_INVALID_LOGIN,
    })

    this.authenticating = false

    this.inMemoryStore.removeValue(StorageKey.CodeVerifier)

    return response
  }

  signOut(): Promise<HttpResponse<SignOutResponse>> {
    return this.httpService.post<SignOutResponse>(Paths.v1.signOut, undefined, {
      authentication: this.getSessionAccessToken(),
    })
  }

  /**
   * Standard Red Notes: EMAIL CONFIRMATION (part 2). Public, unauthenticated —
   * consumes a confirmation token from the verification link.
   */
  verifyEmailConfirmation(token: string): Promise<HttpResponse<{ success?: boolean; alreadyConfirmed?: boolean }>> {
    return this.httpService.post<{ success?: boolean; alreadyConfirmed?: boolean }>(Paths.v1.verifyEmailConfirmation, {
      token,
    })
  }

  /**
   * Standard Red Notes: re-sends the confirmation email. Always resolves 200 with
   * a uniform body server-side (no account-existence oracle).
   */
  resendEmailConfirmation(email: string): Promise<HttpResponse<{ success?: boolean }>> {
    return this.httpService.post<{ success?: boolean }>(Paths.v1.resendEmailConfirmation, { email })
  }

  async changeCredentials(parameters: {
    userUuid: UuidString
    currentServerPassword: string
    newServerPassword: string
    newKeyParams: SNRootKeyParams
    newEmail?: string
  }): Promise<HttpResponse<ChangeCredentialsResponse>> {
    if (this.changing) {
      return this.createErrorResponse(API_MESSAGE_CHANGE_CREDENTIALS_IN_PROGRESS, HttpStatusCode.BadRequest)
    }
    const preprocessingError = this.preprocessingError()
    if (preprocessingError) {
      return preprocessingError
    }
    this.changing = true

    try {
      const path = Paths.v1.changeCredentials(parameters.userUuid)
      const params = this.params({
        current_password: parameters.currentServerPassword,
        new_password: parameters.newServerPassword,
        new_email: parameters.newEmail,
        ...parameters.newKeyParams.getPortableValue(),
      })

      const response = await this.httpService.put<ChangeCredentialsResponse>(path, params, {
        authentication: this.getSessionAccessToken(),
      })

      if (isErrorResponse(response)) {
        return this.errorResponseWithFallbackMessage(response, API_MESSAGE_GENERIC_CHANGE_CREDENTIALS_FAIL)
      }

      this.processSuccessResponseForMetaBody(response)

      return response
    } finally {
      this.changing = false
    }
  }

  async sync(
    payloads: ServerSyncPushContextualPayload[],
    lastSyncToken: string | undefined,
    paginationToken: string | undefined,
    limit: number,
    sharedVaultUuids?: string[],
  ): Promise<HttpResponse<RawSyncResponse>> {
    const preprocessingError = this.preprocessingError()
    if (preprocessingError) {
      return preprocessingError
    }
    const request = this.getSyncHttpRequest(payloads, lastSyncToken, paginationToken, limit, sharedVaultUuids)
    const response = await this.httpService.runHttp<RawSyncResponse>(request)

    if (isErrorResponse(response)) {
      this.preprocessAuthenticatedErrorResponse(response)
      return this.errorResponseWithFallbackMessage(response, API_MESSAGE_GENERIC_SYNC_FAIL)
    }

    this.processSuccessResponseForMetaBody(response)

    return response
  }

  getSyncHttpRequest(
    payloads: ServerSyncPushContextualPayload[],
    lastSyncToken: string | undefined,
    paginationToken: string | undefined,
    limit: number,
    sharedVaultUuids?: string[] | undefined,
  ): HttpRequest {
    const path = Paths.v1.sync
    const params = this.params({
      [ApiEndpointParam.SyncPayloads]: payloads,
      [ApiEndpointParam.LastSyncToken]: lastSyncToken,
      [ApiEndpointParam.PaginationToken]: paginationToken,
      [ApiEndpointParam.SyncDlLimit]: limit,
      [ApiEndpointParam.SharedVaultUuids]: sharedVaultUuids,
    })
    return {
      url: joinPaths(this.host, path),
      params,
      verb: HttpVerb.Post,
      authentication: this.getSessionAccessToken(),
    }
  }

  /**
   * @deprecated
   *
   * This function should be replaced with @standardnotes/api's `HttpService::refreshSession` function.
   */
  async deprecatedRefreshSessionOnlyUsedInE2eTests(): Promise<HttpResponse<SessionRenewalResponse>> {
    const preprocessingError = this.preprocessingError()
    if (preprocessingError) {
      return preprocessingError
    }

    this.refreshingSession = true

    const session = this.session as Session
    const params = this.params({
      access_token: session.accessToken.value,
      refresh_token: session.refreshToken.value,
    })

    const response = await this.httpService
      .post<SessionRenewalResponse>(Paths.v1.refreshSession, params)
      .then(async (response) => {
        if (isErrorResponse(response) || !response.data.session) {
          return response
        }

        const accessTokenOrError = SessionToken.create(
          response.data.session.access_token,
          response.data.session.access_expiration,
        )
        if (accessTokenOrError.isFailed()) {
          return null
        }
        const accessToken = accessTokenOrError.getValue()

        const refreshTokenOrError = SessionToken.create(
          response.data.session.refresh_token,
          response.data.session.refresh_expiration,
        )
        if (refreshTokenOrError.isFailed()) {
          return null
        }
        const refreshToken = refreshTokenOrError.getValue()

        const sessionOrError = Session.create(accessToken, refreshToken, response.data.session.readonly_access)
        if (sessionOrError.isFailed()) {
          return null
        }
        const session = sessionOrError.getValue()

        this.session = session

        this.setSession(session)
        this.processSuccessResponseForMetaBody(response)

        await this.notifyEventSync(ApiServiceEvent.SessionRefreshed, {
          session,
        })

        return response
      })

    this.refreshingSession = false

    if (response === null) {
      return this.createErrorResponse(API_MESSAGE_INVALID_SESSION, HttpStatusCode.BadRequest)
    }

    if (isErrorResponse(response)) {
      this.preprocessAuthenticatedErrorResponse(response)
      return this.errorResponseWithFallbackMessage(response, API_MESSAGE_GENERIC_TOKEN_REFRESH_FAIL)
    }

    return response
  }

  async getSessionsList(): Promise<HttpResponse<SessionListResponse>> {
    const preprocessingError = this.preprocessingError()
    if (preprocessingError) {
      return preprocessingError
    }
    const path = Paths.v1.sessions
    const response = await this.httpService.get<SessionListResponse>(
      path,
      {},
      { authentication: this.getSessionAccessToken() },
    )

    if (isErrorResponse(response)) {
      this.preprocessAuthenticatedErrorResponse(response)
      return this.errorResponseWithFallbackMessage(response, API_MESSAGE_GENERIC_SYNC_FAIL)
    }

    this.processSuccessResponseForMetaBody(response)

    return response
  }

  async deleteSession(sessionId: UuidString): Promise<HttpResponse<SessionListResponse>> {
    const preprocessingError = this.preprocessingError()
    if (preprocessingError) {
      return preprocessingError
    }
    const path = Paths.v1.session(sessionId)
    const response = await this.httpService.delete<SessionListResponse>(
      path,
      { uuid: sessionId },
      { authentication: this.getSessionAccessToken() },
    )

    if (isErrorResponse(response)) {
      this.preprocessAuthenticatedErrorResponse(response)
      return this.errorResponseWithFallbackMessage(response, API_MESSAGE_GENERIC_SYNC_FAIL)
    }

    this.processSuccessResponseForMetaBody(response)
    return response
  }

  private async tokenRefreshableRequest<T>(
    params: HttpRequest & { fallbackErrorMessage: string },
  ): Promise<HttpResponse<T>> {
    const preprocessingError = this.preprocessingError()
    if (preprocessingError) {
      return preprocessingError
    }

    const response = await this.httpService.runHttp<T>(params)

    if (isErrorResponse(response)) {
      this.preprocessAuthenticatedErrorResponse(response)
      return this.errorResponseWithFallbackMessage(response, params.fallbackErrorMessage)
    }

    this.processSuccessResponseForMetaBody(response)
    return response
  }

  async listSettings(userUuid: UuidString): Promise<HttpResponse<ListSettingsResponse>> {
    return await this.tokenRefreshableRequest<ListSettingsResponse>({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.settings(userUuid)),
      fallbackErrorMessage: API_MESSAGE_FAILED_GET_SETTINGS,
      authentication: this.getSessionAccessToken(),
    })
  }

  async updateSetting(
    userUuid: UuidString,
    settingName: string,
    settingValue: string | null,
    sensitive: boolean,
    totpToken?: string,
  ): Promise<HttpResponse<UpdateSettingResponse>> {
    const params = {
      name: settingName,
      value: settingValue,
      sensitive: sensitive,
      ...(totpToken && { totpToken }),
    }
    return this.tokenRefreshableRequest<UpdateSettingResponse>({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.settings(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_UPDATE_SETTINGS,
      params,
    })
  }

  async getSetting(
    userUuid: UuidString,
    settingName: string,
    serverPassword?: string,
  ): Promise<HttpResponse<GetSettingResponse>> {
    const customHeaders = serverPassword ? [{ key: 'x-server-password', value: serverPassword }] : undefined
    return await this.tokenRefreshableRequest<GetSettingResponse>({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.setting(userUuid, settingName.toLowerCase())),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_GET_SETTINGS,
      customHeaders,
    })
  }

  async getSubscriptionSetting(userUuid: UuidString, settingName: string): Promise<HttpResponse<GetSettingResponse>> {
    return await this.tokenRefreshableRequest<GetSettingResponse>({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.subscriptionSetting(userUuid, settingName.toLowerCase())),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_GET_SETTINGS,
    })
  }

  async updateSubscriptionSetting(
    userUuid: UuidString,
    settingName: string,
    settingValue: string | null,
    sensitive: boolean,
  ): Promise<HttpResponse<UpdateSettingResponse>> {
    const params = {
      name: settingName,
      value: settingValue,
      sensitive: sensitive,
    }
    return this.tokenRefreshableRequest<UpdateSettingResponse>({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.subscriptionSettings(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_UPDATE_SETTINGS,
      params,
    })
  }

  async deleteSetting(
    userUuid: UuidString,
    settingName: string,
    serverPassword?: string,
  ): Promise<HttpResponse<DeleteSettingResponse>> {
    const customHeaders = serverPassword ? [{ key: 'x-server-password', value: serverPassword }] : undefined
    return this.tokenRefreshableRequest<DeleteSettingResponse>({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.setting(userUuid, settingName)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_UPDATE_SETTINGS,
      customHeaders,
    })
  }

  async getMfaSecret(userUuid: UuidString): Promise<HttpResponse<MfaSecretResponse>> {
    return this.tokenRefreshableRequest<MfaSecretResponse>({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.mfaSecret(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get MFA secret.',
    })
  }

  /**
   * Standard Red Notes: admin panel API. These hit the gateway /v1/admin routes,
   * which are protected by the cross-service token middleware; the auth server
   * additionally re-checks the ADMIN_USER role on every call. A
   * non-admin caller will receive a 401 from the server.
   */
  async adminLookupUser(email: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.lookupUser(email)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to look up user.',
    })
  }

  async adminGetUserFeatureFlags(userUuid: UuidString): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.userFeatureFlags(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get user feature flags.',
    })
  }

  async adminSetUserFeatureFlag(userUuid: UuidString, name: string, value: string | null): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.userFeatureFlags(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to set user feature flag.',
      params: { name, value },
    })
  }

  async adminGetUserBanStatus(email: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.userBanStatus(email)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get user ban status.',
    })
  }

  async adminSetUserBanStatus(
    userUuid: UuidString,
    banned: boolean,
    banReason?: string | null,
    // Standard Red Notes: richer bans. `banType` selects permanent (default) |
    // temporary | shadow; a temporary ban carries EITHER `bannedUntil` (ISO
    // date) or `durationMinutes`. Omitting the options keeps the legacy
    // permanent-ban behavior for existing callers (e.g. the bulk ban action).
    options?: {
      banType?: 'temporary' | 'permanent' | 'shadow'
      bannedUntil?: string | null
      durationMinutes?: number | null
    },
  ): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.setUserBanStatus(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to set user ban status.',
      params: {
        banned,
        banReason: banReason ?? null,
        banType: options?.banType,
        bannedUntil: options?.bannedUntil ?? undefined,
        durationMinutes: options?.durationMinutes ?? undefined,
      },
    })
  }

  /** Standard Red Notes: read a user's SUSPENSION status (by email, like ban). */
  async adminGetUserSuspensionStatus(email: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.userSuspensionStatus(email)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get user suspension status.',
    })
  }

  /**
   * Standard Red Notes: suspend or unsuspend a user (reversible administrative
   * hold, distinct from a ban). Suspending signs the user out immediately and
   * blocks access until unsuspended.
   */
  async adminSetUserSuspension(
    userUuid: UuidString,
    suspended: boolean,
    suspendedReason?: string | null,
  ): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.userSuspension(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to set user suspension.',
      params: { suspended, suspendedReason: suspendedReason ?? null },
    })
  }

  async adminGetRegistrationFlag(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.registration),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get registration flag.',
    })
  }

  async adminSetRegistrationFlag(registrationDisabled: boolean): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.registration),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to set registration flag.',
      params: { registrationDisabled },
    })
  }

  /**
   * Standard Red Notes: INVITE-URL signup control — admin invite-link management.
   * These hit the gateway /v1/admin/invite-links routes (admin-gated at the auth
   * server via the cross-service token). `adminCreateInviteLink` returns the raw
   * invite token + relative path EXACTLY ONCE; `adminListInviteLinks` never returns
   * the token; `adminRevokeInviteLink` soft-revokes by uuid. Only the fields the
   * admin actually sets are sent (0-valued/absent fields fall through server-side).
   */
  async adminCreateInviteLink(body: {
    maxUses?: number
    expiresInHours?: number | null
    label?: string | null
    defaultRole?: string | null
    allowedDomain?: string | null
  }): Promise<HttpResponse> {
    const params: Record<string, unknown> = {}
    if (body.maxUses !== undefined) {
      params.maxUses = body.maxUses
    }
    if (body.expiresInHours !== undefined) {
      params.expiresInHours = body.expiresInHours
    }
    if (body.label !== undefined) {
      params.label = body.label
    }
    if (body.defaultRole !== undefined) {
      params.defaultRole = body.defaultRole
    }
    if (body.allowedDomain !== undefined) {
      params.allowedDomain = body.allowedDomain
    }

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.inviteLinks),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create invite link.',
      params,
    })
  }

  async adminListInviteLinks(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.inviteLinks),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list invite links.',
    })
  }

  async adminRevokeInviteLink(uuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.inviteLink(uuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke invite link.',
    })
  }

  /**
   * Standard Red Notes: APPROVAL / waitlist queue — admin review. `listPendingUsers`
   * returns the pending (approved=0) users; `approveUser` flips the access gate (and
   * best-effort notifies); `rejectUser` hard-deletes the pending row via the auth
   * DeleteAccount pipeline. All admin-gated at the auth server.
   */
  async listPendingUsers(options?: { limit?: number; offset?: number }): Promise<HttpResponse> {
    const params: Record<string, string> = {}
    if (options?.limit !== undefined) {
      params.limit = String(options.limit)
    }
    if (options?.offset !== undefined) {
      params.offset = String(options.offset)
    }

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.pendingUsers),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list pending users.',
      params,
    })
  }

  async approveUser(userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.approvePendingUser(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to approve user.',
    })
  }

  async rejectUser(userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.rejectPendingUser(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to reject user.',
    })
  }

  /**
   * Standard Red Notes: paginated admin audit log (newest first). All filters
   * are optional; the server clamps `limit` to its own maximum (200).
   */
  async adminGetAuditLog(options: {
    limit?: number
    offset?: number
    actorUuid?: string
    action?: string
  }): Promise<HttpResponse> {
    const params: Record<string, string> = {}
    if (options.limit !== undefined) {
      params.limit = String(options.limit)
    }
    if (options.offset !== undefined) {
      params.offset = String(options.offset)
    }
    if (options.actorUuid) {
      params.actorUuid = options.actorUuid
    }
    if (options.action) {
      params.action = options.action
    }
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.auditLog),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load the audit log.',
      params,
    })
  }

  /**
   * Standard Red Notes: read-only gateway server status for the admin panel's
   * Server tab (env master switches + gateway/auth health). Admin-gated at the
   * gateway.
   */
  async adminGetServerStatus(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.serverStatus),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load server status.',
    })
  }

  /**
   * Standard Red Notes: admin-editable server settings for the admin panel
   * (AI provider keys/URLs, daily request limit, update-check URL, Nextcloud
   * backups master switch). Secrets are never returned — the GET view carries
   * only `configured` booleans plus a `sources` map saying whether each value
   * is active from the environment, a persisted override, or the default.
   */
  async adminGetServerSettings(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.serverSettings),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load server settings.',
    })
  }

  /**
   * Standard Red Notes: partial update of the admin server settings. Only the
   * provided keys change; an explicit `null` clears a persisted value (falling
   * back to the environment value or the default). Persisted values win over
   * env. Returns the same view as adminGetServerSettings.
   */
  async adminSetServerSettings(partial: {
    ai?: {
      anthropicApiKey?: string | null
      openaiApiKey?: string | null
      openaiBaseUrl?: string | null
      ollamaUrl?: string | null
      dailyRequestLimit?: number | null
    }
    updateCheck?: {
      url?: string | null
    }
    nextcloudBackups?: {
      enabled?: boolean | null
    }
    emailDelivery?: {
      host?: string | null
      port?: number | null
      username?: string | null
      password?: string | null
      from?: string | null
      tlsMode?: 'implicit' | 'starttls' | 'insecure' | null
    }
    registration?: {
      defaultRole?: string | null
      domainMode?: 'off' | 'allowlist' | 'blocklist' | null
      domainList?: string[] | null
      // Standard Red Notes: EMAIL CONFIRMATION (part 2).
      emailConfirmationEnabled?: boolean | null
      emailConfirmationGating?: 'block_signin' | 'warn' | null
      emailConfirmationSubject?: string | null
      emailConfirmationBody?: string | null
      emailConfirmationBaseUrl?: string | null
      // Standard Red Notes: SIGNUP CAPS (t50). Admin-owned overlay keys enforced
      // auth-side. A "max" of 0/null = unlimited (clears the cap); windows are in
      // hours. per-device is a best-effort, per-browser soft cap (bypassable).
      signupsPerIpMax?: number | null
      signupsPerIpWindowHours?: number | null
      signupsPerWeekMax?: number | null
      signupsPerDeviceMax?: number | null
      signupsPerDeviceWindowHours?: number | null
    }
    // Standard Red Notes: runtime LOG VERBOSITY (t50). One winston level applied
    // to the api-gateway + auth loggers within the poll interval; null clears the
    // override (falls back to env LOG_LEVEL, then 'info').
    logging?: {
      level?: string | null
    }
    // Standard Red Notes: security knobs — proof-of-work anti-bot + the rate-limit
    // tiers. Enforced server-side; the admin panel persists them here.
    security?: {
      rateLimit?: {
        enabled?: boolean | null
        windowSeconds?: number | null
        loginMax?: number | null
        registrationMax?: number | null
        userWindowSeconds?: number | null
        userMax?: number | null
        adaptiveEscalation?: boolean | null
      }
    }
    // Standard Red Notes: OCR knobs. serverEnabled/defaultLanguage/maxPages/
    // maxImageBytes drive the gateway's server-side OCR endpoint (runtime);
    // clientEnabled/clientDefaultLanguage are the browser-OCR intent surfaced via
    // GET /v1/ocr/config.
    ocr?: {
      serverEnabled?: boolean | null
      defaultLanguage?: string | null
      maxPages?: number | null
      maxImageBytes?: number | null
      clientEnabled?: boolean | null
      clientDefaultLanguage?: string | null
    }
    // Standard Red Notes: WORKFLOWS discovery knobs. `publicUrl` is external
    // navigation metadata for a separately authenticated n8n origin; the client
    // never sends SRN credentials to it or treats this link gate as n8n auth.
    workflows?: {
      enabled?: boolean | null
      publicUrl?: string | null
    }
    // Standard Red Notes: PLUGINS gallery repo base URL. The gateway proxies the
    // repo server-side so the client fetches the index same-origin (strict CSP).
    plugins?: {
      repoUrl?: string | null
      sameOriginRendering?: boolean | null
    }
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.serverSettings),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to update server settings.',
      params: partial,
    })
  }

  /** Admin-only redacted SMTP smoke test. The server never returns provider errors. */
  async adminTestEmailDelivery(recipient: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.emailDeliveryTest),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to test email delivery.',
      params: { recipient },
    })
  }

  /**
   * Standard Red Notes: anti-abuse LIVE view for the admin Security tab — the
   * resolved rate-limit tiers, the IP allow/block lists, and throttle telemetry.
   * Admin-gated at the gateway.
   */
  async adminGetAntiAbuse(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.antiAbuse),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load anti-abuse status.',
    })
  }

  /**
   * Standard Red Notes: add/remove an IP or IPv4 CIDR to the gateway allow/block
   * list. The entry rides in the body so CIDR slashes / IPv6 colons are carried
   * safely; the gateway validates it before persisting.
   */
  async adminMutateAntiAbuseIp(
    list: 'allow' | 'block',
    action: 'add' | 'remove',
    entry: string,
  ): Promise<HttpResponse> {
    const url =
      list === 'block'
        ? action === 'add'
          ? Paths.v1.antiAbuseIpBlock
          : Paths.v1.antiAbuseIpUnblock
        : action === 'add'
          ? Paths.v1.antiAbuseIpAllow
          : Paths.v1.antiAbuseIpUnallow

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, url),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to update the IP list.',
      params: { entry },
    })
  }

  /**
   * Standard Red Notes: list the accounts currently locked out by failed-login
   * lockout (identifier + attempt counters + TTL). Proxied to the auth admin
   * controller, which SCANs its lock keys. Admin-gated at the gateway.
   */
  async adminGetLockedAccounts(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.antiAbuseLockedAccounts),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load locked accounts.',
    })
  }

  /**
   * Standard Red Notes: clear a locked-out account's failed-login counters so it
   * can sign in again. The identifier (a user uuid or email) rides in the body so
   * an email's dots/@ are carried safely. Admin-gated + audited at the auth server.
   */
  async adminUnlockAccount(identifier: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.antiAbuseUnlock),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to unlock the account.',
      params: { identifier },
    })
  }

  /**
   * Standard Red Notes: paginated admin users list (most-recent-first) with
   * optional filters. All filters are optional; the server clamps `limit` to its
   * own maximum (1500). Returns { users, total, limit, offset }.
   */
  async adminListUsers(options: {
    limit?: number
    offset?: number
    sort?: string
    email?: string
    createdAfter?: string
    createdBefore?: string
    role?: string
    banned?: boolean
    subscription?: string
  }): Promise<HttpResponse> {
    const params: Record<string, string> = {}
    if (options.limit !== undefined) {
      params.limit = String(options.limit)
    }
    if (options.offset !== undefined) {
      params.offset = String(options.offset)
    }
    if (options.sort) {
      params.sort = options.sort
    }
    if (options.email) {
      params.email = options.email
    }
    if (options.createdAfter) {
      params.createdAfter = options.createdAfter
    }
    if (options.createdBefore) {
      params.createdBefore = options.createdBefore
    }
    if (options.role) {
      params.role = options.role
    }
    if (options.banned !== undefined) {
      params.banned = String(options.banned)
    }
    if (options.subscription) {
      params.subscription = options.subscription
    }
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.adminUsers),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list users.',
      params,
    })
  }

  /**
   * Standard Red Notes: read-only tail of the server logs across all services.
   * All filters optional; the server clamps `limit` to its own maximum (500).
   * Returns { entries, truncated }.
   */
  async adminGetLogs(options: { limit?: number; service?: string; level?: string }): Promise<HttpResponse> {
    const params: Record<string, string> = {}
    if (options.limit !== undefined) {
      params.limit = String(options.limit)
    }
    if (options.service) {
      params.service = options.service
    }
    if (options.level) {
      params.level = options.level
    }
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.adminLogs),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load server logs.',
      params,
    })
  }

  /**
   * Standard Red Notes: list the controllable supervisord programs plus whether
   * service control is available on this server. `available` is false on an older
   * image whose supervisord conf lacks the [supervisorctl] socket sections. A 404
   * means the endpoint predates this feature — the caller then hides the controls.
   * Returns { available, programs }.
   */
  async adminListServices(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.adminServices),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list controllable services.',
    })
  }

  /**
   * Standard Red Notes: restart/stop/start a single supervisord-managed program.
   * The server enforces an ALLOWLIST of program names and forbids stopping the
   * api-gateway. Restarting the api-gateway requires `confirmSelfInterrupt` (the
   * admin's connection drops briefly); the server replies 202 before the restart
   * lands. Returns { program, action, status } on success.
   */
  async adminControlService(
    name: string,
    action: 'restart' | 'stop' | 'start',
    options: { confirmSelfInterrupt?: boolean } = {},
  ): Promise<HttpResponse> {
    let url = joinPaths(this.host, Paths.v1.adminServiceAction(name, action))
    if (options.confirmSelfInterrupt) {
      url = `${url}?confirmSelfInterrupt=true`
    }
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url,
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: `Failed to ${action} service.`,
    })
  }

  /**
   * Standard Red Notes: OPT-IN container restart (Redis cache / MariaDB) through
   * the locked-down docker-socket-proxy. OFF BY DEFAULT: the server returns 503
   * when the capability is not enabled/reachable, and enforces an ALLOWLIST of
   * container names ({cache, db}). Returns { container, action, status } on
   * success. The caller learns whether to show the control from the `docker`
   * block of adminListServices.
   */
  async adminRestartContainer(name: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.adminContainerRestart(name)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: `Failed to restart ${name}.`,
    })
  }

  /** Standard Red Notes: grant or revoke the admin (internal team) role. */
  async adminSetUserAdminRole(userUuid: string, granted: boolean): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.userAdminRole(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to update admin role.',
      params: { granted },
    })
  }

  /** Standard Red Notes: clear a user's 2FA secret (and recovery requirement). */
  async adminResetUserMFA(userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.userMfaSecret(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to reset 2FA.',
    })
  }

  /**
   * Standard Red Notes: admin-initiated HARD DELETE of a user account across all
   * services. `confirmEmail` must equal the target's email (belt-and-suspenders
   * for the type-the-email UI dialog); the server refuses a mismatch, deleting
   * self, or the last remaining admin.
   */
  async adminDeleteUser(userUuid: string, confirmEmail: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.userDelete(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete user.',
      params: { confirmEmail },
    })
  }

  /** Standard Red Notes: trigger a storage-quota recalculation for a user. */
  async adminFixUserQuota(userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.userFixQuota(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to fix storage quota.',
    })
  }

  /**
   * Standard Red Notes: RBAC groups & granular permissions admin API. All routes
   * hit the gateway /v1/admin/* endpoints, which the auth server re-gates on the
   * ADMIN_USER role.
   */
  async adminGetAvailableRoles(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.roles),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get roles.',
    })
  }

  /**
   * Standard Red Notes: list every role with the permissions it grants, plus the
   * seeded permission catalog and the built-in role names. Roles are enum +
   * migration bound, so only permission ASSIGNMENTS are editable at runtime.
   */
  async adminListRolesWithPermissions(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.rolesDetailed),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get roles with permissions.',
    })
  }

  /**
   * Standard Red Notes: replace the set of permissions a role grants. All names
   * must exist in the catalog; the server can never create/rename/delete a role.
   */
  async adminSetRolePermissions(roleUuid: string, permissionNames: string[]): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.rolePermissions(roleUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to set role permissions.',
      params: { permissionNames },
    })
  }

  /**
   * Standard Red Notes: the permission CATALOG browser — every seeded permission
   * with its category and the roles that grant it.
   */
  async adminGetPermissionCatalog(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.permissionsCatalog),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get permission catalog.',
    })
  }

  /**
   * Standard Red Notes: effective-permissions SIMULATOR — resolve a set of role
   * names to the union of the permissions they grant.
   */
  async adminResolveRoleSetPermissions(roleNames: string[]): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.rolesResolvePermissions),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to resolve role permissions.',
      params: { roleNames },
    })
  }

  /**
   * Standard Red Notes: role INSPECTOR — who holds a role (direct user count +
   * the groups conferring it).
   */
  async adminGetRoleHolders(roleUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.roleHolders(roleUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get role holders.',
    })
  }

  /**
   * Standard Red Notes: create an admin-defined CUSTOM role (group-conferrable).
   * The server normalizes the name, guards against shadowing a built-in, and
   * validates every permission against the catalog.
   */
  async adminCreateCustomRole(
    name: string,
    description: string | null,
    permissionNames: string[],
  ): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.roles),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create custom role.',
      params: { name, description, permissionNames },
    })
  }

  /**
   * Standard Red Notes: delete an admin-created CUSTOM role. The server refuses
   * to delete a built-in role or a role that is still in use.
   */
  async adminDeleteCustomRole(roleUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.role(roleUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete custom role.',
    })
  }

  async adminListGroups(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.groups),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list groups.',
    })
  }

  async adminCreateGroup(name: string, description: string | null, roleNames: string[]): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.groups),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create group.',
      params: { name, description, roleNames },
    })
  }

  async adminDeleteGroup(groupUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.group(groupUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete group.',
    })
  }

  async adminSetGroupRoles(groupUuid: string, roleNames: string[]): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.groupRoles(groupUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to set group roles.',
      params: { roleNames },
    })
  }

  async adminListGroupMembers(groupUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.groupMembers(groupUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list group members.',
    })
  }

  async adminAddUserToGroup(groupUuid: string, userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.groupMembers(groupUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to add user to group.',
      params: { userUuid },
    })
  }

  async adminRemoveUserFromGroup(groupUuid: string, userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.groupMember(groupUuid, userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to remove user from group.',
    })
  }

  async adminGetUserEffectivePermissions(userUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.userEffectivePermissions(userUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to get effective permissions.',
    })
  }

  /**
   * Standard Red Notes: app-specific passwords. These hit the gateway
   * /v1/app-passwords routes, protected by the cross-service token middleware
   * (the auth server scopes every call to the authenticated user). The plaintext
   * secret is only ever returned by `createAppPassword` and never stored or
   * retrievable again.
   */
  async listAppPasswords(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.appPasswords),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list app passwords.',
    })
  }

  async createAppPassword(label: string, expiresInDays?: number | null): Promise<HttpResponse> {
    const params: { label: string; expiresInDays?: number } = { label }
    if (expiresInDays !== undefined && expiresInDays !== null) {
      params.expiresInDays = expiresInDays
    }

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.appPasswords),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create app password.',
      params,
    })
  }

  /**
   * Soft-revoke (default). Keeps the record so there is an audit trail; the auth
   * server rejects it immediately on sign-in.
   */
  async revokeAppPassword(appPasswordId: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.appPassword(appPasswordId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke app password.',
    })
  }

  /**
   * Permanent hard-delete. Purges the record entirely (no audit trail retained).
   */
  async deleteAppPassword(appPasswordId: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.appPasswordPermanent(appPasswordId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete app password.',
    })
  }

  /**
   * Standard Red Notes: SELF-SERVE / REFERRAL invite links. These hit the gateway
   * /v1/users/me/invite-links routes (cross-service-token protected); the auth
   * server scopes every call to the authenticated user. A user creates/lists/revokes
   * their OWN links only; the raw invite token + relative path are returned EXACTLY
   * ONCE on create. A user link can never carry a role/domain override or bypass
   * approval — the auth server enforces that privilege guard. Gated by the
   * `registration.invitesPerUser` overlay (0 = self-serve disabled).
   */
  async createMyInviteLink(body: {
    maxUses?: number
    expiresInHours?: number | null
    label?: string | null
  }): Promise<HttpResponse> {
    const params: Record<string, unknown> = {}
    if (body.maxUses !== undefined) {
      params.maxUses = body.maxUses
    }
    if (body.expiresInHours !== undefined) {
      params.expiresInHours = body.expiresInHours
    }
    if (body.label !== undefined) {
      params.label = body.label
    }

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.meInviteLinks),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create invite link.',
      params,
    })
  }

  async listMyInviteLinks(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.meInviteLinks),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list invite links.',
    })
  }

  async revokeMyInviteLink(uuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.meInviteLink(uuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke invite link.',
    })
  }

  /**
   * Standard Red Notes: trusted devices. These hit the gateway
   * /v1/trusted-devices routes (cross-service-token protected). Marking a device
   * trusted is only possible from an already-authenticated (already-2FA'd)
   * session. `createTrustedDevice` returns a plaintext device token EXACTLY ONCE;
   * the caller persists it (see persistTrustedDeviceToken) and presents it as
   * `trusted_device_token` on the login-params request to skip the interactive
   * second factor. Trust bypasses ONLY the 2FA gate, never the account password.
   */
  async listTrustedDevices(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.trustedDevices),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list trusted devices.',
    })
  }

  async createTrustedDevice(label: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.trustedDevices),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to trust this device.',
      params: { label },
    })
  }

  async deleteTrustedDevice(deviceId: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.trustedDevice(deviceId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke trusted device.',
    })
  }

  /**
   * Standard Red Notes: push-MFA approvals.
   *  - listPendingMfaApprovals / resolvePendingMfaApproval are called by an
   *    already-authenticated trusted session.
   *  - getPendingMfaApprovalStatus is called UNAUTHENTICATED by the new device
   *    while it waits for approval; it is gated only by the high-entropy,
   *    single-use challenge id returned in the 2FA error payload.
   */
  async listPendingMfaApprovals(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.pendingMfaApprovals),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list pending sign-in approvals.',
    })
  }

  async resolvePendingMfaApproval(challengeId: string, approve: boolean): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.resolvePendingMfaApproval(challengeId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to resolve sign-in approval.',
      params: { approve },
    })
  }

  async getPendingMfaApprovalStatus(challengeId: string): Promise<HttpResponse> {
    // Unauthenticated: the new device is not signed in yet. The challenge id is
    // the only credential and is high-entropy + single-use.
    return this.httpService.get(joinPaths(this.host, Paths.v1.pendingMfaApprovalStatus(challengeId)), {}, {})
  }

  /**
   * Standard Red Notes: MCP scoped tokens. These hit the gateway /v1/mcp-tokens
   * routes (cross-service-token protected) and let the headless MCP bridge
   * authenticate without the account email + password. The body carries the
   * account's items keys wrapped client-side under a secret the server never
   * sees; the full token (server token + wrap secret) is only assembled in the
   * browser and returned to the user once by `createMcpToken`.
   */
  async listMcpTokens(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.mcpTokens),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list MCP tokens.',
    })
  }

  async createMcpToken(body: {
    label: string
    scope: string
    scopeTagUuids?: string[]
    wrappedKeys: string
    kdfSalt: string
    kdfParams: string
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.mcpTokens),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create MCP token.',
      params: body,
    })
  }

  async deleteMcpToken(mcpTokenId: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.mcpToken(mcpTokenId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete MCP token.',
    })
  }

  /**
   * Standard Red Notes: outbound webhooks. These hit the gateway /v1/webhooks
   * routes (cross-service-token protected) and let a signed-in user manage the
   * HTTP endpoints that Standard Red Notes calls when subscribed events occur.
   * `listWebhooks` also returns the catalogue of subscribable event names
   * (`availableEvents`). `createWebhook` returns the HMAC signing secret exactly
   * once — it is never retrievable again. Only admins may set `global`.
   */
  async listWebhooks(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.webhooks),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list webhooks.',
    })
  }

  async createWebhook(body: { targetUrl: string; events: string[]; global?: boolean }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.webhooks),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create webhook.',
      params: body,
    })
  }

  async deleteWebhook(webhookId: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.webhook(webhookId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete webhook.',
    })
  }

  /**
   * Standard Red Notes: public share links. These authed routes let a signed-in
   * user create, list, and revoke read-only share links. The server only ever
   * stores the ciphertext (`encryptedPayload`); the decryption key lives in the
   * URL fragment and is never sent to the server. The public read of a share
   * (GET /v1/shares/:shareId) is unauthenticated and is done by the viewer with a
   * bare fetch, so it is intentionally not implemented here.
   */
  async createShare(body: {
    type: 'note' | 'tag' | 'account'
    encryptedPayload: string
    nickname?: string | null
    /** Burn after reading: consume the share after its first successful open. */
    oneTimeView?: boolean
    /** Optional minutes the share stays readable AFTER the first open, then expires. */
    viewExpiresMinutes?: number | null
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.shares),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create share link.',
      params: body,
    })
  }

  async listShares(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.shares),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list share links.',
    })
  }

  async revokeShare(shareId: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.share(shareId)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke share link.',
    })
  }

  /**
   * Standard Red Notes: dead man's switch / survivor switch. These authed routes
   * let a signed-in user create, list, check in on, and delete switches. Unlike a
   * plain share link, the server stores the FULL share URL (link + decryption key)
   * so it can email it to the recipient if the user stops checking in.
   */
  async createDeadManSwitch(body: {
    recipientEmail: string
    shareUrl: string
    message?: string
    intervalDays: number
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.deadManSwitches),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create survivor switch.',
      params: body,
    })
  }

  async listDeadManSwitches(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.deadManSwitches),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list survivor switches.',
    })
  }

  async checkInDeadManSwitch(id: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.deadManSwitchCheckIn(id)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to check in to survivor switch.',
    })
  }

  async deleteDeadManSwitch(id: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.deadManSwitch(id)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete survivor switch.',
    })
  }

  /**
   * Standard Red Notes: email reminders. These authed routes let a signed-in user
   * register, list, and delete reminders the server may EMAIL when due. The reminder
   * time + message are sent in PLAINTEXT (they leave end-to-end encryption) because
   * the user explicitly opted that reminder into email delivery. Only ever called
   * for reminders the user has opted in.
   */
  async createEmailReminder(body: { dueAt: string; message: string }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.emailReminders),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create email reminder.',
      params: body,
    })
  }

  async listEmailReminders(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.emailReminders),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list email reminders.',
    })
  }

  async deleteEmailReminder(id: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.emailReminder(id)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to delete email reminder.',
    })
  }

  /**
   * Standard Red Notes: server-side reminder DELIVERY (WhatsApp / Telegram /
   * email). These hit the gateway /v1/reminder-delivery routes (cross-service-token
   * protected). `getReminderDeliveryConfig` reports whether the feature is enabled
   * on this server and allowed for this user (fail-closed); the delivery-config
   * get/put manage the user's channel/destination/enabled record; list/publish
   * cover the PLAINTEXT reminders the user explicitly opted into server delivery.
   * Mirrors the emailReminder methods above.
   */
  async getReminderDeliveryConfig(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.reminderDeliveryConfig),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load reminder delivery config.',
    })
  }

  async getReminderDeliveryDeliveryConfig(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.reminderDeliveryDeliveryConfig),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load reminder delivery settings.',
    })
  }

  async setReminderDeliveryDeliveryConfig(body: {
    channel: string
    destination: string
    enabled: boolean
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Put,
      url: joinPaths(this.host, Paths.v1.reminderDeliveryDeliveryConfig),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to save reminder delivery settings.',
      params: body,
    })
  }

  async listReminderDeliveries(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.reminderDeliveryReminders),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list published reminders.',
    })
  }

  async publishReminderDelivery(body: {
    id: string
    message: string
    dueAtUtc: string
    channel?: string
    destination?: string
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.reminderDeliveryReminders),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to publish reminder for delivery.',
      params: body,
    })
  }

  /** Unpublish (remove) a published reminder so the server never delivers it. */
  async deleteReminderDelivery(id: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.reminderDeliveryReminder(id)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to unpublish reminder.',
    })
  }

  /**
   * Standard Red Notes: scoped, revocable CalDAV access tokens. These hit the
   * gateway /v1/caldav/tokens routes (cross-service-token protected).
   * `getCaldavConfig` reports availability (env master switch + per-user opt-in);
   * `createCaldavToken` returns the plaintext token exactly once (never again).
   * Mirrors the MCP token methods.
   */
  async getCaldavConfig(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.caldavConfig),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load CalDAV config.',
    })
  }

  async listCaldavTokens(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.caldavTokens),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list CalDAV tokens.',
    })
  }

  async createCaldavToken(body: { label: string }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.caldavTokens),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to create CalDAV token.',
      params: body,
    })
  }

  async deleteCaldavToken(tokenUuid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.caldavToken(tokenUuid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke CalDAV token.',
    })
  }

  /** Revoke every CalDAV token owned by the current user. */
  async deleteAllCaldavTokens(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.caldavTokens),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to revoke CalDAV tokens.',
    })
  }

  /** List the explicit plaintext todos currently exposed through CalDAV. */
  async listCaldavTodos(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.caldavTodos),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to list published CalDAV items.',
    })
  }

  /** Create or replace one explicit plaintext CalDAV todo. */
  async publishCaldavTodo(body: {
    uid?: string
    summary: string
    description?: string
    due?: string
    start?: string
    completed?: boolean
    completedAt?: string
    priority?: number
  }): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.caldavTodos),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to publish the CalDAV item.',
      params: body,
    })
  }

  /** Remove one plaintext item from the CalDAV projection. */
  async deleteCaldavTodo(uid: string): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url: joinPaths(this.host, Paths.v1.caldavTodo(uid)),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to unpublish the CalDAV item.',
    })
  }

  public downloadFeatureUrl(url: string): Promise<HttpResponse> {
    return this.request({
      verb: HttpVerb.Get,
      url,
      external: true,
      fallbackErrorMessage: API_MESSAGE_GENERIC_INVALID_LOGIN,
    })
  }

  /**
   * Standard Red Notes: fetch the plugins (extensions) gallery index via the
   * SAME-ORIGIN gateway proxy (`/v1/plugins/index`) instead of hitting the
   * external plugins CDN directly. The direct fetch is blocked by the strict SPA
   * CSP (`connect-src 'self'`); the gateway performs the outbound fetch against
   * the operator-configured repo base and returns `packages.json` from this
   * origin. Authenticated with the session token like the other feature calls.
   */
  public downloadPluginsIndex(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.pluginsIndex),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to download the plugins list.',
    })
  }

  /**
   * Standard Red Notes: fetch the client-readable plugins config
   * ({ repoUrl, sameOriginRendering }) via the gateway. The web client uses it to
   * decide whether to rewrite an installed trusted-repo component's external
   * `hosted_url` to the same-origin component route so its iframe renders under
   * the strict CSP `frame-src 'self'`. Authenticated with the session token.
   */
  public downloadPluginsConfig(): Promise<HttpResponse> {
    return this.tokenRefreshableRequest({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.pluginsConfig),
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: 'Failed to load the plugins configuration.',
    })
  }

  public async getNewSubscriptionToken(): Promise<string | undefined> {
    const url = joinPaths(this.host, Paths.v1.subscriptionTokens)
    const response = await this.request<PostSubscriptionTokensResponse>({
      verb: HttpVerb.Post,
      url,
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_ACCESS_PURCHASE,
    })

    if (isErrorResponse(response)) {
      return undefined
    }

    return response.data.token
  }

  public async downloadOfflineFeaturesFromRepo(dto: {
    repo: SNFeatureRepo
  }): Promise<{ features: AnyFeatureDescription[]; roles: string[] } | ClientDisplayableError> {
    try {
      const featuresUrl = dto.repo.offlineFeaturesUrl
      const extensionKey = dto.repo.offlineKey
      if (!featuresUrl || !extensionKey) {
        throw Error('Cannot download offline repo without url and offlineKEy')
      }

      const TRUSTED_FEATURE_HOSTS = ['api.standardnotes.com', 'localhost']

      const { hostname } = new URL(featuresUrl)

      if (!TRUSTED_FEATURE_HOSTS.includes(hostname)) {
        return new ClientDisplayableError(`The offline features host ${hostname} is not in the trusted allowlist.`)
      }

      const response = await this.request<GetOfflineFeaturesResponse>({
        verb: HttpVerb.Get,
        url: featuresUrl,
        fallbackErrorMessage: API_MESSAGE_FAILED_OFFLINE_FEATURES,
        customHeaders: [{ key: 'x-offline-token', value: extensionKey }],
      })

      if (isErrorResponse(response)) {
        return ClientDisplayableError.FromNetworkError(response)
      }
      const data = response.data
      return {
        features: data?.features || [],
        roles: data?.roles || [],
      }
    } catch {
      return new ClientDisplayableError(API_MESSAGE_FAILED_OFFLINE_ACTIVATION)
    }
  }

  public async createUserFileValetToken(
    remoteIdentifier: string,
    operation: ValetTokenOperation,
    unencryptedFileSize?: number,
  ): Promise<string | ClientDisplayableError> {
    const url = joinPaths(this.host, Paths.v1.createUserFileValetToken)

    const params: CreateValetTokenPayload = {
      operation,
      resources: [{ remoteIdentifier, unencryptedFileSize: unencryptedFileSize || 0 }],
    }

    const response = await this.tokenRefreshableRequest<CreateValetTokenResponse>({
      verb: HttpVerb.Post,
      url: url,
      authentication: this.getSessionAccessToken(),
      fallbackErrorMessage: API_MESSAGE_FAILED_CREATE_FILE_TOKEN,
      params,
    })

    if (isErrorResponse(response)) {
      return new ClientDisplayableError(response.data?.error?.message as string)
    }

    if (!response.data?.success) {
      return new ClientDisplayableError(response.data?.reason as string, undefined, response.data?.reason as string)
    }

    return response.data?.valetToken
  }

  public async startUploadSession(
    valetToken: string,
    ownershipType: FileOwnershipType,
  ): Promise<HttpResponse<StartUploadSessionResponse>> {
    const url = joinPaths(
      this.getFilesHost(),
      ownershipType === 'user' ? Paths.v1.startUploadSession : Paths.v1.startSharedVaultUploadSession,
    )

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Post,
      url,
      customHeaders: [{ key: 'x-valet-token', value: valetToken }],
      fallbackErrorMessage: Strings.Network.Files.FailedStartUploadSession,
    })
  }

  public async deleteFile(
    valetToken: string,
    ownershipType: FileOwnershipType,
  ): Promise<HttpResponse<StartUploadSessionResponse>> {
    const url = joinPaths(
      this.getFilesHost(),
      ownershipType === 'user' ? Paths.v1.deleteFile : Paths.v1.deleteSharedVaultFile,
    )

    return this.tokenRefreshableRequest({
      verb: HttpVerb.Delete,
      url,
      customHeaders: [{ key: 'x-valet-token', value: valetToken }],
      fallbackErrorMessage: Strings.Network.Files.FailedDeleteFile,
    })
  }

  public async uploadFileBytes(
    valetToken: string,
    ownershipType: FileOwnershipType,
    chunkId: number,
    encryptedBytes: Uint8Array,
  ): Promise<boolean> {
    if (chunkId === 0) {
      throw Error('chunkId must start with 1')
    }
    const url = joinPaths(
      this.getFilesHost(),
      ownershipType === 'user' ? Paths.v1.uploadFileChunk : Paths.v1.uploadSharedVaultFileChunk,
    )

    const response = await this.tokenRefreshableRequest<UploadFileChunkResponse>({
      verb: HttpVerb.Post,
      url,
      rawBytes: encryptedBytes,
      customHeaders: [
        { key: 'x-valet-token', value: valetToken },
        { key: 'x-chunk-id', value: chunkId.toString() },
        { key: 'Content-Type', value: 'application/octet-stream' },
      ],
      fallbackErrorMessage: Strings.Network.Files.FailedUploadFileChunk,
    })

    if (isErrorResponse(response)) {
      return false
    }

    return response.data.success
  }

  public async closeUploadSession(
    valetToken: string,
    ownershipType: FileOwnershipType,
  ): Promise<boolean | ClientDisplayableError> {
    const url = joinPaths(
      this.getFilesHost(),
      ownershipType === 'user' ? Paths.v1.closeUploadSession : Paths.v1.closeSharedVaultUploadSession,
    )

    const response = await this.tokenRefreshableRequest<CloseUploadSessionResponse>({
      verb: HttpVerb.Post,
      url,
      customHeaders: [{ key: 'x-valet-token', value: valetToken }],
      fallbackErrorMessage: Strings.Network.Files.FailedCloseUploadSession,
    })

    if (isErrorResponse(response)) {
      return ClientDisplayableError.FromNetworkError(response)
    }

    return response.data.success
  }

  public async moveFile(valetToken: string): Promise<boolean> {
    const url = joinPaths(this.getFilesHost(), Paths.v1.moveFile)

    const response = await this.tokenRefreshableRequest<MoveFileResponse>({
      verb: HttpVerb.Post,
      url,
      customHeaders: [{ key: 'x-valet-token', value: valetToken }],
      fallbackErrorMessage: Strings.Network.Files.FailedCloseUploadSession,
    })

    if (isErrorResponse(response)) {
      return false
    }

    return response.data.success
  }

  public getFilesDownloadUrl(ownershipType: FileOwnershipType): string {
    if (ownershipType === 'user') {
      return joinPaths(this.getFilesHost(), Paths.v1.downloadFileChunk)
    } else if (ownershipType === 'shared-vault') {
      return joinPaths(this.getFilesHost(), Paths.v1.downloadSharedVaultFileChunk)
    } else {
      throw Error('Invalid download type')
    }
  }

  public async downloadFile({
    file,
    chunkIndex,
    valetToken,
    ownershipType,
    contentRangeStart,
    onBytesReceived,
    shouldAbort,
  }: DownloadFileParams): Promise<ClientDisplayableError | undefined> {
    if (file.encryptedChunkSizes.length === 0) {
      return new ClientDisplayableError('File download metadata does not contain an authenticated encrypted chunk.')
    }

    let declaredTotalSize = 0
    for (const size of file.encryptedChunkSizes) {
      if (!Number.isSafeInteger(size) || size <= 0) {
        return new ClientDisplayableError('File download metadata contains an invalid encrypted chunk size.')
      }
      declaredTotalSize += size
      if (!Number.isSafeInteger(declaredTotalSize)) {
        return new ClientDisplayableError('File download metadata exceeds the supported encrypted size.')
      }
    }

    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= file.encryptedChunkSizes.length) {
      return new ClientDisplayableError('File download requested an encrypted chunk outside its metadata.')
    }

    const declaredStart = file.encryptedChunkSizes
      .slice(0, chunkIndex)
      .reduce((total, encryptedChunkSize) => total + encryptedChunkSize, 0)
    if (!Number.isSafeInteger(contentRangeStart) || contentRangeStart !== declaredStart) {
      return new ClientDisplayableError('File download requested a range that does not match its encrypted metadata.')
    }

    const url = this.getFilesDownloadUrl(ownershipType)

    let expectedRangeStart = contentRangeStart
    for (let currentChunkIndex = chunkIndex; currentChunkIndex < file.encryptedChunkSizes.length; currentChunkIndex++) {
      if (shouldAbort?.()) {
        return undefined
      }

      const expectedChunkSize = file.encryptedChunkSizes[currentChunkIndex]
      const expectedRangeEnd = expectedRangeStart + expectedChunkSize - 1
      const request: HttpRequest = {
        verb: HttpVerb.Get,
        url,
        customHeaders: [
          { key: 'x-valet-token', value: valetToken },
          {
            key: 'x-chunk-size',
            value: expectedChunkSize.toString(),
          },
          { key: 'range', value: `bytes=${expectedRangeStart}-${expectedRangeEnd}` },
        ],
        responseType: 'arraybuffer',
      }

      const response = await this.tokenRefreshableRequest<DownloadFileChunkResponse>({
        ...request,
        fallbackErrorMessage: Strings.Network.Files.FailedDownloadFileChunk,
      })

      if (isErrorResponse(response)) {
        return ClientDisplayableError.FromNetworkError(response)
      }
      if ((response.status as number) !== 206) {
        return new ClientDisplayableError('File download response was not a partial-content response.')
      }

      const contentRangeHeader = response.headers?.get('content-range')
      if (!contentRangeHeader) {
        return new ClientDisplayableError('File download response did not include a Content-Range header.')
      }

      const matches = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(contentRangeHeader)
      if (!matches) {
        return new ClientDisplayableError('File download response contained a malformed Content-Range header.')
      }

      const rangeStart = Number(matches[1])
      const rangeEnd = Number(matches[2])
      const totalSize = Number(matches[3])
      if (
        !Number.isSafeInteger(rangeStart) ||
        !Number.isSafeInteger(rangeEnd) ||
        !Number.isSafeInteger(totalSize) ||
        rangeStart !== expectedRangeStart ||
        rangeEnd !== expectedRangeEnd ||
        totalSize !== declaredTotalSize
      ) {
        return new ClientDisplayableError(
          'File download response range does not match the requested encrypted chunk metadata.',
        )
      }

      if (!(response.data instanceof ArrayBuffer)) {
        return new ClientDisplayableError('File download response did not contain encrypted binary data.')
      }
      const bytesReceived = new Uint8Array(response.data)
      if (bytesReceived.byteLength !== expectedChunkSize) {
        return new ClientDisplayableError(
          `File download chunk ${currentChunkIndex} had ${bytesReceived.byteLength} bytes; expected ${expectedChunkSize}.`,
        )
      }

      if (shouldAbort?.()) {
        return undefined
      }
      await onBytesReceived(bytesReceived)
      expectedRangeStart = expectedRangeEnd + 1
    }

    return undefined
  }

  async checkIntegrity(integrityPayloads: IntegrityPayload[]): Promise<HttpResponse<CheckIntegrityResponse>> {
    return this.tokenRefreshableRequest<CheckIntegrityResponse>({
      verb: HttpVerb.Post,
      url: joinPaths(this.host, Paths.v1.checkIntegrity),
      params: {
        integrityPayloads,
      },
      fallbackErrorMessage: API_MESSAGE_GENERIC_INTEGRITY_CHECK_FAIL,
      authentication: this.getSessionAccessToken(),
    })
  }

  async getSingleItem(itemUuid: string): Promise<HttpResponse<GetSingleItemResponse>> {
    return this.tokenRefreshableRequest<GetSingleItemResponse>({
      verb: HttpVerb.Get,
      url: joinPaths(this.host, Paths.v1.getSingleItem(itemUuid)),
      fallbackErrorMessage: API_MESSAGE_GENERIC_SINGLE_ITEM_SYNC_FAIL,
      authentication: this.getSessionAccessToken(),
    })
  }

  private preprocessingError() {
    if (this.refreshingSession) {
      return this.createErrorResponse(API_MESSAGE_TOKEN_REFRESH_IN_PROGRESS, HttpStatusCode.BadRequest)
    }

    if (!this.session) {
      return this.createErrorResponse(API_MESSAGE_INVALID_SESSION, HttpStatusCode.BadRequest)
    }

    return undefined
  }

  private preprocessAuthenticatedErrorResponse(response: HttpResponse) {
    if (!this.session) {
      return
    }

    /**
     * In most cases the ExpiredAccessToken erorr shouldn't reach this function, since if a 498 is caught, a refresh
     * will automatically take place. However there does appear to be rare cases where for some reason the 498 falls through,
     * perhaps because for example the server responds to a refresh request with a 498. In those cases, we'll just
     * fallback here to the invalid session observer so that the user can be reprompted for auth.
     */
    if (response.status === HttpStatusCode.Unauthorized || response.status === HttpStatusCode.ExpiredAccessToken) {
      this.invalidSessionObserver?.(response.data.error?.tag === ErrorTag.RevokedSession)
    }
  }

  private getSessionAccessToken(): string | undefined {
    if (!this.session) {
      return undefined
    }

    if (this.session instanceof Session) {
      return this.session.accessToken.value
    }

    return this.session.accessToken
  }

  public getCaptchaUrl() {
    const response = this.httpService.get<MetaEndpointResponse>(Paths.v1.meta)
    return response
  }
}
