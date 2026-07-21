import { Uuid } from '@standardnotes/domain-core'

import { Share } from '../../Share/Share'
import { ShareRepositoryInterface } from '../../Share/ShareRepositoryInterface'

import { ListShares } from './ListShares'

describe('ListShares', () => {
  let shareRepository: ShareRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const shares = [{ props: { itemUuid: 'item-1' } }] as jest.Mocked<Share[]>

  const createUseCase = () => new ListShares(shareRepository)

  beforeEach(() => {
    shareRepository = {} as jest.Mocked<ShareRepositoryInterface>
    shareRepository.findByUserUuid = jest.fn().mockResolvedValue(shares)
  })

  it('should fail without querying the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not list shares')
    expect(shareRepository.findByUserUuid).not.toHaveBeenCalled()
  })

  it('should return the shares scoped to the requesting user', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual(shares)

    expect(shareRepository.findByUserUuid).toHaveBeenCalledTimes(1)
    const queriedUuid = (shareRepository.findByUserUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(queriedUuid.value).toEqual(userUuid)
  })
})
