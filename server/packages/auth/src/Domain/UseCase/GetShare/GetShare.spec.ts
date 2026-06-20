import { UniqueEntityId } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { GetShare } from './GetShare'

describe('GetShare', () => {
  let shareRepository: ShareRepositoryInterface

  const shareId = '11111111-1111-1111-1111-111111111111'

  const createShare = (revoked: boolean) =>
    Share.create(
      {
        userUuid: '00000000-0000-0000-0000-000000000000',
        type: 'note',
        encryptedPayload: 'cipher',
        nickname: 'nick',
        createdAt: new Date(1),
        revoked,
      },
      new UniqueEntityId(shareId),
    ).getValue()

  const createUseCase = () => new GetShare(shareRepository)

  beforeEach(() => {
    shareRepository = {} as jest.Mocked<ShareRepositoryInterface>
    shareRepository.findById = jest.fn().mockResolvedValue(createShare(false))
  })

  it('should return type and encrypted payload for an active share', async () => {
    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(false)
    const value = result.getValue()
    expect(value.type).toEqual('note')
    expect(value.encryptedPayload).toEqual('cipher')
    // Must never leak the owning user uuid.
    expect(value).not.toHaveProperty('userUuid')
  })

  it('should fail (not found) if the share does not exist', async () => {
    shareRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Share not found')
  })

  it('should fail (not found) if the share is revoked', async () => {
    shareRepository.findById = jest.fn().mockResolvedValue(createShare(true))

    const result = await createUseCase().execute({ shareId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Share not found')
  })
})
