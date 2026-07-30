import { SessionManager } from './SessionManager'

describe('SessionManager credential rotation reconciliation', () => {
  let apiService: {
    setInvalidSessionObserver: jest.Mock
    createErrorResponse: jest.Mock
  }

  const createSessionManager = () =>
    new SessionManager(
      {} as never,
      apiService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      'workspace-id',
      {} as never,
      {} as never,
      {} as never,
    )

  beforeEach(() => {
    apiService = {
      setInvalidSessionObserver: jest.fn(),
      createErrorResponse: jest.fn((message: string) => ({
        status: 400,
        data: { error: { message } },
      })),
    }
  })

  it('completes login-params/PKCE preparation before submitting the candidate root', async () => {
    const manager = createSessionManager()
    const keyParams = { compare: jest.fn().mockReturnValue(true) }
    const rootKey = { keyParams }
    const wrappingKey = { uuid: 'wrapping-key' }
    const success = { status: 200, data: { session: {} } }
    const internals = manager as unknown as {
      retrieveKeyParams: jest.Mock
      bypassChecksAndSignInWithRootKey: jest.Mock
    }
    internals.retrieveKeyParams = jest.fn().mockResolvedValue({
      keyParams,
      response: { status: 200, data: {} },
    })
    internals.bypassChecksAndSignInWithRootKey = jest.fn().mockResolvedValue(success)

    const response = await manager.reconcileCredentialRotationSignIn(
      'new@example.com',
      rootKey as never,
      wrappingKey as never,
    )

    expect(internals.retrieveKeyParams).toHaveBeenCalledWith({
      email: 'new@example.com',
      workspaceIdentifier: 'workspace-id',
    })
    expect(keyParams.compare).toHaveBeenCalledWith(keyParams)
    expect(internals.retrieveKeyParams.mock.invocationCallOrder[0]).toBeLessThan(
      internals.bypassChecksAndSignInWithRootKey.mock.invocationCallOrder[0],
    )
    expect(internals.bypassChecksAndSignInWithRootKey).toHaveBeenCalledWith(
      'new@example.com',
      rootKey,
      false,
      undefined,
      'workspace-id',
      wrappingKey,
    )
    expect(response).toBe(success)
  })

  it('rejects a candidate whose key params do not match the authoritative server params', async () => {
    const manager = createSessionManager()
    const serverKeyParams = { compare: jest.fn().mockReturnValue(false) }
    const rootKey = { keyParams: { identifier: 'new@example.com' } }
    const internals = manager as unknown as {
      retrieveKeyParams: jest.Mock
      bypassChecksAndSignInWithRootKey: jest.Mock
    }
    internals.retrieveKeyParams = jest.fn().mockResolvedValue({
      keyParams: serverKeyParams,
      response: { status: 200, data: {} },
    })
    internals.bypassChecksAndSignInWithRootKey = jest.fn()

    const response = await manager.reconcileCredentialRotationSignIn('new@example.com', rootKey as never)

    expect(serverKeyParams.compare).toHaveBeenCalledWith(rootKey.keyParams)
    expect(internals.bypassChecksAndSignInWithRootKey).not.toHaveBeenCalled()
    expect(apiService.createErrorResponse).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(400)
  })

  it('uses the recovered account workspace explicitly instead of ambient session state', async () => {
    const manager = createSessionManager()
    const keyParams = { compare: jest.fn().mockReturnValue(true) }
    const rootKey = { keyParams }
    const internals = manager as unknown as {
      retrieveKeyParams: jest.Mock
      bypassChecksAndSignInWithRootKey: jest.Mock
    }
    internals.retrieveKeyParams = jest.fn().mockResolvedValue({
      keyParams,
      response: { status: 200, data: {} },
    })
    internals.bypassChecksAndSignInWithRootKey = jest.fn().mockResolvedValue({ status: 200, data: {} })

    await manager.reconcileCredentialRotationSignIn('person@example.com', rootKey as never, undefined, 'recovered-team')

    expect(internals.retrieveKeyParams).toHaveBeenCalledWith({
      email: 'person@example.com',
      workspaceIdentifier: 'recovered-team',
    })
    expect(internals.bypassChecksAndSignInWithRootKey).toHaveBeenCalledWith(
      'person@example.com',
      rootKey,
      false,
      undefined,
      'recovered-team',
      undefined,
    )
  })
})
