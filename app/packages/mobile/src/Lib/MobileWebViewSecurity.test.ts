/// <reference types="jest" />

import {
  createMobileDeviceBridgeMethodSource,
  decideMobileNavigation,
  isMobileDeviceBridgeMethod,
  isTrustedMobileAppDocumentUrl,
  parseMobileBridgeRequest,
  trustedMobileAppDocumentGuardSource,
} from './MobileWebViewSecurity'

const androidSource = 'file:///android_asset/Web.bundle/src/index.html'
const iosConfiguredSource = 'Web.bundle/src/index.html'
const iosResolvedSource = 'file:///private/app/StandardNotes.app/Web.bundle/src/index.html'

describe('MobileWebViewSecurity', () => {
  it('trusts only the configured bundled top document', () => {
    expect(isTrustedMobileAppDocumentUrl(`${androidSource}#notes`, androidSource)).toBe(true)
    expect(isTrustedMobileAppDocumentUrl(iosResolvedSource, iosConfiguredSource, iosResolvedSource)).toBe(true)

    expect(
      isTrustedMobileAppDocumentUrl(
        'file:///tmp/attacker/Web.bundle/src/index.html',
        iosConfiguredSource,
        iosResolvedSource,
      ),
    ).toBe(false)
    expect(
      isTrustedMobileAppDocumentUrl(
        'file://attacker/private/app/StandardNotes.app/Web.bundle/src/index.html',
        iosConfiguredSource,
        iosResolvedSource,
      ),
    ).toBe(false)
    expect(
      isTrustedMobileAppDocumentUrl(
        'https://component.example/Web.bundle/src/index.html',
        iosConfiguredSource,
        iosResolvedSource,
      ),
    ).toBe(false)
  })

  it('allows remote components only as subframes and never as the top document', () => {
    expect(decideMobileNavigation({ url: androidSource, isTopFrame: true }, androidSource)).toBe('allow')
    expect(
      decideMobileNavigation(
        { url: 'https://component.example/editor', isTopFrame: false },
        iosConfiguredSource,
        iosResolvedSource,
      ),
    ).toBe('allow')
    expect(
      decideMobileNavigation(
        { url: 'https://component.example/editor', isTopFrame: true },
        iosConfiguredSource,
        iosResolvedSource,
      ),
    ).toBe('open-external')
    expect(
      decideMobileNavigation({ url: 'javascript:alert(1)', isTopFrame: true }, iosConfiguredSource, iosResolvedSource),
    ).toBe('block')
    expect(
      decideMobileNavigation(
        { url: 'standardnotes://auth/callback?token=test', isTopFrame: true },
        iosConfiguredSource,
        iosResolvedSource,
      ),
    ).toBe('open-external')
  })

  it('rejects forged and native-only bridge methods', () => {
    expect(isMobileDeviceBridgeMethod('getDatabaseEntries')).toBe(true)
    expect(isMobileDeviceBridgeMethod('getRawKeychainValue')).toBe(false)
    expect(isMobileDeviceBridgeMethod('deleteFileAtPathIfExists')).toBe(false)
    expect(isMobileDeviceBridgeMethod('getFileDestinationPath')).toBe(false)
    expect(isMobileDeviceBridgeMethod('constructor')).toBe(false)

    expect(
      parseMobileBridgeRequest({
        functionName: 'getRawKeychainValue',
        messageId: 1,
        args: [],
      }),
    ).toBeUndefined()
    expect(
      parseMobileBridgeRequest({
        functionName: 'getDatabaseEntries',
        messageId: 1,
        args: ['workspace', []],
      }),
    ).toEqual({
      functionName: 'getDatabaseEntries',
      messageId: 1,
      args: ['workspace', []],
    })
  })

  it('generates wrappers and a document guard from explicit trusted inputs', () => {
    const bridgeSource = createMobileDeviceBridgeMethodSource()
    expect(bridgeSource).toContain('getDatabaseEntries(...args)')
    expect(bridgeSource).not.toContain('getRawKeychainValue')
    expect(bridgeSource).not.toContain('deleteFileAtPathIfExists')

    const guardSource = trustedMobileAppDocumentGuardSource(iosResolvedSource)
    expect(guardSource).toContain('/private/app/StandardNotes.app/Web.bundle/src/index.html')
    expect(guardSource).toContain('window.location.hostname.toLowerCase() === ""')
    expect(guardSource).not.toContain('endsWith')
  })
})
