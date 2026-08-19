import { WebCrypto } from '@/Application/Crypto'
import { WebOrDesktopDevice } from '@/Application/Device/WebOrDesktopDevice'
import {
  DeinitSource,
  Platform,
  SNApplication,
  DesktopDeviceInterface,
  isDesktopDevice,
  DeinitMode,
  ApplicationEvent,
  PrefKey,
  PrefDefaults,
  SNTag,
  ContentType,
  DecryptedItemInterface,
  WebAppEvent,
  MobileDeviceInterface,
  MobileUnlockTiming,
  DecryptedItem,
  Environment,
  InternalFeatureService,
  InternalFeatureServiceInterface,
  NoteContent,
  SNNote,
  DesktopManagerInterface,
  FileItem,
  ApiVersion,
} from '@standardnotes/snjs'
import { action, computed, makeObservable, observable } from 'mobx'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { PanelResizedData } from '@/Types/PanelResizedData'
import { getBlobFromBase64, isDesktopApplication, isDev } from '@/Utils'
import {
  ArchiveManager,
  AutolockService,
  ChangelogService,
  Importer,
  IsGlobalSpellcheckEnabled,
  IsMobileDevice,
  IsNativeIOS,
  IsNativeMobileWeb,
  KeyboardService,
  PluginsServiceInterface,
  RouteServiceInterface,
  ThemeManager,
  VaultDisplayServiceInterface,
  WebAlertService,
  WebApplicationInterface,
} from '@standardnotes/ui-services'
import { PreferencePaneId } from '@standardnotes/services'
import { MobileWebReceiver, NativeMobileEventListener } from '../NativeMobileWeb/MobileWebReceiver'
import { setCustomViewportHeight } from '@/setViewportHeightWithFallback'
import { FeatureName } from '@/Controllers/FeatureName'
import { getManualSyncModeEnabled, subscribeManualSyncMode } from '@/Utils/ManualSyncSetting'
import { VisibilityObserver } from './VisibilityObserver'
import { DevMode } from './DevMode'
import { ToastType, addToast, dismissToast } from '@standardnotes/toast'
import { WebDependencies } from './Dependencies/WebDependencies'
import { WebProofOfWorkSolver } from '../Utils/ProofOfWork/WebProofOfWorkSolver'
import { Web_TYPES } from './Dependencies/Types'
import { ApplicationEventObserver } from '@/Event/ApplicationEventObserver'
import { PaneController } from '@/Controllers/PaneController/PaneController'
import { LinkingController } from '@/Controllers/LinkingController'
import { MomentsService } from '@/Controllers/Moments/MomentsService'
import { FeaturesController } from '@/Controllers/FeaturesController'
import { FilesController } from '@/Controllers/FilesController'
import { ItemListController } from '@/Controllers/ItemList/ItemListController'
import { AndroidBackHandler } from '@/NativeMobileWeb/AndroidBackHandler'
import { SubscriptionController } from '@/Controllers/Subscription/SubscriptionController'
import { PurchaseFlowController } from '@/Controllers/PurchaseFlow/PurchaseFlowController'
import { AccountMenuController } from '@/Controllers/AccountMenu/AccountMenuController'
import { PreferencesController } from '@/Controllers/PreferencesController'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import { ImportModalController } from '@/Components/ImportModal/ImportModalController'
import { ExportModalController } from '@/Controllers/ExportModal/ExportModalController'
import { SyncStatusController } from '@/Controllers/SyncStatusController'
import { HistoryModalController } from '@/Controllers/NoteHistory/HistoryModalController'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { FilePreviewModalController } from '@/Controllers/FilePreviewModalController'
import { OpenSubscriptionDashboard } from './UseCase/OpenSubscriptionDashboard'
import { ItemGroupController } from '@/Components/NoteView/Controller/ItemGroupController'
import { NoAccountWarningController } from '@/Controllers/NoAccountWarningController'
import { NotificationsController } from '@/Controllers/NotificationsController'
import { SearchOptionsController } from '@/Controllers/SearchOptionsController'
import { PersistenceService } from '@/Controllers/Abstract/PersistenceService'
import { removeFromArray } from '@standardnotes/utils'
import { FileItemActionType } from '@/Components/AttachedFilesPopover/PopoverFileItemAction'
import { RecentActionsState } from './Recents'
import { RecentNotesState } from '@/Components/Preferences/Panes/RecentNotes/RecentNotesState'
import { SearchIndexRunner } from '@/Utils/Items/Search/SearchIndexRunner'
import { DecryptionPool } from '@/Utils/Items/Decryption/DecryptionPool'
import { AutoEmptyTrashService } from '@/Services/AutoEmptyTrash/AutoEmptyTrashService'
import { UpdateCheckService } from '@/Services/UpdateCheck/UpdateCheckService'
import { PendingMfaApprovalsNotifier } from '@/Services/PendingMfaApprovals/PendingMfaApprovalsNotifier'
import { CommandService } from '../Components/CommandPalette/CommandService'
import { CrossTabCoordinator } from './CrossTab/CrossTabCoordinator'
import { reloadForeignDatabasePayloads } from './CrossTab/ReloadForeignDatabasePayloads'
import { WebDevice } from './Device/WebDevice'
import { assistantHttpError } from '@/Assistant/AssistantHttpError'
import {
  AuthenticatedRpcError,
  deriveOpaqueSyncSessionScope,
  SyncCapability,
  SyncTicketResponse,
  WebSocketSyncTransport,
} from '@/Services/SyncTransport/WebSocketSyncTransport'

export type WebEventObserver = (event: WebAppEvent, data?: unknown) => void

export class WebApplication extends SNApplication implements WebApplicationInterface {
  readonly enableUnfinishedFeatures: boolean = window?.enabledUnfinishedFeatures

  private readonly deps = new WebDependencies(this)

  private visibilityObserver?: VisibilityObserver
  private readonly webEventObservers: WebEventObserver[] = []
  private disposers: (() => void)[] = []

  public isSessionsModalVisible = false

  public devMode?: DevMode
  public recents = new RecentActionsState()
  // Standard Red Notes: tracks recently-opened notes for the "Recent Notes"
  // preferences pane. Created in createBackgroundServices() so it observes note
  // opens from app start, even while the preferences modal is closed.
  private _recentNotesState?: RecentNotesState
  // Standard Red Notes: background search-index runner (enable/disable, start/stop,
  // scheduler). Created on LocalDataLoaded (see wireSearchIndexRunner) so its
  // auto-start-on-launch fires app-wide; the getter caches it. Drives WHEN the
  // off-thread index is rebuilt.
  private _searchIndexRunner?: SearchIndexRunner
  // Standard Red Notes: auto-empty-trash maintenance service. Created in
  // createBackgroundServices() so it can react to the first full sync and
  // periodically purge aged trashed notes while the app is open.
  private _autoEmptyTrashService?: AutoEmptyTrashService
  // Standard Red Notes: self-hosted "Check for updates" scheduler. Created in
  // createBackgroundServices() so the launch-time auto check and the in-session
  // re-evaluation timer run from app start; torn down (timer cleared) in deinit.
  private _updateCheckService?: UpdateCheckService
  // Standard Red Notes: push-MFA approvals app-wide notifier. Created in
  // createBackgroundServices() so a "new sign-in awaiting your approval" toast
  // reaches the user even when the Security preferences pane is closed;
  // torn down (socket observer + fallback-poll timer) in deinit.
  private _pendingMfaApprovalsNotifier?: PendingMfaApprovalsNotifier
  // Standard Red Notes: off-main-thread decryption worker pool. Installed onto the
  // ItemsEncryptionService so bulk decrypts (esp. cold-loading a large vault)
  // parallelize across CPU cores instead of blocking the main thread.
  private _decryptionPool?: DecryptionPool
  // Standard Red Notes: web/desktop proof-of-work solver, registered on the
  // session manager so a `proof-of-work-required` challenge during register /
  // sign-in is solved off the UI thread (Web Worker). Torn down in deinit.
  private _proofOfWorkSolver?: WebProofOfWorkSolver
  /** Dedicated worker owning the websocket account-sync transport. */
  private _webSocketSyncTransport?: WebSocketSyncTransport

  // Standard Red Notes: per-workspace cross-tab coordinator for SAVE INVALIDATION. Emits
  // the uuids this tab saves to the shared IndexedDB and, on a peer's save broadcast,
  // reloads only those rows into the in-memory collection without scheduling a server sync
  // or rebroadcasting the same write. (The KEYCHAIN coordinator lives
  // on WebDevice because the keychain is a single global blob, not per-workspace.)
  private _saveCrossTabCoordinator?: CrossTabCoordinator

  constructor(
    deviceInterface: WebOrDesktopDevice,
    // Accept a possibly-nullish platform: snjs throws "platform must be supplied"
    // if it ever reaches the base Application constructor undefined. We coerce to
    // a safe web default here — the single, permanent gate every creation path
    // funnels through — so a flaky platform detection can never crash app boot.
    platform: Platform | undefined,
    identifier: string,
    defaultSyncServerHost: string,
    webSocketUrl: string,
  ) {
    const resolvedPlatform: Platform = platform ?? Platform.LinuxWeb
    super({
      environment: deviceInterface.environment,
      platform: resolvedPlatform,
      deviceInterface: deviceInterface,
      crypto: WebCrypto,
      alertService: new WebAlertService(),
      identifier,
      defaultHost: defaultSyncServerHost,
      appVersion: deviceInterface.appVersion,
      webSocketUrl: webSocketUrl,
      /**
       * iOS file:// based origin does not work with production cookies
       */
      apiVersion:
        resolvedPlatform === Platform.Ios || resolvedPlatform === Platform.Android ? ApiVersion.v0 : ApiVersion.v1,
      // Standard Red Notes: cold-load emits payloads in batches; each batch costs
      // a full display-controller resort + list reload + React render, so FEWER,
      // larger batches cut the dominant main-thread cost at scale (the per-batch
      // overhead, not decryption, bounds large-vault load). Decryption is now
      // off-thread (worker pool), so large batches don't freeze the UI.
      loadBatchSize: deviceInterface.environment === Environment.Mobile ? 250 : 5000,
      sleepBetweenBatches: deviceInterface.environment === Environment.Mobile ? 250 : 5,
      // Standard Red Notes: INTENDED production default for web. The shared
      // framework default is `false` ("zero-risk"), but web deliberately overrides
      // to `true` for the memory benefit at scale — items decrypt on demand and
      // re-hydrate when accessed. Do NOT "fix" this back to the framework default.
      lazyDecryptEnabled: true,
      allowMultipleSelection: deviceInterface.environment !== Environment.Mobile,
      allowNoteSelectionStatePersistence: deviceInterface.environment !== Environment.Mobile,
      u2fAuthenticatorRegistrationPromptFunction: startRegistration as unknown as (
        registrationOptions: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>,
      u2fAuthenticatorVerificationPromptFunction: startAuthentication as unknown as (
        authenticationOptions: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>,
    })

    makeObservable(this, {
      dealloced: observable,

      preferencesController: computed,

      isSessionsModalVisible: observable,

      openSessionsModal: action,
      closeSessionsModal: action,
    })

    this.createBackgroundServices()
  }

  private createBackgroundServices(): void {
    // Standard Red Notes: register the proof-of-work solver so a
    // `proof-of-work-required` challenge during register / sign-in is solved in a
    // Web Worker (off the UI thread). No-op unless the server has PoW enabled
    // (opt-in; disabled by default), since the challenge is never issued.
    this._proofOfWorkSolver = new WebProofOfWorkSolver()
    this.sessions.setProofOfWorkSolver(this._proofOfWorkSolver)

    this.installWebSocketSyncTransport()

    void this.mobileWebReceiver
    void this.autolockService
    void this.persistence
    if (this.environment !== Environment.Clipper) {
      void this.themeManager
    }
    void this.momentsService
    void this.routeService
    // Standard Red Notes: eagerly create the recent-notes tracker so it begins
    // observing note opens immediately.
    void this.recentNotesState
    // Standard Red Notes: eagerly create the auto-empty-trash service so it
    // subscribes to sync events from app start.
    void this.autoEmptyTrashService
    // Standard Red Notes: eagerly create the update-check scheduler so the
    // launch-time auto check observes ApplicationEvent.Launched.
    void this.updateCheckService
    // Standard Red Notes: eagerly create the push-MFA approvals notifier so it
    // observes MFA_APPROVAL_REQUESTED websocket frames from app start.
    void this.pendingMfaApprovalsNotifier

    if (isDev) {
      this.devMode = new DevMode(this)
    }

    if (!this.isNativeMobileWeb()) {
      this.webOrDesktopDevice.setApplication(this)
      this.wireCrossTabCoordination()
    }

    const appEventObserver = this.deps.get<ApplicationEventObserver>(Web_TYPES.ApplicationEventObserver)
    this.disposers.push(this.addEventObserver(appEventObserver.handle.bind(appEventObserver)))

    if (this.isNativeMobileWeb()) {
      this.disposers.push(
        this.addEventObserver(async (event) => {
          this.mobileDevice.notifyApplicationEvent(event)
        }),
      )

      // eslint-disable-next-line no-console
      console.log = (...args) => {
        this.mobileDevice.consoleLog(...args)
      }
    }

    if (!isDesktopApplication()) {
      this.visibilityObserver = new VisibilityObserver((event) => {
        this.notifyWebEvent(event)
      })
    }

    this.wireManualSyncMode()

    this.installDecryptionPool()

    this.wireSearchIndexRunner()
  }

  /**
   * Standard Red Notes: bring the background search-index runner to life once local
   * storage is available.
   *
   * The runner's constructor auto-starts the scheduler when the user left indexing
   * enabled (see SearchIndexRunner) — but only if the runner is actually created.
   * Unlike the other background services (recent-notes, auto-empty-trash, etc.) it
   * cannot be instantiated eagerly in createBackgroundServices(): its settings live
   * in app storage, which throws "before loading local storage" until LocalDataLoaded.
   * So we defer creation to that event. Without this, the runner was only ever created
   * when the Search & Indexing preferences pane was first opened, so "auto-start on
   * launch" never happened for users who never visited that pane.
   *
   * Merely touching the (idempotent, caching) getter constructs and self-starts it.
   */
  private wireSearchIndexRunner(): void {
    this.disposers.push(
      this.addEventObserver(async () => {
        void this.searchIndexRunner
      }, ApplicationEvent.LocalDataLoaded),
    )
  }

  /**
   * Standard Red Notes: BOOTSTRAP WIRING for cross-tab coordination.
   *
   * Two coordinators cooperate:
   *  - The KEYCHAIN coordinator (owned by WebDevice, global namespace) already installed
   *    its window 'storage' listener via getKeychainValue/setKeychainValue. We re-read its
   *    lock here to veto IndexedDB writes the instant another tab clears/rotates the key.
   *  - A per-workspace SAVE coordinator (created here, namespaced by this.identifier) that
   *    broadcasts the uuids we save and, on a peer's save, reloads just those database rows.
   *
   * We then forward both into the per-identifier Database as DatabaseCrossTabHooks. Only
   * runs on a real WebDevice (desktop/mobile use a different device with no keychain
   * coordinator); the whole thing degrades to a no-op if BroadcastChannel is unavailable
   * (the keychain storage-event safety net still works).
   */
  private wireCrossTabCoordination(): void {
    const device = this.device
    if (!(device instanceof WebDevice)) {
      return
    }

    const keychainCoordinator = device.getCrossTabCoordinator()

    this._saveCrossTabCoordinator = new CrossTabCoordinator({
      namespace: this.identifier,
      callbacks: {
        onForeignSave: (uuids) => reloadForeignDatabasePayloads(uuids, this.storage, this.payloads),
      },
    })

    device.setDatabaseCrossTabHooks(this.identifier, {
      emitSaved: (uuids: string[]) => this._saveCrossTabCoordinator?.emitPayloadsSaved(uuids),
      isWriteBlocked: () => keychainCoordinator.isLocked(),
    })
  }

  /**
   * Standard Red Notes: install the parallel decryption worker pool onto the
   * ItemsEncryptionService. The pool no-ops (isAvailable === false) when Workers
   * are unavailable, in which case the service keeps using its synchronous path,
   * so this is always safe. Failures here must never block app boot.
   *
   * The PrefKey.MaxDecryptionWorkers ceiling (0 == auto) is applied here. Because
   * the pool spawns workers LAZILY, constructing it before preferences load is
   * fine: it starts with a couple workers, and we re-apply the persisted pref once
   * LocalDataLoaded / PreferencesChanged fires (setMaxWorkers only raises/lowers
   * the lazy-growth ceiling — it never eagerly spins workers).
   */
  private installDecryptionPool(): void {
    if (typeof Worker === 'undefined') {
      return
    }
    try {
      const pool = new DecryptionPool({ maxWorkers: this.getMaxDecryptionWorkersPref() })
      if (!pool.isAvailable) {
        pool.destroy()
        return
      }
      this._decryptionPool = pool
      this.itemsEncryption.setDecryptionPool(pool)

      // Re-apply the persisted ceiling once preferences are available (the
      // constructor ran before LocalDataLoaded), and whenever it changes.
      const applyMax = () => {
        this._decryptionPool?.setMaxWorkers(this.getMaxDecryptionWorkersPref())
      }
      this.disposers.push(this.addEventObserver(async () => applyMax(), ApplicationEvent.LocalDataLoaded))
      this.disposers.push(this.addEventObserver(async () => applyMax(), ApplicationEvent.PreferencesChanged))
    } catch (error) {
      // Pool construction is best-effort; on any failure we leave the service on
      // its sync path. Never let this crash app launch.
      console.error('Failed to install decryption pool', error)
    }
  }

  /**
   * The configured decryption-worker ceiling. Returns undefined before preferences
   * load (DecryptionPool treats undefined the same as 0 == auto).
   */
  private getMaxDecryptionWorkersPref(): number | undefined {
    try {
      return this.getPreference(PrefKey.MaxDecryptionWorkers, PrefDefaults[PrefKey.MaxDecryptionWorkers])
    } catch {
      return undefined
    }
  }

  /**
   * Standard Red Notes: bridge the web-local "Manual sync" toggle into the snjs SyncService.
   *
   * The flag is stored web-locally (localStorage, see ManualSyncSetting). We push the current
   * value into SyncService as soon as the local database is loaded (the SyncService is ready
   * by then), and re-apply whenever the toggle changes (same-tab or cross-tab). When ON, the
   * sync engine suppresses automatic syncs; the user must trigger "Sync now" explicitly.
   */
  private wireManualSyncMode(): void {
    const apply = () => {
      try {
        this.sync.setManualSyncMode(getManualSyncModeEnabled())
      } catch {
        // SyncService not ready yet / app torn down; safe to ignore — it is re-applied on launch.
      }
    }

    this.disposers.push(
      this.addEventObserver(async () => {
        apply()
      }, ApplicationEvent.LocalDataLoaded),
    )

    this.disposers.push(subscribeManualSyncMode(apply))
  }

  /**
   * Install websocket-preferred account sync for capable browsers. Capability
   * and one-use ticket requests stay on the authenticated main-thread client;
   * no long-lived session token is ever posted to the worker.
   */
  private installWebSocketSyncTransport(): void {
    const deviceId = getOrCreateSyncDeviceId(this.identifier)
    const transport = new WebSocketSyncTransport({
      deviceId,
      getConfiguredWebSocketUrl: () => this.sockets.getConfiguredWebSocketUrl(),
      getAuthenticatedSessionScope: () => this.getOpaqueAuthenticatedSyncSessionScope(),
      controlPlane: {
        getCapabilities: async () => {
          const response = await this.serverGetJsonRequest<{ capabilities?: SyncCapability[] }>(
            '/v1/sockets/sync/capabilities',
          )
          return response.ok && Array.isArray(response.data.capabilities)
            ? { capabilities: response.data.capabilities }
            : undefined
        },
        createTicket: async (requestedDeviceId) => {
          const response = await this.serverJsonRequest<SyncTicketResponse>('/v1/sockets/sync/ticket', {
            deviceId: requestedDeviceId,
          })
          return response.ok ? response.data : undefined
        },
      },
    })
    this._webSocketSyncTransport = transport
    this.sync.setAccountSyncTransport(transport)
    this.disposers.push(
      this.sockets.setCollaborationAuthorizationTransport((noteUuid, leaseRequestId, bootstrapChallenge) =>
        transport.authorizeCollaborationRoom(noteUuid, leaseRequestId, bootstrapChallenge),
      ),
    )
    this.disposers.push(this.sockets.onSyncTransportSessionRevoked(() => transport.notifySessionRevoked()))
  }

  /**
   * Scope durable worker state to one authenticated session epoch. Modern
   * session tokens keep their UUID in the second colon-delimited segment while
   * rotating the secret segment, so access-token refresh preserves this scope.
   * The returned digest never exposes the user, session UUID, host, or token.
   */
  private async getOpaqueAuthenticatedSyncSessionScope(): Promise<string | undefined> {
    const user = this.sessions.getUser()
    const session = (this.sessions as unknown as { getSession?: () => unknown }).getSession?.()
    const accessToken = extractAccessToken(session)
    if (!user?.uuid || !accessToken || !globalThis.crypto?.subtle) {
      return undefined
    }
    let host: string
    try {
      host = new URL(this.getHost.execute().getValue()).origin
    } catch {
      host = this.getHost.execute().getValue()
    }
    return deriveOpaqueSyncSessionScope({
      applicationIdentifier: this.identifier,
      host,
      userUuid: user.uuid,
      accessToken,
    })
  }

  override deinit(mode: DeinitMode, source: DeinitSource): void {
    if (!this.isNativeMobileWeb()) {
      this.webOrDesktopDevice.removeApplication(this)
    }

    super.deinit(mode, source)

    for (const disposer of this.disposers) {
      disposer()
    }
    this.disposers.length = 0

    // Standard Red Notes: tear down the recent-notes observer.
    this._recentNotesState?.deinit()
    this._recentNotesState = undefined

    // Standard Red Notes: tear down the background search-index runner.
    this._searchIndexRunner?.deinit()
    this._searchIndexRunner = undefined

    // Standard Red Notes: tear down the auto-empty-trash service.
    this._autoEmptyTrashService?.deinit()
    this._autoEmptyTrashService = undefined

    // Standard Red Notes: tear down the update-check scheduler (clears its timer).
    this._updateCheckService?.deinit()
    this._updateCheckService = undefined

    // Standard Red Notes: tear down the push-MFA approvals notifier (removes the
    // socket observer and clears the fallback-poll timer).
    this._pendingMfaApprovalsNotifier?.deinit()
    this._pendingMfaApprovalsNotifier = undefined

    // Standard Red Notes: terminate the decryption worker pool.
    this._decryptionPool?.destroy()
    this._decryptionPool = undefined

    // Standard Red Notes: terminate the proof-of-work solver worker.
    this._proofOfWorkSolver?.destroy()
    this._proofOfWorkSolver = undefined

    this._webSocketSyncTransport?.deinit()
    this._webSocketSyncTransport = undefined

    // Standard Red Notes: close the per-workspace save coordination channel. (The keychain
    // coordinator is closed by WebDevice.deinit via removeApplication above.)
    this._saveCrossTabCoordinator?.deinit()
    this._saveCrossTabCoordinator = undefined

    this.deps.deinit()

    try {
      this.webEventObservers.length = 0

      if (this.visibilityObserver) {
        this.visibilityObserver.deinit()
        ;(this.visibilityObserver as unknown) = undefined
      }
    } catch (error) {
      console.error('Error while deiniting application', error)
    }
  }

  public addWebEventObserver(observer: WebEventObserver): () => void {
    this.webEventObservers.push(observer)

    return () => {
      removeFromArray(this.webEventObservers, observer)
    }
  }

  public notifyWebEvent(event: WebAppEvent, data?: unknown): void {
    for (const observer of this.webEventObservers) {
      observer(event, data)
    }

    this.events.publish({ type: event, payload: data })
  }

  publishPanelDidResizeEvent(name: string, width: number, collapsed: boolean) {
    const data: PanelResizedData = {
      panel: name,
      collapsed,
      width,
    }

    this.notifyWebEvent(WebAppEvent.PanelResized, data)
  }

  public get desktopDevice(): DesktopDeviceInterface | undefined {
    if (isDesktopDevice(this.device)) {
      return this.device
    }

    return undefined
  }

  public getInternalFeatureService(): InternalFeatureServiceInterface {
    return InternalFeatureService.get()
  }

  isNativeIOS(): boolean {
    return this.deps.get<IsNativeIOS>(Web_TYPES.IsNativeIOS).execute().getValue()
  }

  get isMobileDevice(): boolean {
    return this.deps.get<IsMobileDevice>(Web_TYPES.IsMobileDevice).execute().getValue()
  }

  get hideOutboundSubscriptionLinks() {
    return this.isNativeIOS()
  }

  get mobileDevice(): MobileDeviceInterface {
    return this.device as MobileDeviceInterface
  }

  get webOrDesktopDevice(): WebOrDesktopDevice {
    return this.device as WebOrDesktopDevice
  }

  async checkForSecurityUpdate(): Promise<boolean> {
    return this.protocolUpgradeAvailable()
  }

  performDesktopTextBackup(): void | Promise<void> {
    return this.desktopManager?.saveDesktopBackup()
  }

  isGlobalSpellcheckEnabled(): boolean {
    return this.deps.get<IsGlobalSpellcheckEnabled>(Web_TYPES.IsGlobalSpellcheckEnabled).execute().getValue()
  }

  public getItemTags(item: DecryptedItemInterface) {
    return this.items.itemsReferencingItem<SNTag>(item).filter((ref) => {
      return ref.content_type === ContentType.TYPES.Tag
    })
  }

  public get version(): string {
    return (this.device as WebOrDesktopDevice).appVersion
  }

  async toggleGlobalSpellcheck() {
    const currentValue = this.isGlobalSpellcheckEnabled()
    return this.setPreference(PrefKey.EditorSpellcheck, !currentValue)
  }

  async handleMobileEnteringBackgroundEvent(): Promise<void> {
    await this.lockApplicationAfterMobileEventIfApplicable()
  }

  async handleMobileGainingFocusEvent(): Promise<void> {
    /** Optional override */
  }

  handleInitialMobileScreenshotPrivacy(): void {
    if (this.platform !== Platform.Android) {
      return
    }

    if (this.protections.getMobileScreenshotPrivacyEnabled()) {
      this.mobileDevice.setAndroidScreenshotPrivacy(true)
    } else {
      this.mobileDevice.setAndroidScreenshotPrivacy(false)
    }
  }

  async handleMobileLosingFocusEvent(): Promise<void> {
    if (this.protections.getMobileScreenshotPrivacyEnabled()) {
      this.mobileDevice.stopHidingMobileInterfaceFromScreenshots()
    }

    await this.lockApplicationAfterMobileEventIfApplicable()
  }

  async handleMobileResumingFromBackgroundEvent(): Promise<void> {
    if (this.protections.getMobileScreenshotPrivacyEnabled()) {
      this.mobileDevice.hideMobileInterfaceFromScreenshots()
    }
  }

  handleMobileColorSchemeChangeEvent() {
    void this.themeManager.handleMobileColorSchemeChangeEvent()
  }

  openSessionsModal = () => {
    this.isSessionsModalVisible = true
  }

  closeSessionsModal = () => {
    this.isSessionsModalVisible = false
  }

  handleMobileKeyboardWillChangeFrameEvent(frame: {
    height: number
    contentHeight: number
    isFloatingKeyboard: boolean
  }): void {
    if (frame.contentHeight > 0) {
      setCustomViewportHeight(frame.contentHeight, 'px', true)
    }
    if (frame.isFloatingKeyboard) {
      setCustomViewportHeight(100, 'vh', true)
    }
    this.notifyWebEvent(WebAppEvent.MobileKeyboardWillChangeFrame, frame)
  }

  handleMobileKeyboardDidHideEvent(): void {
    setCustomViewportHeight(100, 'vh', true)
  }

  handleOpenFilePreviewEvent({ id }: { id: string }): void {
    const file = this.items.findItem<FileItem>(id)
    if (!file) {
      return
    }
    this.filesController
      .handleFileAction({
        type: FileItemActionType.PreviewFile,
        payload: {
          file,
        },
      })
      .catch(console.error)
  }

  handleReceivedFileEvent(file: { name: string; mimeType: string; data: string }): void {
    const filesController = this.filesController
    const blob = getBlobFromBase64(file.data, file.mimeType)
    const mappedFile = new File([blob], file.name, { type: file.mimeType })
    filesController.uploadNewFile(mappedFile).catch(console.error)
  }

  async handleReceivedTextEvent({ text, title }: { text: string; title?: string | undefined }) {
    const titleForNote = title || this.itemListController.titleForNewNote()

    const note = this.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
      title: titleForNote,
      text: text,
      references: [],
    })

    const insertedNote = await this.mutator.insertItem(note)

    this.itemListController.selectItem(insertedNote.uuid, true).catch(console.error)

    addToast({
      type: ToastType.Success,
      message: 'Successfully created note from shared text',
    })
  }

  async handleReceivedLinkEvent({ link, title }: { link: string; title: string | undefined }) {
    const url = new URL(link)
    const paths = url.pathname.split('/')
    const finalPath = paths[paths.length - 1]
    const isImagePath = !!finalPath && /\.(png|svg|webp|jpe?g)/.test(finalPath)

    if (isImagePath) {
      const fetchToastUuid = addToast({
        type: ToastType.Loading,
        message: 'Fetching image from link...',
      })
      try {
        const imgResponse = await fetch(link)
        if (!imgResponse.ok) {
          throw new Error(`${imgResponse.status}: Could not fetch image`)
        }
        const imgBlob = await imgResponse.blob()
        const file = new File([imgBlob], finalPath, {
          type: imgBlob.type,
        })
        this.filesController.uploadNewFile(file).catch(console.error)
      } catch (error) {
        console.error(error)
      } finally {
        dismissToast(fetchToastUuid)
      }
      return
    }

    this.handleReceivedTextEvent({
      title: title,
      text: link,
    }).catch(console.error)
  }

  private async lockApplicationAfterMobileEventIfApplicable(): Promise<void> {
    const isLocked = await this.protections.isLocked()
    if (isLocked) {
      return
    }

    const hasBiometrics = this.protections.hasBiometricsEnabled()
    const hasPasscode = this.hasPasscode()
    const passcodeTiming = this.protections.getMobilePasscodeTiming()
    const biometricsTiming = this.protections.getMobileBiometricsTiming()

    const passcodeLockImmediately = hasPasscode && passcodeTiming === MobileUnlockTiming.Immediately
    const biometricsLockImmediately = hasBiometrics && biometricsTiming === MobileUnlockTiming.Immediately

    if (passcodeLockImmediately) {
      await this.lock()
    } else if (biometricsLockImmediately) {
      this.protections.softLockBiometrics()
    }
  }

  handleAndroidBackButtonPressed(): void {
    if (typeof this.androidBackHandler !== 'undefined') {
      this.androidBackHandler.notifyEvent()
    }
  }

  addAndroidBackHandlerEventListener(listener: () => boolean) {
    if (typeof this.androidBackHandler !== 'undefined') {
      return this.androidBackHandler.addEventListener(listener)
    }
    return
  }

  setAndroidBackHandlerFallbackListener(listener: () => boolean) {
    if (typeof this.androidBackHandler !== 'undefined') {
      this.androidBackHandler.setFallbackListener(listener)
    }
  }

  isAuthorizedToRenderItem(item: DecryptedItem): boolean {
    const authoritativeItem = this.items.isTemplateItem(item) ? item : this.items.findItem<DecryptedItem>(item.uuid)
    if (!authoritativeItem) {
      return false
    }

    if (authoritativeItem.key_system_identifier !== undefined) {
      const vault = this.vaults.getItemVault(authoritativeItem)
      if (!vault || this.vaultLocks.isVaultLocked(vault)) {
        // A retained item whose vault listing/key is gone must never fall back
        // to ordinary-item rendering while removal/lock lifecycle cleanup runs.
        return false
      }
    }

    if (authoritativeItem.protected && this.hasProtectionSources()) {
      return this.protections.hasUnprotectedAccessSession()
    }

    return true
  }

  entitledToPerTagPreferences(): boolean {
    return this.hasValidFirstPartySubscription()
  }

  get entitledToFiles(): boolean {
    return this.featuresController.entitledToFiles
  }

  showPremiumModal(featureName?: FeatureName): void {
    void this.featuresController.showPremiumAlert(featureName)
  }

  hasValidFirstPartySubscription(): boolean {
    return this.subscriptionController.hasFirstPartyOnlineOrOfflineSubscription()
  }

  async openPurchaseFlow() {
    await this.purchaseFlowController.openPurchaseFlow()
  }

  addNativeMobileEventListener = (listener: NativeMobileEventListener) => {
    if (!this.mobileWebReceiver) {
      return
    }

    return this.mobileWebReceiver.addReactListener(listener)
  }

  showAccountMenu(): void {
    this.accountMenuController.setShow(true)
  }

  hideAccountMenu(): void {
    this.accountMenuController.setShow(false)
  }

  /**
   * Full U2F clients are only web browser clients. They support adding and removing keys as well as authentication.
   * The desktop and mobile clients cannot support adding keys.
   */
  get isFullU2FClient(): boolean {
    return this.environment === Environment.Web
  }

  openPreferences(pane?: PreferencePaneId): void {
    this.preferencesController.openPreferences()
    if (pane) {
      this.preferencesController.setCurrentPane(pane)
    }
  }

  generateUUID(): string {
    return this.options.crypto.generateUUID()
  }

  /**
   * Dependency
   * Accessors
   */

  get routeService(): RouteServiceInterface {
    return this.deps.get<RouteServiceInterface>(Web_TYPES.RouteService)
  }

  get androidBackHandler(): AndroidBackHandler {
    return this.deps.get<AndroidBackHandler>(Web_TYPES.AndroidBackHandler)
  }

  get vaultDisplayService(): VaultDisplayServiceInterface {
    return this.deps.get<VaultDisplayServiceInterface>(Web_TYPES.VaultDisplayService)
  }

  get desktopManager(): DesktopManagerInterface | undefined {
    return this.deps.get<DesktopManagerInterface | undefined>(Web_TYPES.DesktopManager)
  }

  get autolockService(): AutolockService | undefined {
    return this.deps.get<AutolockService | undefined>(Web_TYPES.AutolockService)
  }

  get archiveService(): ArchiveManager {
    return this.deps.get<ArchiveManager>(Web_TYPES.ArchiveManager)
  }

  get paneController(): PaneController {
    return this.deps.get<PaneController>(Web_TYPES.PaneController)
  }

  get linkingController(): LinkingController {
    return this.deps.get<LinkingController>(Web_TYPES.LinkingController)
  }

  get changelogService(): ChangelogService {
    return this.deps.get<ChangelogService>(Web_TYPES.ChangelogService)
  }

  get pluginsService(): PluginsServiceInterface {
    return this.deps.get<PluginsServiceInterface>(Web_TYPES.PluginsService)
  }

  get momentsService(): MomentsService {
    return this.deps.get<MomentsService>(Web_TYPES.MomentsService)
  }

  get themeManager(): ThemeManager {
    return this.deps.get<ThemeManager>(Web_TYPES.ThemeManager)
  }

  get keyboardService(): KeyboardService {
    return this.deps.get<KeyboardService>(Web_TYPES.KeyboardService)
  }

  get commands(): CommandService {
    return this.deps.get<CommandService>(Web_TYPES.CommandService)
  }

  get featuresController(): FeaturesController {
    return this.deps.get<FeaturesController>(Web_TYPES.FeaturesController)
  }

  get filesController(): FilesController {
    return this.deps.get<FilesController>(Web_TYPES.FilesController)
  }

  get filePreviewModalController(): FilePreviewModalController {
    return this.deps.get<FilePreviewModalController>(Web_TYPES.FilePreviewModalController)
  }

  get notesController(): NotesController {
    return this.deps.get<NotesController>(Web_TYPES.NotesController)
  }

  get importModalController(): ImportModalController {
    return this.deps.get<ImportModalController>(Web_TYPES.ImportModalController)
  }

  get exportModalController(): ExportModalController {
    return this.deps.get<ExportModalController>(Web_TYPES.ExportModalController)
  }

  get navigationController(): NavigationController {
    return this.deps.get<NavigationController>(Web_TYPES.NavigationController)
  }

  get historyModalController(): HistoryModalController {
    return this.deps.get<HistoryModalController>(Web_TYPES.HistoryModalController)
  }

  get syncStatusController(): SyncStatusController {
    return this.deps.get<SyncStatusController>(Web_TYPES.SyncStatusController)
  }

  get itemListController(): ItemListController {
    return this.deps.get<ItemListController>(Web_TYPES.ItemListController)
  }

  get importer(): Importer {
    return this.deps.get<Importer>(Web_TYPES.Importer)
  }

  get subscriptionController(): SubscriptionController {
    return this.deps.get<SubscriptionController>(Web_TYPES.SubscriptionController)
  }

  get purchaseFlowController(): PurchaseFlowController {
    return this.deps.get<PurchaseFlowController>(Web_TYPES.PurchaseFlowController)
  }

  get persistence(): PersistenceService {
    return this.deps.get<PersistenceService>(Web_TYPES.PersistenceService)
  }

  get itemControllerGroup(): ItemGroupController {
    return this.deps.get<ItemGroupController>(Web_TYPES.ItemGroupController)
  }

  get noAccountWarningController(): NoAccountWarningController {
    return this.deps.get<NoAccountWarningController>(Web_TYPES.NoAccountWarningController)
  }

  get notificationsController(): NotificationsController {
    return this.deps.get<NotificationsController>(Web_TYPES.NotificationsController)
  }

  get searchOptionsController(): SearchOptionsController {
    return this.deps.get<SearchOptionsController>(Web_TYPES.SearchOptionsController)
  }

  get openSubscriptionDashboard(): OpenSubscriptionDashboard {
    return this.deps.get<OpenSubscriptionDashboard>(Web_TYPES.OpenSubscriptionDashboard)
  }

  get mobileWebReceiver(): MobileWebReceiver | undefined {
    return this.deps.get<MobileWebReceiver | undefined>(Web_TYPES.MobileWebReceiver)
  }

  get accountMenuController(): AccountMenuController {
    return this.deps.get<AccountMenuController>(Web_TYPES.AccountMenuController)
  }

  get preferencesController(): PreferencesController {
    return this.deps.get<PreferencesController>(Web_TYPES.PreferencesController)
  }

  // Standard Red Notes: the recently-opened-notes tracker backing the Recent Notes
  // preferences pane. Lazily instantiated and cached.
  get recentNotesState(): RecentNotesState {
    if (!this._recentNotesState) {
      this._recentNotesState = new RecentNotesState(this)
    }
    return this._recentNotesState
  }

  // Standard Red Notes: the background search-index runner backing the Search
  // Index preferences pane. Lazily instantiated and cached.
  get searchIndexRunner(): SearchIndexRunner {
    if (!this._searchIndexRunner) {
      this._searchIndexRunner = new SearchIndexRunner(this)
    }
    return this._searchIndexRunner
  }

  // Standard Red Notes: the auto-empty-trash maintenance service. Lazily
  // instantiated and cached.
  get autoEmptyTrashService(): AutoEmptyTrashService {
    if (!this._autoEmptyTrashService) {
      this._autoEmptyTrashService = new AutoEmptyTrashService(this)
    }
    return this._autoEmptyTrashService
  }

  // Standard Red Notes: the self-hosted "Check for updates" scheduler + client.
  // Lazily instantiated and cached.
  get updateCheckService(): UpdateCheckService {
    if (!this._updateCheckService) {
      this._updateCheckService = new UpdateCheckService(this)
    }
    return this._updateCheckService
  }

  // Standard Red Notes: the push-MFA approvals app-wide notifier. Lazily
  // instantiated and cached.
  get pendingMfaApprovalsNotifier(): PendingMfaApprovalsNotifier {
    if (!this._pendingMfaApprovalsNotifier) {
      this._pendingMfaApprovalsNotifier = new PendingMfaApprovalsNotifier(this)
    }
    return this._pendingMfaApprovalsNotifier
  }

  get isNativeMobileWebUseCase(): IsNativeMobileWeb {
    return this.deps.get<IsNativeMobileWeb>(Web_TYPES.IsNativeMobileWeb)
  }

  /**
   * Performs an authenticated streaming POST to the server-side Assistant LLM
   * proxy and returns the raw Response so the caller can read the SSE body.
   * The provider credential never reaches the browser. The official proxy
   * client sends prompts/tools while the server resolves provider/model from the
   * authenticated user's assigned/default profile.
   */
  public async assistantStreamRequest(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const idempotencyKey = createAssistantAttemptId()
    const transport = this._webSocketSyncTransport
    if (transport) {
      try {
        const response = await transport.openAuthenticatedRpcStream({
          method: 'POST',
          path,
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
          },
          body,
          idempotencyKey,
          deadlineMs: 120_000,
          initialCreditBytes: 128 * 1024,
          stream: true,
          signal,
        })
        return new Response(assistantRpcResponseBody(response.stream, response.body), {
          status: response.status,
          headers: response.headers,
        })
      } catch (error) {
        // HTTP is a compatibility path only when the worker facade proves no
        // request bytes crossed the authenticated socket. Ambiguous/post-send
        // failures retain their idempotency identity and surface to the caller;
        // replaying them here could double bill or run tools twice.
        if (!(error instanceof AuthenticatedRpcError) || !error.safeToFallback) {
          throw error
        }
      }
    }

    const host = this.getHost.execute().getValue()
    const session = (this.sessions as unknown as { getSession?: () => unknown }).getSession?.()
    const accessToken = extractAccessToken(session)

    const url = `${host.replace(/\/$/, '')}${path}`

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Idempotency-Key': idempotencyKey,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })
  }

  /**
   * Authenticated GET helper for the server-side OCR config endpoint
   * (/v1/ocr/config). Returns whether server OCR is available FOR THIS USER
   * (operator env master switch AND the admin-managed per-user allow flag) plus
   * the server's default language. The client uses this to decide whether to
   * offer the "Run OCR on server" action alongside the default browser OCR.
   */
  public async ocrConfigRequest<T>(path: string): Promise<T> {
    return this.assistantConfigRequest<T>(path)
  }

  /**
   * Authenticated JSON POST to the server-side OCR endpoint (/v1/ocr/recognize).
   *
   * PRIVACY: this uploads DECRYPTED PDF page images to the server, which LEAVES
   * end-to-end encryption for that request — the server (and anyone controlling
   * it) can read that content, exactly like the AI proxy. Only ever called after
   * the user explicitly chooses "Run OCR on server" with the warning shown. The
   * default browser OCR path never sends anything off the device.
   */
  public async ocrRecognizeRequest<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; data: T }> {
    return this.serverJsonRequest<T>(path, body, signal)
  }

  /** Authenticated GET helper for the Assistant config endpoint. */
  public async assistantConfigRequest<T>(path: string): Promise<T> {
    const host = this.getHost.execute().getValue()
    const session = (this.sessions as unknown as { getSession?: () => unknown }).getSession?.()
    const accessToken = extractAccessToken(session)
    const url = `${host.replace(/\/$/, '')}${path}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    })

    if (!response.ok) {
      throw new Error(await assistantHttpError(response, 'proxy'))
    }

    return (await response.json()) as T
  }

  /**
   * Authenticated JSON POST helper for server-mediated integrations (e.g. the
   * optional "Publish note to GitHub" feature). Sends the access token as a
   * Bearer header, like {@link assistantStreamRequest}, and returns the parsed
   * JSON response plus the HTTP status so callers can map errors.
   *
   * NOTE: the caller is responsible for the privacy disclosure — this can carry
   * decrypted note content and a GitHub PAT to the server.
   */
  public async serverJsonRequest<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const host = this.getHost.execute().getValue()
    const session = (this.sessions as unknown as { getSession?: () => unknown }).getSession?.()
    const accessToken = extractAccessToken(session)
    const url = `${host.replace(/\/$/, '')}${path}`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    })

    let data: T
    try {
      data = (await response.json()) as T
    } catch {
      data = {} as T
    }

    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Authenticated JSON mutation helper for the small set of server control-plane
   * endpoints whose REST contract requires PUT or DELETE. Keeping the method
   * allow-list here prevents a caller-controlled verb while preserving the same
   * authentication and non-JSON-response handling as {@link serverJsonRequest}.
   */
  public async serverJsonRequestWithMethod<T>(
    path: string,
    method: 'PUT' | 'DELETE',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const host = this.getHost.execute().getValue()
    const session = (this.sessions as unknown as { getSession?: () => unknown }).getSession?.()
    const accessToken = extractAccessToken(session)
    const url = `${host.replace(/\/$/, '')}${path}`
    const hasBody = body !== undefined

    const response = await fetch(url, {
      method,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      signal,
    })

    let data: T
    try {
      data = (await response.json()) as T
    } catch {
      data = {} as T
    }

    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Authenticated JSON GET variant of {@link serverJsonRequest}. Unlike
   * {@link assistantConfigRequest} it returns the HTTP status alongside the
   * parsed body, so callers can distinguish "endpoint absent" (404 — e.g. a
   * server that has not deployed the feature yet) from an actual payload and
   * degrade gracefully instead of throwing on a non-JSON error page.
   */
  public async serverGetJsonRequest<T>(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; data: T }> {
    const host = this.getHost.execute().getValue()
    const session = (this.sessions as unknown as { getSession?: () => unknown }).getSession?.()
    const accessToken = extractAccessToken(session)
    const url = `${host.replace(/\/$/, '')}${path}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      signal,
    })

    let data: T
    try {
      data = (await response.json()) as T
    } catch {
      data = {} as T
    }

    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Read the server-held ChatGPT/Codex subscription pairing status
   * (admin-gated on the server, GET /v1/assistant/subscription/status).
   *
   * The paired OAuth tokens are held server-side and are NEVER returned by the
   * server — this carries only non-secret metadata (paired flag, account label,
   * expiry, whether the env-token fallback is in use, whether re-pairing is
   * needed). Returns `paired: false` on any error so the UI degrades gracefully.
   */
  public async assistantSubscriptionStatus(subscriptionId = 'default'): Promise<AssistantSubscriptionStatus> {
    try {
      const result = await this.assistantConfigRequest<AssistantSubscriptionStatus>(
        `/v1/assistant/subscription/status?subscriptionId=${encodeURIComponent(subscriptionId)}`,
      )
      if (result.subscriptionId !== subscriptionId) {
        return {
          paired: false,
          subscriptionId,
          reason: 'The server returned pairing status for a different subscription id.',
        }
      }
      return result
    } catch {
      return { paired: false, subscriptionId, reason: 'Could not load pairing status from the server.' }
    }
  }

  /**
   * Begin a ChatGPT/Codex subscription pairing (admin-gated,
   * POST /v1/assistant/subscription/start). The server generates the PKCE
   * verifier/challenge/state server-side and returns only the browser
   * `authorizeUrl` (containing the challenge + state) plus the opaque `state`.
   * The PKCE verifier never leaves the server.
   */
  public async assistantSubscriptionStart(subscriptionId = 'default'): Promise<{
    status: number
    ok: boolean
    data: AssistantSubscriptionStart
  }> {
    return this.serverJsonRequest<AssistantSubscriptionStart>('/v1/assistant/subscription/start', { subscriptionId })
  }

  /**
   * Remove exactly one server-held subscription pairing (admin-gated,
   * POST /v1/assistant/subscription/unpair). The id is always explicit; this
   * helper can never clear every pairing accidentally.
   */
  public async assistantSubscriptionUnpair(
    subscriptionId = 'default',
    confirmReferencedProfiles = false,
    legacySubscriptionIdConfirmation?: string,
  ): Promise<{
    status: number
    ok: boolean
    data: { ok?: boolean }
  }> {
    return this.serverJsonRequest<{ ok?: boolean }>('/v1/assistant/subscription/unpair', {
      subscriptionId,
      confirmReferencedProfiles,
      ...(legacySubscriptionIdConfirmation ? { legacySubscriptionIdConfirmation } : {}),
    })
  }

  /**
   * Read the SRN-side metered token usage attributable to subscription-backed
   * (Codex/ChatGPT) proxy calls (admin-gated,
   * GET /v1/assistant/subscription/usage). This is NOT OpenAI's official
   * subscription quota — no such queryable endpoint exists — but the tokens SRN
   * has metered locally, over the same 5h + weekly rolling windows. Returns the
   * HTTP status so the card can distinguish an older server (404) from a payload.
   */
  public async assistantSubscriptionUsage(): Promise<{
    status: number
    ok: boolean
    data: AssistantSubscriptionUsage
  }> {
    return this.serverGetJsonRequest<AssistantSubscriptionUsage>('/v1/assistant/subscription/usage')
  }
}

/**
 * Non-secret status for the ChatGPT/Codex subscription pairing. Mirrors the
 * frozen /v1/assistant/subscription/status contract — it NEVER carries a token.
 */
export type AssistantSubscriptionStatus = {
  paired: boolean
  subscriptionId?: string
  legacyInvalidId?: boolean
  storeUnreadable?: boolean
  mode?: string
  accountId?: string
  accountLabel?: string
  expiresAt?: number | string
  usingEnvFallback?: boolean
  needsRepair?: boolean
  needsRepairReason?: 'refresh-token-missing' | 'refresh-token-rejected'
  refreshRetryAt?: number
  refreshFailureCode?: 'network' | 'rate-limited' | 'provider-unavailable' | 'provider-error'
  referencedByProfiles?: { id: string; name: string }[]
  profileReferencesKnown?: boolean
  reason?: string
}

/** Response of POST /v1/assistant/subscription/start. */
export type AssistantSubscriptionStart = {
  authorizeUrl?: string
  state?: string
  subscriptionId?: string
}

/** One rolling window of SRN-metered subscription token usage. */
export type AssistantSubscriptionUsageWindow = {
  usedTokens: number
  limitTokens: number
  resetsAt: string
  unavailable?: boolean
}

/**
 * SRN-side (NOT official OpenAI) metered token usage for subscription-backed
 * calls. Response of GET /v1/assistant/subscription/usage.
 */
export type AssistantSubscriptionUsage = {
  source?: string
  subscriptionMode?: boolean
  tokens?: {
    fiveHour: AssistantSubscriptionUsageWindow
    weekly: AssistantSubscriptionUsageWindow
  }
}

function extractAccessToken(session: unknown): string | undefined {
  if (!session || typeof session !== 'object') {
    return undefined
  }
  const accessToken = (session as { accessToken?: unknown }).accessToken
  if (typeof accessToken === 'string') {
    return accessToken
  }
  if (
    accessToken &&
    typeof accessToken === 'object' &&
    typeof (accessToken as { value?: unknown }).value === 'string'
  ) {
    return (accessToken as { value: string }).value
  }
  return undefined
}

let assistantAttemptCounter = 0

function createAssistantAttemptId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `assistant-${globalThis.crypto.randomUUID()}`
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto?.getRandomValues?.(bytes)
  assistantAttemptCounter += 1
  return `assistant-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}-${assistantAttemptCounter}`
}

function assistantRpcResponseBody(stream: ReadableStream<Uint8Array> | undefined, body: unknown): BodyInit | null {
  if (stream) {
    return stream
  }
  if (body === undefined || body === null) {
    return null
  }
  return typeof body === 'string' ? body : JSON.stringify(body)
}

const SYNC_DEVICE_ID_STORAGE_KEY = 'standardnotes.sync-device-id.v1'
const SYNC_DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

function getOrCreateSyncDeviceId(applicationIdentifier: string): string {
  try {
    const stored = globalThis.localStorage?.getItem(SYNC_DEVICE_ID_STORAGE_KEY)
    if (stored && SYNC_DEVICE_ID_PATTERN.test(stored)) {
      return stored
    }
  } catch {
    // A deterministic per-workspace fallback below still coordinates tabs.
  }

  let hash = 0x811c9dc5
  for (let index = 0; index < applicationIdentifier.length; index++) {
    hash ^= applicationIdentifier.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const deviceId = `web-${(hash >>> 0).toString(16).padStart(8, '0')}`
  try {
    globalThis.localStorage?.setItem(SYNC_DEVICE_ID_STORAGE_KEY, deviceId)
  } catch {
    // Private/locked storage: the deterministic id remains stable across tabs.
  }
  return deviceId
}
