import { AppleIAPProductId, AppleIAPReceipt } from '@standardnotes/snjs'

/**
 * IAP subscriptions are not used in this self-hosted "included features" fork. The
 * react-native-iap v15 API is incompatible with the prior integration, so this class is
 * neutralized to a no-op while preserving the getInstance()/purchase()/deinit() signatures
 * that MobileDevice.purchaseSubscriptionIAP bridges to.
 */
export class PurchaseManager {
  private static instance: PurchaseManager

  private constructor() {}

  public static getInstance(): PurchaseManager {
    if (!PurchaseManager.instance) {
      PurchaseManager.instance = new PurchaseManager()
    }

    return PurchaseManager.instance
  }

  deinit() {}

  async purchase(_sku: AppleIAPProductId): Promise<AppleIAPReceipt | undefined> {
    return Promise.resolve(undefined)
  }
}
