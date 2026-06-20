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

  const buildSwitch = (id: string, message: string | null = 'hello') =>
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
    // Only the successfully-delivered one is counted and saved.
    expect(result.getValue()).toBe(1)
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(1)
  })

  it('should continue past an individual email failure', async () => {
    emailSender.sendEmail = jest
      .fn()
      .mockRejectedValueOnce(new Error('smtp blew up'))
      .mockResolvedValueOnce(true)

    const result = await createUseCase().execute({})

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(1)
    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(1)
  })
})
