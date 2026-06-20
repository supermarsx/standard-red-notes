import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateShare } from './CreateShare'

describe('CreateShare', () => {
  let shareRepository: ShareRepositoryInterface
  let userRepository: UserRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const validDto = {
    userUuid,
    type: 'note',
    encryptedPayload: 'opaque-ciphertext-blob',
    nickname: 'My shared note',
  }

  const createUseCase = () => new CreateShare(shareRepository, userRepository)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    shareRepository = {} as jest.Mocked<ShareRepositoryInterface>
    shareRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not create share: user not found.')
  })

  it('should fail if the type is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, type: 'folder' })

    expect(result.isFailed()).toBe(true)
    expect(shareRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the encrypted payload is missing', async () => {
    const result = await createUseCase().execute({ ...validDto, encryptedPayload: '' })

    expect(result.isFailed()).toBe(true)
    expect(shareRepository.save).not.toHaveBeenCalled()
  })

  it('should persist a non-revoked share and return the share uuid', async () => {
    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(false)
    const created = result.getValue()

    expect(shareRepository.save).toHaveBeenCalledTimes(1)
    const saved = (shareRepository.save as jest.Mock).mock.calls[0][0] as Share

    expect(created.shareId).toEqual(saved.id.toString())
    expect(saved.props.userUuid).toEqual(userUuid)
    expect(saved.props.type).toEqual('note')
    expect(saved.props.encryptedPayload).toEqual('opaque-ciphertext-blob')
    expect(saved.props.revoked).toBe(false)
    expect(created.nickname).toEqual('My shared note')
  })

  it('should normalize a blank nickname to null', async () => {
    const result = await createUseCase().execute({ ...validDto, nickname: '   ' })

    expect(result.isFailed()).toBe(false)
    const saved = (shareRepository.save as jest.Mock).mock.calls[0][0] as Share
    expect(saved.props.nickname).toBeNull()
  })

  it('should accept account type shares', async () => {
    const result = await createUseCase().execute({ ...validDto, type: 'account' })

    expect(result.isFailed()).toBe(false)
    const saved = (shareRepository.save as jest.Mock).mock.calls[0][0] as Share
    expect(saved.props.type).toEqual('account')
  })

  it('should generate distinct share uuids on each invocation', async () => {
    const first = (await createUseCase().execute(validDto)).getValue()
    const second = (await createUseCase().execute(validDto)).getValue()

    expect(first.shareId).not.toEqual(second.shareId)
  })
})
