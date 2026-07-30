import { ErrorTag } from '@standardnotes/responses'

import { SessionManager } from './SessionManager'

describe('SessionManager magic-link delivery', () => {
  let apiService: {
    setInvalidSessionObserver: jest.Mock
    getAccountKeyParams: jest.Mock
    createErrorResponse: jest.Mock
  }
  let alertService: { alert: jest.Mock }
  let challengeService: { promptForChallengeResponse: jest.Mock }
  let httpService: { post: jest.Mock }

  const magicLinkRequiredResponse = {
    status: 400,
    data: {
      error: {
        tag: ErrorTag.MfaRequired,
        message: 'Please enter the verification code sent to your email.',
      },
    },
  }

  const createSessionManager = () =>
    new SessionManager(
      {} as never,
      apiService as never,
      {} as never,
      alertService as never,
      {} as never,
      {} as never,
      challengeService as never,
      {} as never,
      httpService as never,
      {} as never,
      {} as never,
      '',
      {} as never,
      {} as never,
      {} as never,
    )

  const retrieveKeyParams = (manager: SessionManager) =>
    (
      manager as unknown as {
        retrieveKeyParams(dto: { email: string }): Promise<{ response: unknown }>
      }
    ).retrieveKeyParams({ email: 'test@test.te' })

  beforeEach(() => {
    apiService = {
      setInvalidSessionObserver: jest.fn(),
      getAccountKeyParams: jest.fn().mockResolvedValue(magicLinkRequiredResponse),
      createErrorResponse: jest.fn((message: string, _status: unknown, tag: ErrorTag) => ({
        status: 400,
        data: { error: { message, tag } },
      })),
    }
    alertService = {
      alert: jest.fn().mockResolvedValue(undefined),
    }
    challengeService = {
      promptForChallengeResponse: jest.fn(),
    }
    httpService = {
      post: jest.fn(),
    }
  })

  it('reports delivery failure and aborts instead of opening a code prompt', async () => {
    httpService.post.mockResolvedValue({
      status: 500,
      data: {
        error: {
          message: 'Email delivery is not configured. Magic-link sign-in is unavailable.',
        },
      },
    })

    const result = await retrieveKeyParams(createSessionManager())

    expect(alertService.alert).toHaveBeenCalledWith(
      'Email delivery is not configured. Magic-link sign-in is unavailable.',
    )
    expect(challengeService.promptForChallengeResponse).not.toHaveBeenCalled()
    expect(result.response).toEqual({
      status: 400,
      data: {
        error: {
          message: 'Email delivery is not configured. Magic-link sign-in is unavailable.',
          tag: ErrorTag.ClientCanceledMfa,
        },
      },
    })
  })

  it('rejects an unsafe legacy on-screen-code response without displaying the code', async () => {
    httpService.post.mockResolvedValue({
      status: 200,
      data: {
        emailed: false,
        code: '123456',
      },
    })

    await retrieveKeyParams(createSessionManager())

    expect(alertService.alert).toHaveBeenCalledWith(
      'The verification code could not be delivered by email. Please contact your server administrator or try again later.',
    )
    expect(challengeService.promptForChallengeResponse).not.toHaveBeenCalled()
    expect(alertService.alert.mock.calls.flat().join(' ')).not.toContain('123456')
  })
})
