import { ErrorTag } from '@standardnotes/responses'
import { ProofOfWorkSolverInterface } from '@standardnotes/services'

import { SessionManager } from './SessionManager'

/**
 * Standard Red Notes: focused coverage of the client proof-of-work solve-and-attach
 * loop. The server issues an anti-bot challenge inside a `proof-of-work-required`
 * error; the client must solve it off the UI thread and resubmit with the seed +
 * nonce attached. When the server does NOT issue a challenge (the default — PoW is
 * opt-in), none of this runs and the request goes through untouched.
 */
describe('SessionManager proof-of-work', () => {
  let userApiService: { register: jest.Mock }
  let apiService: {
    setInvalidSessionObserver: jest.Mock
    getAccountKeyParams: jest.Mock
    createErrorResponse: jest.Mock
  }
  let encryptionService: { createRootKey: jest.Mock }
  let challengeService: { getWrappingKeyIfApplicable: jest.Mock }
  let solver: ProofOfWorkSolverInterface & { solve: jest.Mock }

  const successResponse = {
    status: 200,
    data: { session: { access_token: 't' }, user: { uuid: 'u', email: 'user@example.com' } },
  }

  const powChallengeResponse = {
    status: 400,
    data: {
      error: {
        tag: ErrorTag.ProofOfWorkRequired,
        message: 'Please complete the verification challenge and try again.',
        payload: { pow: { seed: 'server-seed', difficulty: 6, algorithm: 'sha256-leading-zero-bits' } },
      },
    },
  }

  const createSessionManager = (): SessionManager => {
    // handleAuthentication does heavy storage/key work that is irrelevant to the PoW
    // loop, so stub it out on the prototype.
    jest
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
    apiService = {
      setInvalidSessionObserver: jest.fn(),
      getAccountKeyParams: jest.fn(),
      createErrorResponse: jest.fn((message: string) => ({ status: 400, data: { error: { message } } })),
    }
    encryptionService = {
      createRootKey: jest.fn().mockResolvedValue({ serverPassword: 'server-password', keyParams: { foo: 'bar' } }),
    }
    challengeService = {
      getWrappingKeyIfApplicable: jest.fn().mockResolvedValue({ wrappingKey: undefined, canceled: false }),
    }
    solver = { solve: jest.fn().mockResolvedValue('solved-nonce') }
  })

  it('registers without any solve when the server issues no challenge (disabled-skip path)', async () => {
    userApiService.register.mockResolvedValueOnce(successResponse)

    const manager = createSessionManager()
    manager.setProofOfWorkSolver(solver)

    const result = await manager.register('user@example.com', 'a-strong-password', '', false)

    expect(result).toEqual(successResponse.data)
    expect(solver.solve).not.toHaveBeenCalled()
    expect(userApiService.register).toHaveBeenCalledTimes(1)
    // First (and only) call carries no proof fields.
    expect(userApiService.register.mock.calls[0][0]).toMatchObject({ powSeed: undefined, powNonce: undefined })
  })

  it('solves the challenge off-thread and resubmits with the seed + nonce attached', async () => {
    userApiService.register.mockResolvedValueOnce(powChallengeResponse).mockResolvedValueOnce(successResponse)

    const manager = createSessionManager()
    manager.setProofOfWorkSolver(solver)

    const result = await manager.register('user@example.com', 'a-strong-password', '', false)

    expect(result).toEqual(successResponse.data)
    expect(solver.solve).toHaveBeenCalledWith('server-seed', 6, 'sha256-leading-zero-bits')
    expect(userApiService.register).toHaveBeenCalledTimes(2)
    // The resubmit echoes the server's seed and the solved nonce.
    expect(userApiService.register.mock.calls[1][0]).toMatchObject({
      powSeed: 'server-seed',
      powNonce: 'solved-nonce',
    })
  })

  it('gives up after a bounded number of solves and surfaces the challenge error', async () => {
    userApiService.register.mockResolvedValue(powChallengeResponse)

    const manager = createSessionManager()
    manager.setProofOfWorkSolver(solver)

    await expect(manager.register('user@example.com', 'a-strong-password', '', false)).rejects.toThrow()
    // Initial attempt + MAX_PROOF_OF_WORK_ATTEMPTS (2) resubmits = 3 register calls.
    expect(userApiService.register).toHaveBeenCalledTimes(3)
    expect(solver.solve).toHaveBeenCalledTimes(2)
  })

  it('surfaces the challenge error unchanged when no solver is registered', async () => {
    userApiService.register.mockResolvedValueOnce(powChallengeResponse)

    const manager = createSessionManager()
    // No setProofOfWorkSolver: platform has not wired one up.

    await expect(manager.register('user@example.com', 'a-strong-password', '', false)).rejects.toThrow()
    expect(userApiService.register).toHaveBeenCalledTimes(1)
  })
})
