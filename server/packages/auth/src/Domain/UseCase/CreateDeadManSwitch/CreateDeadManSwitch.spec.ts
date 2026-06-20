import { DeadManSwitch } from '../../DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../../DeadManSwitch/DeadManSwitchRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateDeadManSwitch } from './CreateDeadManSwitch'

describe('CreateDeadManSwitch', () => {
  let deadManSwitchRepository: DeadManSwitchRepositoryInterface
  let userRepository: UserRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const validDto = {
    userUuid,
    recipientEmail: 'survivor@example.com',
    shareUrl: 'https://notes.example.com/share/abc#key=secret',
    message: 'Take care of the cat.',
    intervalDays: 30,
  }

  const createUseCase = () => new CreateDeadManSwitch(deadManSwitchRepository, userRepository)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    deadManSwitchRepository = {} as jest.Mocked<DeadManSwitchRepositoryInterface>
    deadManSwitchRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not create dead man switch: user not found.')
  })

  it('should fail if the recipient email is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, recipientEmail: 'not-an-email' })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the share url is missing', async () => {
    const result = await createUseCase().execute({ ...validDto, shareUrl: '   ' })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the interval is less than 1 day', async () => {
    const result = await createUseCase().execute({ ...validDto, intervalDays: 0 })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the interval is not a whole number', async () => {
    const result = await createUseCase().execute({ ...validDto, intervalDays: 1.5 })

    expect(result.isFailed()).toBe(true)
    expect(deadManSwitchRepository.save).not.toHaveBeenCalled()
  })

  it('should persist an armed switch with deadline now + interval', async () => {
    const before = Date.now()
    const result = await createUseCase().execute(validDto)
    const after = Date.now()

    expect(result.isFailed()).toBe(false)
    const created = result.getValue()

    expect(deadManSwitchRepository.save).toHaveBeenCalledTimes(1)
    const saved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch

    expect(created.uuid).toEqual(saved.id.toString())
    expect(saved.props.userUuid).toEqual(userUuid)
    expect(saved.props.recipientEmail).toEqual('survivor@example.com')
    expect(saved.props.shareUrl).toEqual(validDto.shareUrl)
    expect(saved.props.triggered).toBe(false)
    expect(saved.props.lastCheckInAt).toBeNull()
    expect(saved.props.deadline).toBeGreaterThanOrEqual(before + 30 * 86_400_000)
    expect(saved.props.deadline).toBeLessThanOrEqual(after + 30 * 86_400_000)
  })

  it('should normalize a blank message to null', async () => {
    const result = await createUseCase().execute({ ...validDto, message: '   ' })

    expect(result.isFailed()).toBe(false)
    const saved = (deadManSwitchRepository.save as jest.Mock).mock.calls[0][0] as DeadManSwitch
    expect(saved.props.message).toBeNull()
  })
})
