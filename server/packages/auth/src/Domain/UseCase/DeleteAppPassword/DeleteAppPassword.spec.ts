import { UniqueEntityId } from '@standardnotes/domain-core'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'

import { DeleteAppPassword } from './DeleteAppPassword'

describe('DeleteAppPassword', () => {
  let appPasswordRepository: AppPasswordRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const otherUserUuid = '11111111-1111-1111-1111-111111111111'
  const appPasswordId = 'app-password-1'

  const appPasswordOf = (owner: string) => ({ props: { userUuid: owner } }) as jest.Mocked<AppPassword>

  const createUseCase = () => new DeleteAppPassword(appPasswordRepository)

  beforeEach(() => {
    appPasswordRepository = {} as jest.Mocked<AppPasswordRepositoryInterface>
    appPasswordRepository.findById = jest.fn().mockResolvedValue(appPasswordOf(userUuid))
    appPasswordRepository.remove = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail without touching the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', appPasswordId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not delete app password')
    expect(appPasswordRepository.findById).not.toHaveBeenCalled()
    expect(appPasswordRepository.remove).not.toHaveBeenCalled()
  })

  it('should fail if the app password does not exist', async () => {
    appPasswordRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('App password not found')
    expect(appPasswordRepository.remove).not.toHaveBeenCalled()
  })

  it('should refuse to delete an app password belonging to another user', async () => {
    appPasswordRepository.findById = jest.fn().mockResolvedValue(appPasswordOf(otherUserUuid))

    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('App password not found')
    expect(appPasswordRepository.remove).not.toHaveBeenCalled()
  })

  it('should delete the app password owned by the requesting user', async () => {
    const owned = appPasswordOf(userUuid)
    appPasswordRepository.findById = jest.fn().mockResolvedValue(owned)

    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual('App password deleted')

    const lookupId = (appPasswordRepository.findById as jest.Mock).mock.calls[0][0] as UniqueEntityId
    expect(lookupId.toString()).toEqual(appPasswordId)
    expect(appPasswordRepository.remove).toHaveBeenCalledWith(owned)
  })
})
