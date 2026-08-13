import { UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { createDeadManSwitchEmailDeliveryId } from '../../Email/EmailDeliveryId'
import { EmailSenderInterface } from '../../Email/EmailSenderInterface'

import { DeleteDeadManSwitch } from './DeleteDeadManSwitch'

describe('DeleteDeadManSwitch', () => {
  let deadManSwitchRepository: DeadManSwitchRepositoryInterface
  let emailSender: EmailSenderInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const switchId = '11111111-1111-1111-1111-111111111111'

  const createUseCase = () => new DeleteDeadManSwitch(deadManSwitchRepository, emailSender)

  const buildSwitch = (owner = userUuid) =>
    DeadManSwitch.create(
      {
        userUuid: owner,
        recipientEmail: 'survivor@example.com',
        shareUrl: 'https://notes.example.com/share/abc#key=secret',
        message: null,
        intervalDays: 30,
        deadline: Date.now() + 1000,
        triggered: false,
        lastCheckInAt: null,
        createdAt: Date.now(),
        sendAttempts: 0,
        nextAttemptAt: null,
        lastAttemptAt: null,
        lastError: null,
      },
      new UniqueEntityId(switchId),
    ).getValue()

  beforeEach(() => {
    deadManSwitchRepository = {} as jest.Mocked<DeadManSwitchRepositoryInterface>
    deadManSwitchRepository.findById = jest.fn().mockResolvedValue(buildSwitch())
    deadManSwitchRepository.remove = jest.fn().mockResolvedValue(undefined)

    emailSender = {
      acceptanceMode: 'provider',
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn(),
    }
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', switchId })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the switch belongs to another user', async () => {
    deadManSwitchRepository.findById = jest.fn().mockResolvedValue(buildSwitch('99999999-9999-9999-9999-999999999999'))

    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.remove).not.toHaveBeenCalled()
  })

  it('should remove the owned switch', async () => {
    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(false)
    expect(deadManSwitchRepository.remove).toHaveBeenCalledTimes(1)
  })

  it('cancels the queued occurrence before removing the switch', async () => {
    const current = buildSwitch()
    deadManSwitchRepository.findById = jest.fn().mockResolvedValue(current)
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockResolvedValue('cancelled'),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(false)
    expect(emailSender.cancelDelivery).toHaveBeenCalledWith(
      createDeadManSwitchEmailDeliveryId(current.id.toString(), current.props.deadline),
    )
    expect((emailSender.cancelDelivery as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (deadManSwitchRepository.remove as jest.Mock).mock.invocationCallOrder[0],
    )
  })

  it('does not remove the switch while its queued occurrence is in flight', async () => {
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockReturnValue(true),
      getDeliveryStatus: jest.fn(),
      cancelDelivery: jest.fn().mockResolvedValue('in-flight'),
      sendEmail: jest.fn(),
    }

    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('already in flight')
    expect(deadManSwitchRepository.remove).not.toHaveBeenCalled()
  })
})
