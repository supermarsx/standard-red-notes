import { UniqueEntityId } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { RevokeShare } from './RevokeShare'

describe('RevokeShare', () => {
  let shareRepository: ShareRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const shareId = '11111111-1111-1111-1111-111111111111'

  const createShare = (ownerUuid: string) =>
    Share.create(
      {
        userUuid: ownerUuid,
        type: 'note',
        encryptedPayload: 'cipher',
        nickname: null,
        createdAt: new Date(1),
        revoked: false,
        oneTimeView: false,
        viewExpiresMinutes: null,
        firstOpenedAt: null,
      },
      new UniqueEntityId(shareId),
    ).getValue()

  const createUseCase = () => new RevokeShare(shareRepository)

  beforeEach(() => {
    shareRepository = {} as jest.Mocked<ShareRepositoryInterface>
    shareRepository.save = jest.fn().mockResolvedValue(undefined)
    shareRepository.findById = jest.fn().mockResolvedValue(createShare(userUuid))
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', shareId })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the share is not found', async () => {
    shareRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, shareId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Share not found')
  })

  it('should not allow revoking another users share', async () => {
    shareRepository.findById = jest.fn().mockResolvedValue(createShare('22222222-2222-2222-2222-222222222222'))

    const result = await createUseCase().execute({ userUuid, shareId })

    expect(result.isFailed()).toBe(true)
    expect(shareRepository.save).not.toHaveBeenCalled()
  })

  it('should soft-revoke (save revoked=true, never remove) the share', async () => {
    const result = await createUseCase().execute({ userUuid, shareId })

    expect(result.isFailed()).toBe(false)
    expect(shareRepository.save).toHaveBeenCalledTimes(1)
    const saved = (shareRepository.save as jest.Mock).mock.calls[0][0] as Share
    expect(saved.props.revoked).toBe(true)
    expect(saved.id.toString()).toEqual(shareId)
    expect(saved.props.encryptedPayload).toEqual('cipher')
  })
})
