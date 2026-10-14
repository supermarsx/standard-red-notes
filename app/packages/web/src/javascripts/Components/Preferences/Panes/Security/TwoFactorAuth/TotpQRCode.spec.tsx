/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MfaServiceInterface } from '@standardnotes/snjs'
import { TwoFactorActivation } from './TwoFactorActivation'
import SaveSecretKey from './SaveSecretKey'
import ScanQRCode from './ScanQRCode'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('local authenticator QR enrollment', () => {
  const secret = 'JBSWY3DPEHPK3PXP'
  let mfa: MfaServiceInterface
  let activation: TwoFactorActivation
  let enabled: jest.Mock
  beforeEach(() => {
    mfa = { enableMfa: jest.fn().mockResolvedValue(undefined) } as unknown as MfaServiceInterface
    enabled = jest.fn()
    activation = new TwoFactorActivation(mfa, 'a+b /雪@example.test', secret, jest.fn(), enabled)
  })
  it('initializes the actual observable activation and uses canonical issuer/account URI encoding', () => {
    expect(activation.activationStep).toBe('scan-qr-code')
    const uri = new URL(activation.qrCode)
    expect(uri.protocol).toBe('otpauth:')
    expect(uri.hostname).toBe('totp')
    expect(decodeURIComponent(uri.pathname.slice(1))).toBe('Standard Red Notes:a+b /雪@example.test')
    expect(uri.searchParams.get('issuer')).toBe('Standard Red Notes')
    expect(uri.searchParams.get('secret')).toBe(secret)
    expect(uri.searchParams.get('algorithm')).toBe('SHA1')
    expect(uri.searchParams.get('digits')).toBe('6')
    expect(uri.searchParams.get('period')).toBe('30')
  })
  it.each([['scan', ScanQRCode], ['save-secret', SaveSecretKey]])('shows a locally generated QR, copyable key and native app link in the %s view', async (_name, Component) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(Component, { activation })))
      const qr = container.querySelector('svg[aria-label="Authenticator setup QR code"]')
      expect(qr).not.toBeNull()
      expect(qr?.querySelector('path')).not.toBeNull()
      const link = container.querySelector('a')
      expect(link?.getAttribute('href')).toBe(activation.qrCode)
      expect(link?.textContent).toBe('Open in authenticator app')
      expect(container.querySelector('input')?.value).toBe(secret)
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('button[title="Copy to clipboard"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
  it('keeps secret confirmation and current authenticator-code verification before enabling', async () => {
    activation.openSaveSecretKey()
    activation.openVerification()
    activation.setInputSecretKey('wrong-secret')
    activation.setInputOtpToken('123456')
    activation.enable2FA()
    expect(activation.verificationStatus).toBe('invalid-secret')
    expect(mfa.enableMfa).not.toHaveBeenCalled()
    activation.setInputSecretKey(secret)
    activation.enable2FA()
    await Promise.resolve()
    expect(mfa.enableMfa).toHaveBeenCalledWith(secret, '123456')
    expect(activation.activationStep).toBe('success')
    expect(enabled).not.toHaveBeenCalled()
    activation.finishActivation()
    expect(enabled).toHaveBeenCalledTimes(1)
  })
})
