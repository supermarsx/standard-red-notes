import { ReminderDeliveryScheduler } from './ReminderDeliveryScheduler'
import { ReminderDeliveryService } from './ReminderDeliveryService'

describe('ReminderDeliveryScheduler', () => {
  const createScheduler = (deliverDueReminders: jest.Mock) => {
    const logger = { info: jest.fn(), error: jest.fn() }
    const service = {
      isEnabled: jest.fn().mockReturnValue(true),
      deliverDueReminders,
    } as unknown as ReminderDeliveryService

    return { scheduler: new ReminderDeliveryScheduler(service, 60_000, logger), logger }
  }

  it('logs a failed tick by error class, never by the text of the error', async () => {
    // A tick reaches the store and every provider, whose messages can carry a
    // file path, a destination or a provider's reply.
    const { scheduler, logger } = createScheduler(
      jest.fn().mockRejectedValue(new Error('ENOENT: /var/lib/server/reminders/person@example.com.json')),
    )

    await scheduler.tick()

    expect(logger.error).toHaveBeenCalledWith('Reminder delivery tick failed.', { errorType: 'Error' })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('person@example.com')
  })

  it('runs the next tick after a failed one', async () => {
    const deliverDueReminders = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ sent: 1, failed: 0, skipped: 0, due: 1, scanned: 1 })
    const { scheduler, logger } = createScheduler(deliverDueReminders)

    await scheduler.tick()
    await scheduler.tick()

    expect(deliverDueReminders).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 sent'))
  })
})
