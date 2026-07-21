import { KeyParamsOrigination } from './KeyParamsOrigination'

describe('KeyParamsOrigination', () => {
  it('should serialize each origination to its kebab-case wire value', () => {
    expect(KeyParamsOrigination.Registration).toEqual('registration')
    expect(KeyParamsOrigination.EmailChange).toEqual('email-change')
    expect(KeyParamsOrigination.PasswordChange).toEqual('password-change')
    expect(KeyParamsOrigination.ProtocolUpgrade).toEqual('protocol-upgrade')
    expect(KeyParamsOrigination.PasscodeCreate).toEqual('passcode-create')
    expect(KeyParamsOrigination.PasscodeChange).toEqual('passcode-change')
  })

  it('should expose exactly the six originations that may produce key params', () => {
    expect(Object.values(KeyParamsOrigination).sort()).toEqual([
      'email-change',
      'passcode-change',
      'passcode-create',
      'password-change',
      'protocol-upgrade',
      'registration',
    ])
  })
})
