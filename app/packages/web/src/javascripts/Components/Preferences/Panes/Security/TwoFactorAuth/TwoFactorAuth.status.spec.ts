import { MfaServiceInterface, SessionsClientInterface } from '@standardnotes/snjs'
import { TwoFactorAuth, is2FAActivation } from './TwoFactorAuth'

describe('fresh account two-factor presence', () => {
  it('shows an absent server secret as disabled, then opens real setup rather than a disable challenge', async () => {
    const mfa = {
      isMfaActivated: jest.fn().mockResolvedValue(false),
      generateMfaSecret: jest.fn().mockResolvedValue('JBSWY3DPEHPK3PXP'),
      disableMfa: jest.fn(),
    } as unknown as MfaServiceInterface
    const model = new TwoFactorAuth({ getUser: () => ({ email: 'local@example.test' }) } as SessionsClientInterface, mfa)
    model.fetchStatus()
    await Promise.resolve()
    expect(model.status).toBe('two-factor-disabled')
    model.toggle2FA()
    await Promise.resolve()
    expect(is2FAActivation(model.status as never)).toBe(true)
    expect(mfa.generateMfaSecret).toHaveBeenCalledTimes(1)
    expect(mfa.disableMfa).not.toHaveBeenCalled()
  })
})
