import { UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'

import { CheckInDeadManSwitch } from './CheckInDeadManSwitch'

describe('CheckInDeadManSwitch', () => {
  let deadManSwitchRepository: DeadManSwitchRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const switchId = '11111111-1111-1111-1111-111111111111'

  const createUseCase = () => new CheckInDeadManSwitch(deadManSwitchRepository)

  const buildSwitch = (owner = userUuid) =>
    DeadManSwitch.create(
      {
        userUuid: owner,
        recipientEmail: 'survivor@example.com',
        shareUrl: 'https://notes.example.com/share/abc#key=secret',
        message: null,
        intervalDays: 30,
        deadline: Date.now() - 1000,
        triggered: true,
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
    deadManSwitchRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', switchId })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the switch is not found', async () => {
    deadManSwitchRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the switch belongs to another user', async () => {
    deadManSwitchRepository.findById = jest
      .fn()
      .mockResolvedValue(buildSwitch('99999999-9999-9999-9999-999999999999'))

    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should push the deadline forward, set lastCheckInAt and re-arm', async () => {
    const before = Date.now()
    const result = await createUseCase().execute({ userUuid, switchId })
    const after = Date.now()

    expect(result.isFailed()).toBe(false)
    const newDeadline = result.getValue()
    expect(newDeadline).toBeGreaterThanOrEqual(before + 30 * 86_400_000)
    expect(newDeadline).toBeLessThanOrEqual(after + 30 * 86_400_000)

    const saved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(saved.props.triggered).toBe(false)
    expect(saved.props.lastCheckInAt).not.toBeNull()
    expect(saved.props.deadline).toEqual(newDeadline)
  })
})
