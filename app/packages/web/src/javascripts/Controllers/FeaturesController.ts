import { FeaturesClientInterface, InternalEventHandlerInterface } from '@standardnotes/services'
import { FeatureName } from './FeatureName'
import { destroyAllObjectProperties } from '@/Utils'
import {
  ApplicationEvent,
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

  isVaultsEnabled(): boolean {
    const enabled = this.features.isExperimentalFeatureEnabled(NativeFeatureIdentifier.TYPES.Vaults)
    return (
      featureTrunkVaultsEnabled() ||
      enabled ||
      this.features.hasRole(RoleName.create(RoleName.NAMES.InternalTeamUser).getValue())
    )
  }

  isEntitledToSharedVaults(): boolean {
    const status = this.features.getFeatureStatus(
      NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SharedVaults).getValue(),
    )
    const isEntitledToFeature = status === FeatureStatus.Entitled

    return featureTrunkVaultsEnabled() || isEntitledToFeature
  }
}
