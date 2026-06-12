import { Uuid } from '@standardnotes/domain-core'
import { AnyFeatureDescription, NativeFeatureIdentifier, FindNativeFeature } from '@standardnotes/features'
import { DecryptedItemInterface } from '@standardnotes/models'
import { Subscription } from '@standardnotes/responses'
import { FeatureStatus, ItemManagerInterface } from '@standardnotes/services'

export class GetFeatureStatusUseCase {
  constructor(private items: ItemManagerInterface) {}

  execute(dto: {
    featureId: NativeFeatureIdentifier | Uuid
    firstPartyOnlineSubscription: Subscription | undefined
    firstPartyRoles: { online: string[] } | { offline: string[] } | undefined
    hasPaidAnyPartyOnlineOrOfflineSubscription: boolean
    inContextOfItem?: DecryptedItemInterface
  }): FeatureStatus {
    const nativeFeature = this.findNativeFeature(dto.featureId)

    // Standard Red Notes: all native features are unconditionally entitled.
    // Only third-party components retain not-installed / expired handling.
    if (!nativeFeature) {
      return this.getThirdPartyFeatureStatus(dto.featureId)
    }

    return FeatureStatus.Entitled
  }

  findNativeFeature(featureId: NativeFeatureIdentifier | Uuid): AnyFeatureDescription | undefined {
    return FindNativeFeature(featureId.value)
  }

  private getThirdPartyFeatureStatus(uuid: Uuid): FeatureStatus {
    const component = this.items.getDisplayableComponents().find((candidate) => candidate.uuid === uuid.value)

    if (!component) {
      return FeatureStatus.NoUserSubscription
    }

    if (component.isExpired) {
      return FeatureStatus.InCurrentPlanButExpired
    }

    return FeatureStatus.Entitled
  }
}
