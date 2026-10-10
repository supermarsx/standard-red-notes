import { UserPermissionChangedInSharedVaultEvent } from '@standardnotes/domain-events'
import { Result } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { UpdateSharedVaultUserPermission } from '../UseCase/UpdateSharedVaultUserPermission/UpdateSharedVaultUserPermission'

import { UserPermissionChangedInSharedVaultEventHandler } from './UserPermissionChangedInSharedVaultEventHandler'

describe('UserPermissionChangedInSharedVaultEventHandler', () => {
  let updateSharedVaultUserPermission: UpdateSharedVaultUserPermission
  let logger: Logger

  const payload = {
    userUuid: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081',
    sharedVaultUuid: 'b3f1c4e2-5d6a-4b8c-9f10-2a3b4c5d6e7f',
    permission: 'write',
    previousPermission: 'read',
    originatorUuid: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    updatedAt: 5_000,
  }

  const event = { payload } as unknown as jest.Mocked<UserPermissionChangedInSharedVaultEvent>

  const createHandler = () =>
    new UserPermissionChangedInSharedVaultEventHandler(updateSharedVaultUserPermission, logger)

  beforeEach(() => {
    updateSharedVaultUserPermission = {} as jest.Mocked<UpdateSharedVaultUserPermission>
    updateSharedVaultUserPermission.execute = jest.fn().mockResolvedValue(Result.ok())

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  it('applies the new permission to the mirror, carrying the mutation timestamp', async () => {
    await createHandler().handle(event)

    expect(updateSharedVaultUserPermission.execute).toHaveBeenCalledWith({
      userUuid: payload.userUuid,
      sharedVaultUuid: payload.sharedVaultUuid,
      permission: 'write',
      updatedAt: 5_000,
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('carries the PREVIOUS permission nowhere: the mirror stores the new one, not the transition', async () => {
    await createHandler().handle(event)

    const dto = (updateSharedVaultUserPermission.execute as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(dto.permission).toEqual('write')
    expect(dto).not.toHaveProperty('previousPermission')
  })

  it('logs loudly when the mirror could not be updated, because uploads are authorized from it', async () => {
    updateSharedVaultUserPermission.execute = jest.fn().mockResolvedValue(Result.fail('nope'))

    await createHandler().handle(event)

    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('does nothing at all when the event carries no shared vault', async () => {
    await createHandler().handle({
      payload: { ...payload, sharedVaultUuid: '' },
    } as unknown as jest.Mocked<UserPermissionChangedInSharedVaultEvent>)

    expect(updateSharedVaultUserPermission.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
