import { SessionManager } from './SessionManager'

/**
 * Standard Red Notes: INVITE-URL signup control — client threading. The optional
 * invite token captured from `?invite=<token>` must reach userApiService.register
 * ONLY when supplied (so an ordinary signup is byte-identical to before), and a
 * pending-approval register response (no session) must return WITHOUT attempting
 * to authenticate.
 */
describe('SessionManager invite-URL signup control', () => {
  let userApiService: { register: jest.Mock }
  let apiService: { setInvalidSessionObserver: jest.Mock }
  let encryptionService: { createRootKey: jest.Mock }
  let challengeService: { getWrappingKeyIfApplicable: jest.Mock }
  let handleAuthentication: jest.SpyInstance

  const successResponse = {
    status: 200,
    data: { session: { access_token: 't' }, user: { uuid: 'u', email: 'user@example.com' } },
  }

  const pendingApprovalResponse = {
    status: 200,
    data: { success: true, pendingApproval: true },
  }

  const emailConfirmationRequiredResponse = {
    status: 200,
    data: { success: true, emailConfirmationRequired: true },
  }

  const createSessionManager = (): SessionManager => {
    handleAuthentication = jest
      .spyOn(
        SessionManager.prototype as unknown as { handleAuthentication: () => Promise<void> },
        'handleAuthentication',
      )
      .mockResolvedValue(undefined)

    return new SessionManager(
      {} as never,
      apiService as never,
      userApiService as never,
      {} as never,
      encryptionService as never,
      {} as never,
      challengeService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      '',
      {} as never,
      {} as never,
      {} as never,
    )
  }

  beforeEach(() => {
    userApiService = { register: jest.fn() }
    apiService = { setInvalidSessionObserver: jest.fn() }
    encryptionService = {
      createRootKey: jest.fn().mockResolvedValue({ serverPassword: 'server-password', keyParams: { foo: 'bar' } }),
    }
    challengeService = {
      getWrappingKeyIfApplicable: jest.fn().mockResolvedValue({ wrappingKey: undefined, canceled: false }),
    }
  })

  it('does NOT pass an invite token when the trailing param is omitted (byte-identical to before)', async () => {
    userApiService.register.mockResolvedValueOnce(successResponse)

    const manager = createSessionManager()
    await manager.register('user@example.com', 'a-strong-password', '', false)

    expect(userApiService.register.mock.calls[0][0]).toMatchObject({ inviteToken: undefined })
  })

  it('threads the invite token into userApiService.register when supplied', async () => {
    userApiService.register.mockResolvedValueOnce(successResponse)

    const manager = createSessionManager()
    await manager.register('user@example.com', 'a-strong-password', '', false, 'my-workspace', 'raw-invite-token')

    expect(userApiService.register.mock.calls[0][0]).toMatchObject({
      workspaceIdentifier: 'my-workspace',
      inviteToken: 'raw-invite-token',
    })
  })

  it('returns a pending-approval response WITHOUT authenticating (no session to handle)', async () => {
    userApiService.register.mockResolvedValueOnce(pendingApprovalResponse)

    const manager = createSessionManager()
    const result = await manager.register('user@example.com', 'a-strong-password', '', false, undefined, 'tok')

    expect(result).toEqual(pendingApprovalResponse.data)
    expect(handleAuthentication).not.toHaveBeenCalled()
  })

  it('returns an email-confirmation response WITHOUT authenticating (no session to handle)', async () => {
    userApiService.register.mockResolvedValueOnce(emailConfirmationRequiredResponse)

    const manager = createSessionManager()
    const result = await manager.register('user@example.com', 'a-strong-password', '', false)

    expect(result).toEqual(emailConfirmationRequiredResponse.data)
    expect(handleAuthentication).not.toHaveBeenCalled()
  })

  it('still authenticates a normal (non-pending) registration', async () => {
    userApiService.register.mockResolvedValueOnce(successResponse)

    const manager = createSessionManager()
    const result = await manager.register('user@example.com', 'a-strong-password', '', false)

    expect(result).toEqual(successResponse.data)
    expect(handleAuthentication).toHaveBeenCalledTimes(1)
  })
})
