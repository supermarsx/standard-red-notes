import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { HttpStatusCode } from '@standardnotes/responses'

import { GenerateMagicLinkCode } from '../Domain/UseCase/GenerateMagicLinkCode/GenerateMagicLinkCode'
import { GetSetting } from '../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../Domain/UseCase/SetSettingValue/SetSettingValue'

import { MagicLinkController } from './MagicLinkController'

describe('MagicLinkController', () => {
  let generateMagicLinkCode: jest.Mocked<GenerateMagicLinkCode>
  let setSettingValue: jest.Mocked<SetSettingValue>
  let getSetting: jest.Mocked<GetSetting>

  const createController = () => new MagicLinkController(generateMagicLinkCode, setSettingValue, getSetting)

  beforeEach(() => {
    generateMagicLinkCode = {
      execute: jest.fn().mockResolvedValue(Result.ok({ emailed: true })),
      isDeliveryConfigured: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<GenerateMagicLinkCode>

    setSettingValue = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<SetSettingValue>

    getSetting = {
      execute: jest.fn().mockResolvedValue(Result.fail('not found')),
    } as unknown as jest.Mocked<GetSetting>
  })

  it('never includes the generated verification code in a successful unauthenticated response', async () => {
    const response = await createController().request({ email: 'test@test.te' })

    expect(response).toEqual({
      status: HttpStatusCode.Success,
      data: {
        emailed: true,
      },
    })
    expect(response.data).not.toHaveProperty('code')
  })

  it('returns an explicit failure when verification-code delivery fails', async () => {
    generateMagicLinkCode.execute.mockResolvedValue(
      Result.fail('Could not deliver the magic-link verification code. Please try again.'),
    )

    const response = await createController().request({ email: 'test@test.te' })

    expect(response).toEqual({
      status: HttpStatusCode.InternalServerError,
      data: {
        error: {
          message: 'Could not deliver the magic-link verification code. Please try again.',
        },
      },
    })
    expect(response.data).not.toHaveProperty('code')
  })

  it('does not enable magic-link sign-in when email delivery is not configured', async () => {
    generateMagicLinkCode.isDeliveryConfigured.mockReturnValue(false)

    const response = await createController().setStatus({
      userUuid: '00000000-0000-0000-0000-000000000000',
      enabled: true,
    })

    expect(response).toEqual({
      status: HttpStatusCode.BadRequest,
      data: {
        error: {
          message: 'Email delivery is not configured. Magic-link sign-in cannot be enabled.',
        },
      },
    })
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })
})
