import { UniqueEntityId } from '@standardnotes/domain-core'

import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'

import { ListDeadManSwitches } from './ListDeadManSwitches'

describe('ListDeadManSwitches', () => {
  let deadManSwitchRepository: DeadManSwitchRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const createUseCase = () => new ListDeadManSwitches(deadManSwitchRepository)

  const buildSwitch = () =>
    DeadManSwitch.create(
      {
        userUuid,
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
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()

  beforeEach(() => {
    deadManSwitchRepository = {} as jest.Mocked<DeadManSwitchRepositoryInterface>
    deadManSwitchRepository.findByUserUuid = jest.fn().mockResolvedValue([buildSwitch()])
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
  })

  it('should return only the requesting user switches', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(deadManSwitchRepository.findByUserUuid).toHaveBeenCalledTimes(1)
    expect(result.getValue()).toHaveLength(1)
  })
})
