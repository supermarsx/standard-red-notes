import { Uuid } from '@standardnotes/domain-core'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'

import { ListAppPasswords } from './ListAppPasswords'

describe('ListAppPasswords', () => {
  let appPasswordRepository: AppPasswordRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const appPasswords = [{ props: { label: 'MCP' } }, { props: { label: 'CLI' } }] as jest.Mocked<AppPassword[]>

  const createUseCase = () => new ListAppPasswords(appPasswordRepository)

  beforeEach(() => {
    appPasswordRepository = {} as jest.Mocked<AppPasswordRepositoryInterface>
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue(appPasswords)
  })

  it('should fail without querying the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not list app passwords')
    expect(appPasswordRepository.findByUserUuid).not.toHaveBeenCalled()
  })

  it('should return the app passwords scoped to the requesting user', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual(appPasswords)

    expect(appPasswordRepository.findByUserUuid).toHaveBeenCalledTimes(1)
    const queriedUuid = (appPasswordRepository.findByUserUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(queriedUuid.value).toEqual(userUuid)
  })
})
