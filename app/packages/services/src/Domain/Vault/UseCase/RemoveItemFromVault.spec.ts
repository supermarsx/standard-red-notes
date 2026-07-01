import { ClientDisplayableError } from '@standardnotes/responses'
import { DecryptedItemInterface, FileItem } from '@standardnotes/models'
import { ContentType } from '@standardnotes/domain-core'
import { FilesClientInterface } from '@standardnotes/files'

import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import { SyncServiceInterface } from '../../Sync/SyncServiceInterface'
import { RemoveItemFromVault } from './RemoveItemFromVault'

describe('RemoveItemFromVault', () => {
  let mutator: jest.Mocked<MutatorClientInterface>
  let sync: jest.Mocked<SyncServiceInterface>
  let files: jest.Mocked<FilesClientInterface>
  let useCase: RemoveItemFromVault

  beforeEach(() => {
    mutator = {} as jest.Mocked<MutatorClientInterface>
    mutator.changeItem = jest.fn()

    sync = {} as jest.Mocked<SyncServiceInterface>
    sync.sync = jest.fn()

    files = {} as jest.Mocked<FilesClientInterface>
    files.moveFileOutOfSharedVault = jest.fn().mockResolvedValue(undefined)

    useCase = new RemoveItemFromVault(mutator, sync, files)
  })

  it('moves a shared-vault file out using the pre-mutation vault id', async () => {
    const file = {
      uuid: 'file-1',
      content_type: ContentType.TYPES.File,
      shared_vault_uuid: 'shared-vault-1',
    } as unknown as FileItem

    await useCase.execute({ item: file })

    expect(files.moveFileOutOfSharedVault).toHaveBeenCalledTimes(1)
    expect(files.moveFileOutOfSharedVault).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'file-1', shared_vault_uuid: 'shared-vault-1' }),
    )
  })

  it('propagates the error returned by moveFileOutOfSharedVault', async () => {
    const file = {
      uuid: 'file-1',
      content_type: ContentType.TYPES.File,
      shared_vault_uuid: 'shared-vault-1',
    } as unknown as FileItem

    const error = new ClientDisplayableError('could not move file')
    files.moveFileOutOfSharedVault = jest.fn().mockResolvedValue(error)

    const result = await useCase.execute({ item: file })

    expect(result).toBe(error)
  })

  it('does NOT call move-out for a file that was in a private (non-shared) vault', async () => {
    const file = {
      uuid: 'file-1',
      content_type: ContentType.TYPES.File,
      shared_vault_uuid: undefined,
    } as unknown as FileItem

    await useCase.execute({ item: file })

    expect(files.moveFileOutOfSharedVault).not.toHaveBeenCalled()
  })

  it('does NOT call move-out for a non-file item', async () => {
    const note = {
      uuid: 'note-1',
      content_type: ContentType.TYPES.Note,
      shared_vault_uuid: 'shared-vault-1',
    } as unknown as DecryptedItemInterface

    await useCase.execute({ item: note })

    expect(files.moveFileOutOfSharedVault).not.toHaveBeenCalled()
  })
})
