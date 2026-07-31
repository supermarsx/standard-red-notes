import { Result } from '@standardnotes/domain-core'
import { HttpStatusCode } from '@standardnotes/responses'

import { SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE } from '../Domain/Auth/SecurityStepUp'
import { GenerateRecoveryCodes } from '../Domain/UseCase/GenerateRecoveryCodes/GenerateRecoveryCodes'
import { AuthController } from './AuthController'

describe('AuthController security step-up responses', () => {
  const createController = (doGenerateRecoveryCodes: jest.Mocked<Pick<GenerateRecoveryCodes, 'execute'>>) =>
    new AuthController({} as never, doGenerateRecoveryCodes as GenerateRecoveryCodes, {} as never)

  it('returns a stable update-required response when a legacy token cannot provide password proof', async () => {
    const doGenerateRecoveryCodes = {
      execute: jest.fn().mockResolvedValue(Result.fail(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE)),
    }

    const response = await createController(doGenerateRecoveryCodes).generateRecoveryCodes({
      userUuid: 'user-1',
      authTokenVersion: 1,
    })

    expect(response).toEqual({
      status: HttpStatusCode.BadRequest,
      data: {
        error: {
          message: SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE,
        },
      },
    })
  })

  it('does not expose unrelated recovery-code generation failures', async () => {
    const doGenerateRecoveryCodes = {
      execute: jest.fn().mockResolvedValue(Result.fail('database contained sensitive details')),
    }

    const response = await createController(doGenerateRecoveryCodes).generateRecoveryCodes({
      userUuid: 'user-1',
      authTokenVersion: 3,
      serverPassword: 'password',
    })

    expect(response.data).toEqual({
      error: {
        message: 'Could not generate recovery codes.',
      },
    })
  })
})
