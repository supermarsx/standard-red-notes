import { Result } from '@standardnotes/domain-core'
import { HttpStatusCode } from '@standardnotes/responses'

import { EmailRemindersController } from './EmailRemindersController'

describe('EmailRemindersController cancellation responses', () => {
  const createController = (message: string) =>
    new EmailRemindersController(
      {} as never,
      {} as never,
      { execute: jest.fn().mockResolvedValue(Result.fail(message)) } as never,
      {} as never,
    )

  it.each([
    ['Could not delete email reminder: the email delivery is already in flight.', 409],
    ['Could not delete email reminder: durable email delivery cancellation is unavailable.', 503],
    ['Email reminder not found', HttpStatusCode.Unauthorized],
  ] as const)('maps delete failure %s to HTTP %s', async (message, expectedStatus) => {
    const response = await createController(message).delete({ userUuid: 'user-1', reminderId: 'reminder-1' })

    expect(response.status).toBe(expectedStatus)
    expect(response.data).toEqual({ error: { message } })
  })
})
