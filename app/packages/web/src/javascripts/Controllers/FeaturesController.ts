import { FeaturesClientInterface, InternalEventHandlerInterface } from '@standardnotes/services'
import { FeatureName } from './FeatureName'
import { destroyAllObjectProperties } from '@/Utils'
import {
  NativeFeatureIdentifier,
  FeatureStatus,
  InternalEventBusInterface,
  InternalEventInterface,
  RoleName,
} from '@standardnotes/snjs'
import { makeObservable, observable } from 'mobx'
import { AbstractViewController } from './Abstract/AbstractViewController'
import { CrossControllerEvent } from './CrossControllerEvent'
import { featureTrunkVaultsEnabled } from '@/FeatureTrunk'

// Standard Red Notes: the admin role name. Must match the server's
// RoleName.NAMES.AdminUser value ('ADMIN_USER'). We do NOT go through the
// published @standardnotes/domain-core enum (RoleName.NAMES.AdminUser /
// RoleName.create('ADMIN_USER')) because the published package predates the
// fork's INTERNAL_TEAM_USER→ADMIN_USER rename: it lacks the admin enum member
// and its create() would reject 'ADMIN_USER'. hasRole() only reads .value, so a
// minimal RoleName-shaped object is durable against the real published package.
const ADMIN_ROLE_NAME = 'ADMIN_USER'
const adminRoleName = { value: ADMIN_ROLE_NAME } as unknown as RoleName

export class FeaturesController extends AbstractViewController implements InternalEventHandlerInterface {
  // Standard Red Notes: single-tier free fork. Every feature is entitled.
  hasFolders = true
  hasSmartViews = true
  entitledToFiles = true

  override deinit() {
    super.deinit()
    ;(this.showPremiumAlert as unknown) = undefined
    ;(this.hasFolders as unknown) = undefined
    ;(this.hasSmartViews as unknown) = undefined
    ;(this.entitledToFiles as unknown) = undefined

    destroyAllObjectProperties(this)
  }

  constructor(
    private features: FeaturesClientInterface,
    eventBus: InternalEventBusInterface,
  ) {
    super(eventBus)

    makeObservable(this, {
      hasFolders: observable,
      hasSmartViews: observable,
      entitledToFiles: observable,
    })

    eventBus.addEventHandler(this, CrossControllerEvent.DisplayPremiumModal)

    this.showPremiumAlert = this.showPremiumAlert.bind(this)
  }

  async handleEvent(_event: InternalEventInterface): Promise<void> {
    // Standard Red Notes: every feature is entitled and there is no premium
    // modal, so there is nothing to handle here.
  }

  public async showPremiumAlert(_featureName?: FeatureName | string): Promise<void> {
    // Standard Red Notes: every feature is entitled, so the premium upgrade
    // prompt ("Enable Advanced Features") is permanently suppressed.
    return Promise.resolve()
  }

  showSuperDemoModal = () => {
    // Standard Red Notes: no Super demo modal; the editor is always available.
  }

  // Standard Red Notes: true when the current user has the ADMIN_USER
  // role. Used to gate the in-app Admin preferences pane on the client. The
  // server re-enforces this role on every admin endpoint, so this is purely a
  // UX gate.
  isAdminUser(): boolean {
    return this.features.hasRole(adminRoleName)
  }

  isVaultsEnabled(): boolean {
    const enabled = this.features.isExperimentalFeatureEnabled(NativeFeatureIdentifier.TYPES.Vaults)
    return enabled || this.isEntitledToSharedVaults() || this.features.hasRole(adminRoleName)
  }

  isEntitledToSharedVaults(): boolean {
    const status = this.features.getFeatureStatus(
      NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SharedVaults).getValue(),
    )
    const isEntitledToFeature = status === FeatureStatus.Entitled

    return featureTrunkVaultsEnabled() || isEntitledToFeature
  }
}
