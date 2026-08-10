import { SharedVaultServerInterface } from '@standardnotes/api'
import { DecryptedItemInterface, SharedVaultListingInterface, VaultListingInterface } from '@standardnotes/models'
import { ClientDisplayableError, HttpStatusCode } from '@standardnotes/responses'

import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import { GetVaultItems } from '../../Vault/UseCase/GetVaultItems'
import { MoveItemsToVault } from '../../Vault/UseCase/MoveItemsToVault'
import { ConvertToSharedVault } from './ConvertToSharedVault'

describe('ConvertToSharedVault', () => {
  it('propagates an item relocation error instead of reporting conversion success', async () => {
    const privateVault = {
      uuid: 'private-vault',
      isSharedVaultListing: () => false,
    } as VaultListingInterface
    const sharedVault = {
      uuid: privateVault.uuid,
      systemIdentifier: 'shared-key-system',
      sharing: {
        sharedVaultUuid: 'shared-vault',
        ownerUserUuid: 'owner-user',
        fileBytesUsed: 0,
        designatedSurvivor: null,
      },
      isSharedVaultListing: () => true,
    } as unknown as SharedVaultListingInterface
    const vaultItem = { uuid: 'file' } as DecryptedItemInterface
    const moveError = new ClientDisplayableError('Could not relocate file')

    const sharedVaultServer = {
      createSharedVault: jest.fn().mockResolvedValue({
        status: HttpStatusCode.Success,
        data: {
          sharedVault: {
            uuid: sharedVault.sharing.sharedVaultUuid,
            user_uuid: sharedVault.sharing.ownerUserUuid,
            file_upload_bytes_used: 0,
          },
        },
      }),
    } as unknown as jest.Mocked<SharedVaultServerInterface>
    const mutator = {
      changeItem: jest.fn().mockResolvedValue(sharedVault),
    } as unknown as jest.Mocked<MutatorClientInterface>
    const getVaultItems = {
      execute: jest.fn().mockReturnValue({ getValue: () => [vaultItem] }),
    } as unknown as jest.Mocked<GetVaultItems>
    const moveItemsToVault = {
      execute: jest.fn().mockResolvedValue(moveError),
    } as unknown as jest.Mocked<MoveItemsToVault>
    const useCase = new ConvertToSharedVault(mutator, sharedVaultServer, moveItemsToVault, getVaultItems)

    const result = await useCase.execute({ vault: privateVault })

    expect(result).toBe(moveError)
    expect(moveItemsToVault.execute).toHaveBeenCalledWith({ vault: sharedVault, items: [vaultItem] })
  })
})
