import { Logger } from 'winston'
import { UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { TriggerDueDeadManSwitches } from './TriggerDueDeadManSwitches'

describe('TriggerDueDeadManSwitches', () => {
  let deadManSwitchRepository: DeadManSwitchRepositoryInterface
  let emailSender: EmailSenderInterface
  let logger: Logger

  const createUseCase = () => new TriggerDueDeadManSwitches(deadManSwitchRepository, emailSender, logger)

  const buildSwitch = (id: string, message: string | null = 'hello', sendAttempts = 0) =>
    DeadManSwitch.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
        recipientEmail: 'survivor@example.com',
        shareUrl: 'https://notes.example.com/share/abc#key=secret',
        message,
        intervalDays: 30,
        deadline: Date.now() - 1000,
        triggered: false,
        lastCheckInAt: null,
        createdAt: Date.now(),
        sendAttempts,
        nextAttemptAt: null,
        lastAttemptAt: null,
        lastError: null,
      },
      new UniqueEntityId(id),
    ).getValue()

  beforeEach(() => {
    deadManSwitchRepository = {} as jest.Mocked<DeadManSwitchRepositoryInterface>
    deadManSwitchRepository.findDue = jest
      .fn()
      .mockResolvedValue([
        buildSwitch('11111111-1111-1111-1111-111111111111'),
        buildSwitch('22222222-2222-2222-2222-222222222222', null),
      ])
    deadManSwitchRepository.save = jest.fn().mockResolvedValue(undefined)

    emailSender = {} as jest.Mocked<EmailSenderInterface>
    emailSender.isConfigured = jest.fn().mockReturnValue(true)
    emailSender.sendEmail = jest.fn().mockResolvedValue(true)

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.info = jest.fn()
    logger.debug = jest.fn()
  })

  it('should skip the scan when SMTP is not configured', async () => {
    emailSender.isConfigured = jest.fn().mockReturnValue(false)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(0)
    expect(deadManSwitchRepository.findDue).not.toHaveBeenCalled()
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should email each due recipient and mark the switch triggered', async () => {
    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(2)
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(2)
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(2)

    const firstSaved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(firstSaved.props.triggered).toBe(true)

    // The body must include the share url.
    const firstBody = (emailSender.sendEmail as jest.Mock).mock.calls[0][2] as string
    expect(firstBody).toContain('https://notes.example.com/share/abc#key=secret')
  })

  it('should not mark a switch triggered when the email could not be sent', async () => {
    emailSender.sendEmail = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    // Only the successfully-delivered one is counted.
    expect(result.getValue()).toBe(1)
    // Both are saved: the failed one records its retry schedule, the other triggers.
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(2)

    const failedSaved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(failedSaved.props.triggered).toBe(false)
  })

  it('should continue past an individual email failure', async () => {
    emailSender.sendEmail = jest
      .fn()
      .mockRejectedValueOnce(new Error('smtp blew up'))
      .mockResolvedValueOnce(true)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(1)
    // The failure row is persisted along with the successful trigger.
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(2)
  })

  it('should schedule the next attempt ~5 min out and increment attempts on a failed send', async () => {
    deadManSwitchRepository.findDue = jest
      .fn()
      .mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
    emailSender.sendEmail = jest.fn().mockResolvedValue(false)

    const before = Date.now()
    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(0)
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(1)

    const saved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(saved.props.triggered).toBe(false)
    expect(saved.props.sendAttempts).toBe(1)
    expect(saved.props.lastError).not.toBeNull()
    expect(saved.props.lastAttemptAt).not.toBeNull()
    // First failure schedules a 5 minute (300_000 ms) backoff.
    expect(saved.props.nextAttemptAt).not.toBeNull()
    expect((saved.props.nextAttemptAt as number) - before).toBeGreaterThanOrEqual(5 * 60_000)
    expect((saved.props.nextAttemptAt as number) - before).toBeLessThan(5 * 60_000 + 60_000)
  })

  it('should keep retrying at the final ~6 month interval after the 9th failure', async () => {
    // A switch that has already failed 9 times; the 10th failure must stay at the
    // last backoff entry (~6 months), never giving up.
    deadManSwitchRepository.findDue = jest
      .fn()
      .mockResolvedValue([buildSwitch('33333333-3333-3333-3333-333333333333', 'hello', 9)])
    emailSender.sendEmail = jest.fn().mockResolvedValue(false)

    const before = Date.now()
    await createUseCase().execute({})

    const saved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(saved.props.sendAttempts).toBe(10)
    const sixMonthsMs = 180 * 24 * 60 * 60_000
    expect((saved.props.nextAttemptAt as number) - before).toBeGreaterThanOrEqual(sixMonthsMs)
    expect((saved.props.nextAttemptAt as number) - before).toBeLessThan(sixMonthsMs + 60_000)
  })

  it('should not select a switch whose next attempt is still in the future', async () => {
    // The due-query gate (next_attempt_at <= now) is enforced by the repository,
    // so a back-off switch simply is not returned by findDue.
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([])

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })
})
