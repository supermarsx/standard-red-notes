import { UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'

import { DeleteDeadManSwitch } from './DeleteDeadManSwitch'

describe('DeleteDeadManSwitch', () => {
  let deadManSwitchRepository: DeadManSwitchRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const switchId = '11111111-1111-1111-1111-111111111111'

  const createUseCase = () => new DeleteDeadManSwitch(deadManSwitchRepository)

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
      },
      new UniqueEntityId(switchId),
    ).getValue()

  beforeEach(() => {
    deadManSwitchRepository = {} as jest.Mocked<DeadManSwitchRepositoryInterface>
    deadManSwitchRepository.findById = jest.fn().mockResolvedValue(buildSwitch())
    deadManSwitchRepository.remove = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', switchId })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the switch belongs to another user', async () => {
    deadManSwitchRepository.findById = jest
      .fn()
      .mockResolvedValue(buildSwitch('99999999-9999-9999-9999-999999999999'))

    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.remove).not.toHaveBeenCalled()
  })

  it('should remove the owned switch', async () => {
    const result = await createUseCase().execute({ userUuid, switchId })

    expect(result.isFailed()).toBe(false)
    expect(deadManSwitchRepository.remove).toHaveBeenCalledTimes(1)
  })
})
