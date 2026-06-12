import { Uuid } from '@standardnotes/domain-core'
import { AnyFeatureDescription, NativeFeatureIdentifier, FindNativeFeature } from '@standardnotes/features'
import { DecryptedItemInterface } from '@standardnotes/models'
import { Subscription } from '@standardnotes/responses'
import { FeatureStatus, ItemManagerInterface } from '@standardnotes/services'

export class GetFeatureStatusUseCase {
  // Standard Red Notes: the ItemManager is no longer needed to determine
  // entitlement (everything is Entitled), but the constructor signature is
  // preserved so existing callers/tests keep compiling.
  constructor(_items: ItemManagerInterface) {}

  execute(_dto: {
    featureId: NativeFeatureIdentifier | Uuid
    firstPartyOnlineSubscription: Subscription | undefined
    firstPartyRoles: { online: string[] } | { offline: string[] } | undefined
    hasPaidAnyPartyOnlineOrOfflineSubscription: boolean
    inContextOfItem?: DecryptedItemInterface
  }): FeatureStatus {
    // Standard Red Notes: this is a single-tier free fork. Every feature -
    // native AND third-party - is unconditionally entitled.
    return FeatureStatus.Entitled
  }

  findNativeFeature(featureId: NativeFeatureIdentifier | Uuid): AnyFeatureDescription | undefined {
    return FindNativeFeature(featureId.value)
  }
}
