import { Logger } from 'winston'
import { UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { CheckInDeadManSwitch } from '../CheckInDeadManSwitch/CheckInDeadManSwitch'

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

  const useDurableSender = (
    status: 'pending' | 'provider-accepted' | 'dead' | 'quarantined' | 'discarded' | 'superseded' | 'missing',
    accepted = true,
  ) => {
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn().mockResolvedValue(status),
      cancelDelivery: jest.fn().mockResolvedValue('cancelled'),
      sendEmail: jest.fn().mockResolvedValue(accepted),
    }
  }

  beforeEach(() => {
    deadManSwitchRepository = {} as jest.Mocked<DeadManSwitchRepositoryInterface>
    deadManSwitchRepository.findDue = jest
      .fn()
      .mockResolvedValue([
        buildSwitch('11111111-1111-1111-1111-111111111111'),
        buildSwitch('22222222-2222-2222-2222-222222222222', null),
      ])
    deadManSwitchRepository.save = jest.fn().mockResolvedValue(undefined)

    emailSender = {
      acceptanceMode: 'provider',
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn().mockResolvedValue(true),
    }

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
    logger.info = jest.fn()
    logger.debug = jest.fn()
  })

  it('should skip the scan when SMTP is not configured', async () => {
    emailSender.isConfigured = jest.fn().mockResolvedValue(false)

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
    expect((emailSender.sendEmail as jest.Mock).mock.calls[0][3]).toEqual({
      deliverySource: 'account',
      deliveryId: expect.stringMatching(/^dead-man-switch-[0-9a-f]{64}$/),
      retryMode: 'indefinite',
    })
  })

  it('should not mark a switch triggered when the email could not be sent', async () => {
    emailSender.sendEmail = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    // Only the successfully-delivered one is counted.
    expect(result.getValue()).toBe(1)
    // Both are saved: the failed one records its retry schedule, the other triggers.
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(2)

    const failedSaved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(failedSaved.props.triggered).toBe(false)
  })

  it('does not mark a switch triggered on durable queue acceptance', async () => {
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
    useDurableSender('missing')

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('does not enqueue a duplicate while durable switch delivery is pending', async () => {
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
    useDurableSender('pending')

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('marks provider-accepted durable delivery triggered exactly once without sending again', async () => {
    let storedSwitch = buildSwitch('11111111-1111-1111-1111-111111111111')
    deadManSwitchRepository.findDue = jest.fn().mockImplementation(async () => {
      return storedSwitch.props.triggered ? [] : [storedSwitch]
    })
    deadManSwitchRepository.save = jest.fn().mockImplementation(async (deadManSwitch: DeadManSwitch) => {
      storedSwitch = deadManSwitch
    })
    useDurableSender('provider-accepted')

    const first = await createUseCase().execute({})
    const second = await createUseCase().execute({})

    expect(first.getValue()).toBe(1)
    expect(second.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(1)
    expect(storedSwitch.props.triggered).toBe(true)
  })

  it('uses a distinct delivery id after provider acceptance, check-in, and the next due occurrence', async () => {
    const initialNow = 1_800_000_000_000
    const clock = jest.spyOn(Date, 'now').mockReturnValue(initialNow)
    try {
      let storedSwitch = DeadManSwitch.create(
        {
          userUuid: '00000000-0000-0000-0000-000000000000',
          recipientEmail: 'survivor@example.com',
          shareUrl: 'https://notes.example.com/share/abc#key=secret',
          message: 'hello',
          intervalDays: 30,
          deadline: initialNow - 1,
          triggered: false,
          lastCheckInAt: null,
          createdAt: initialNow - 30 * 86_400_000,
          sendAttempts: 0,
          nextAttemptAt: null,
          lastAttemptAt: null,
          lastError: null,
        },
        new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
      ).getValue()
      deadManSwitchRepository.findDue = jest.fn().mockImplementation(async () => {
        return !storedSwitch.props.triggered && storedSwitch.props.deadline <= Date.now() ? [storedSwitch] : []
      })
      deadManSwitchRepository.findById = jest.fn().mockImplementation(async () => storedSwitch)
      deadManSwitchRepository.save = jest.fn().mockImplementation(async (deadManSwitch: DeadManSwitch) => {
        storedSwitch = deadManSwitch
      })
      useDurableSender('missing')
      emailSender.getDeliveryStatus = jest
        .fn()
        .mockResolvedValueOnce('missing')
        .mockResolvedValueOnce('provider-accepted')
        .mockResolvedValueOnce('missing')
      emailSender.cancelDelivery = jest.fn().mockResolvedValue('provider-accepted')

      await createUseCase().execute({})
      await createUseCase().execute({})
      const firstDeliveryId = (emailSender.sendEmail as jest.Mock).mock.calls[0][3].deliveryId as string
      expect(storedSwitch.props.triggered).toBe(true)

      clock.mockReturnValue(initialNow + 1_000)
      const checkIn = await new CheckInDeadManSwitch(deadManSwitchRepository, emailSender).execute({
        userUuid: storedSwitch.props.userUuid,
        switchId: storedSwitch.id.toString(),
      })
      expect(checkIn.isFailed()).toBe(false)
      expect(emailSender.cancelDelivery).toHaveBeenCalledWith(firstDeliveryId)
      expect(storedSwitch.props.triggered).toBe(false)

      clock.mockReturnValue(storedSwitch.props.deadline + 1)
      await createUseCase().execute({})
      const nextDeliveryId = (emailSender.sendEmail as jest.Mock).mock.calls[1][3].deliveryId as string

      expect(nextDeliveryId).not.toEqual(firstDeliveryId)
      expect(emailSender.sendEmail).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })

  it.each(['dead', 'quarantined', 'discarded', 'superseded'] as const)(
    'retains and alerts for a durable switch in terminal state %s',
    async (status) => {
      deadManSwitchRepository.findDue = jest
        .fn()
        .mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
      useDurableSender(status)

      const result = await createUseCase().execute({})

      expect(result.getValue()).toBe(0)
      expect(emailSender.sendEmail).not.toHaveBeenCalled()
      expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('Durable dead-man-switch email reached a terminal state.', {
        deadManSwitchId: '11111111-1111-1111-1111-111111111111',
        deliveryStatus: status,
      })
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('survivor@example.com')
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('hello')
    },
  )

  it('fails status lookup closed and persists only a redacted retry error', async () => {
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
    useDurableSender('missing')
    emailSender.getDeliveryStatus = jest.fn().mockRejectedValue(new Error('redis leaked detail'))

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(1)
    const saved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(saved.props.triggered).toBe(false)
    expect(saved.props.lastError).toBe('Durable email delivery status is unavailable.')
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('redis leaked detail')
  })

  it('should continue past an individual email failure', async () => {
    emailSender.sendEmail = jest.fn().mockRejectedValueOnce(new Error('smtp blew up')).mockResolvedValueOnce(true)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(1)
    // The failure row is persisted along with the successful trigger.
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(2)
  })

  it('should log and skip a delivered switch whose persisted state can no longer be reconstructed', async () => {
    const invalidSwitch = buildSwitch('11111111-1111-1111-1111-111111111111')
    invalidSwitch.props.recipientEmail = ''
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([invalidSwitch])

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Could not mark a dead-man switch as triggered.', {
      deadManSwitchId: invalidSwitch.id.toString(),
    })
  })

  it('should log and skip a failed delivery whose retry state can no longer be reconstructed', async () => {
    const invalidSwitch = buildSwitch('11111111-1111-1111-1111-111111111111')
    invalidSwitch.props.shareUrl = ''
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([invalidSwitch])
    emailSender.sendEmail = jest.fn().mockResolvedValue(false)

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Could not record a dead-man-switch failure.', {
      deadManSwitchId: invalidSwitch.id.toString(),
    })
  })

  it('should contain a retry persistence failure and leave the switch due for a later scan', async () => {
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
    deadManSwitchRepository.save = jest.fn().mockRejectedValue(new Error('database unavailable'))
    emailSender.sendEmail = jest.fn().mockResolvedValue(false)

    const result = await createUseCase().execute({})

    expect(result.getValue()).toBe(0)
    expect(logger.error).toHaveBeenCalledWith('Error recording a dead-man-switch failure.', {
      deadManSwitchId: '11111111-1111-1111-1111-111111111111',
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('database unavailable')
  })

  it('should schedule the next attempt ~5 min out and increment attempts on a failed send', async () => {
    deadManSwitchRepository.findDue = jest.fn().mockResolvedValue([buildSwitch('11111111-1111-1111-1111-111111111111')])
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
