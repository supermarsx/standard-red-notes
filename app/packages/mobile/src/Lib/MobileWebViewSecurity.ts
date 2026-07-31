import type { MobileDeviceInterface } from '@standardnotes/snjs'

/**
 * Only methods used by the bundled web application are exposed over the
 * React-Native bridge. In particular, raw keychain access and native
 * filesystem helpers must remain native-only implementation details.
 */
export const MobileDeviceBridgeMethods = [
  'deinit',
  'getRawStorageValue',
  'getJsonParsedRawStorageValue',
  'setRawStorageValue',
  'removeRawStorageValue',
  'removeRawStorageValuesForIdentifier',
  'openDatabase',
  'getDatabaseLoadChunks',
  'clearAllDataFromDevice',
  'getAllDatabaseEntries',
  'getDatabaseEntries',
  'saveDatabaseEntries',
  'removeDatabaseEntry',
  'removeAllDatabaseEntries',
  'getNamespacedKeychainValue',
  'setNamespacedKeychainValue',
  'clearNamespacedKeychainValue',
  'openUrl',
  'performSoftReset',
  'performHardReset',
  'getDeviceBiometricsAvailability',
  'setAndroidScreenshotPrivacy',
  'authenticateWithBiometrics',
  'hideMobileInterfaceFromScreenshots',
  'stopHidingMobileInterfaceFromScreenshots',
  'consoleLog',
  'handleThemeSchemeChange',
  'shareBase64AsFile',
  'downloadBase64AsFile',
  'getNativeThemeCSS',
  'previewFile',
  'exitApp',
  'registerComponentUrl',
  'deregisterComponentUrl',
  'getAppState',
  'getColorScheme',
  'purchaseSubscriptionIAP',
  'authenticateWithU2F',
  'notifyApplicationEvent',
  'canDisplayNotifications',
  'displayNotification',
  'cancelNotification',
] as const satisfies readonly (keyof MobileDeviceInterface)[]

export type MobileDeviceBridgeMethod = (typeof MobileDeviceBridgeMethods)[number]

const MobileDeviceBridgeMethodSet: ReadonlySet<string> = new Set(MobileDeviceBridgeMethods)

export type MobileBridgeRequest = {
  functionName: MobileDeviceBridgeMethod
  messageId: string | number
  args: unknown[]
}

export type MobileNavigationRequest = {
  url: string
  isTopFrame?: boolean
}

export type MobileNavigationDecision = 'allow' | 'open-external' | 'block'

export function isMobileDeviceBridgeMethod(value: unknown): value is MobileDeviceBridgeMethod {
  return typeof value === 'string' && MobileDeviceBridgeMethodSet.has(value)
}

export function parseMobileBridgeRequest(value: unknown): MobileBridgeRequest | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const request = value as Record<string, unknown>
  if (
    !isMobileDeviceBridgeMethod(request.functionName) ||
    (typeof request.messageId !== 'string' && typeof request.messageId !== 'number') ||
    !Array.isArray(request.args)
  ) {
    return undefined
  }

  return {
    functionName: request.functionName,
    messageId: request.messageId,
    args: request.args,
  }
}

export function createMobileDeviceBridgeMethodSource(): string {
  return MobileDeviceBridgeMethods.map((functionName) => {
    if (functionName === 'consoleLog') {
      return `
    consoleLog(...args) {
      return this.askReactNativeToInvokeInterfaceMethod("consoleLog", [args.length]);
    }
    `
    }

    return `
    ${functionName}(...args) {
      return this.askReactNativeToInvokeInterfaceMethod(${JSON.stringify(functionName)}, args);
    }
    `
  }).join('')
}

function normalizedDocumentUrl(url: string): string {
  const withoutQueryOrFragment = url.split(/[?#]/, 1)[0].replace(/\\/g, '/')

  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return `file://${parsed.hostname.toLowerCase()}${decodeURIComponent(parsed.pathname).replace(/\\/g, '/')}`
    }
  } catch {
    // A relative configured URI is compared below without URL parsing.
  }

  return withoutQueryOrFragment
}

/**
 * iOS resolves the configured relative bundle URI to an app-specific absolute
 * file URL, while Android uses a stable android_asset URL. Both accepted forms
 * are supplied by native code; a same-suffix file elsewhere is not trusted.
 */
export function isTrustedMobileAppDocumentUrl(
  url: string,
  configuredSourceUri: string,
  resolvedTrustedDocumentUri = configuredSourceUri,
): boolean {
  const candidate = normalizedDocumentUrl(url)
  return (
    candidate === normalizedDocumentUrl(configuredSourceUri) ||
    candidate === normalizedDocumentUrl(resolvedTrustedDocumentUri)
  )
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return !['file:', 'javascript:', 'data:', 'blob:', 'about:'].includes(protocol)
  } catch {
    return false
  }
}

/**
 * Remote and registered component documents remain valid iframe content, but
 * they can never replace the trusted top-level app document.
 */
export function decideMobileNavigation(
  request: MobileNavigationRequest,
  configuredSourceUri: string,
  resolvedTrustedDocumentUri = configuredSourceUri,
): MobileNavigationDecision {
  if (request.isTopFrame === false) {
    return 'allow'
  }

  if (isTrustedMobileAppDocumentUrl(request.url, configuredSourceUri, resolvedTrustedDocumentUri)) {
    return 'allow'
  }

  return isSafeExternalUrl(request.url) ? 'open-external' : 'block'
}

export function trustedMobileAppDocumentGuardSource(resolvedTrustedDocumentUri: string): string {
  const trustedUrl = new URL(resolvedTrustedDocumentUri)
  if (trustedUrl.protocol !== 'file:') {
    throw new Error('Trusted mobile app document must use the file protocol')
  }

  const trustedPath = decodeURIComponent(trustedUrl.pathname).replace(/\\/g, '/')
  return `window.location.protocol === 'file:' && window.location.hostname.toLowerCase() === ${JSON.stringify(
    trustedUrl.hostname.toLowerCase(),
  )} && decodeURIComponent(window.location.pathname).replace(/\\\\/g, '/') === ${JSON.stringify(trustedPath)}`
}
