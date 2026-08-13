import { Result } from '@standardnotes/domain-core'
import { HttpStatusCode } from '@standardnotes/responses'

import { DeadManSwitchesController } from './DeadManSwitchesController'

describe('DeadManSwitchesController cancellation responses', () => {
  const createController = (checkInError: string, deleteError = checkInError) =>
    new DeadManSwitchesController(
      {} as never,
      {} as never,
      { execute: jest.fn().mockResolvedValue(Result.fail(checkInError)) } as never,
      { execute: jest.fn().mockResolvedValue(Result.fail(deleteError)) } as never,
      {} as never,
    )

  it.each([
    ['checkIn', 'Could not check in: the current email delivery is already in flight.', 409],
    ['checkIn', 'Could not check in: durable email delivery cancellation is unavailable.', 503],
    ['checkIn', 'Dead man switch not found', HttpStatusCode.Unauthorized],
    ['delete', 'Could not delete dead man switch: the current email delivery is already in flight.', 409],
    ['delete', 'Could not delete dead man switch: durable email delivery cancellation is unavailable.', 503],
    ['delete', 'Dead man switch not found', HttpStatusCode.Unauthorized],
  ] as const)('maps %s failure %s to HTTP %s', async (method, message, expectedStatus) => {
    const controller = createController(message)

    const response = await controller[method]({ userUuid: 'user-1', switchId: 'switch-1' })

    expect(response.status).toBe(expectedStatus)
    expect(response.data).toEqual({ error: { message } })
  })
})
