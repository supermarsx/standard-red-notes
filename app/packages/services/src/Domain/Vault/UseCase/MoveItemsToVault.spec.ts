import { ContentType } from '@standardnotes/domain-core'
import { FilesClientInterface } from '@standardnotes/files'
import { DecryptedItemInterface, VaultListingInterface } from '@standardnotes/models'
import { ClientDisplayableError } from '@standardnotes/responses'

import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import { SyncServiceInterface } from '../../Sync/SyncServiceInterface'
import { MoveItemsToVault } from './MoveItemsToVault'

type StoredItem = {
  uuid: string
  content_type: string
  key_system_identifier?: string
  shared_vault_uuid?: string
}

describe('MoveItemsToVault', () => {
  const sharedVault = {
    systemIdentifier: 'target-key-system',
    sharing: {
      sharedVaultUuid: 'target-shared-vault',
      ownerUserUuid: 'owner-user',
    },
    isSharedVaultListing: () => true,
  } as unknown as VaultListingInterface

  let storedItems: Map<string, StoredItem>
  let blobLocations: Set<string>
  let destinationFailureFor: string | undefined
  let mutator: jest.Mocked<MutatorClientInterface>
  let sync: jest.Mocked<SyncServiceInterface>
  let files: jest.Mocked<FilesClientInterface>
  let useCase: MoveItemsToVault

  const owner = (item: Pick<StoredItem, 'shared_vault_uuid'>): string => item.shared_vault_uuid ?? 'user'
  const blobLocation = (item: StoredItem): string => `${owner(item)}/${item.uuid}`
  const currentItem = (uuid: string): DecryptedItemInterface =>
    storedItems.get(uuid) as unknown as DecryptedItemInterface
  const itemIsReadable = (uuid: string): boolean => {
    const item = storedItems.get(uuid)
    return item !== undefined && blobLocations.has(blobLocation(item))
  }

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    storedItems = new Map()
    blobLocations = new Set()
    destinationFailureFor = undefined

    const changeItem = jest.fn(
      async (
        item: DecryptedItemInterface,
        mutate?: (mutator: { key_system_identifier?: string; shared_vault_uuid?: string }) => void,
      ) => {
        const current = storedItems.get(item.uuid)
        if (!current) {
          throw new Error(`Missing test item ${item.uuid}`)
        }
        const metadata = {
          key_system_identifier: current.key_system_identifier,
          shared_vault_uuid: current.shared_vault_uuid,
        }
        mutate?.(metadata)
        const updated = { ...current, ...metadata }
        storedItems.set(item.uuid, updated)
        return updated as unknown as DecryptedItemInterface
      },
    )
    mutator = { changeItem } as unknown as jest.Mocked<MutatorClientInterface>

    sync = {} as jest.Mocked<SyncServiceInterface>
    sync.sync = jest.fn().mockResolvedValue(undefined)

    files = {} as jest.Mocked<FilesClientInterface>
    files.moveFileToSharedVault = jest.fn(async (file, vault) => {
      if (destinationFailureFor === file.uuid) {
        return new ClientDisplayableError(`Could not relocate ${file.uuid}`)
      }

      const source = `${file.shared_vault_uuid ?? 'user'}/${file.uuid}`
      const destination = `${vault.sharing.sharedVaultUuid}/${file.uuid}`
      if (!blobLocations.has(source)) {
        return blobLocations.has(destination) ? undefined : new ClientDisplayableError(`Missing source ${file.uuid}`)
      }
      blobLocations.add(destination)
      blobLocations.delete(source)
      return undefined
    })
    files.moveFileOutOfSharedVault = jest.fn(async (file) => {
      const source = `${file.shared_vault_uuid}/${file.uuid}`
      const destination = `user/${file.uuid}`
      if (!blobLocations.has(source)) {
        return blobLocations.has(destination) ? undefined : new ClientDisplayableError(`Missing source ${file.uuid}`)
      }
      blobLocations.add(destination)
      blobLocations.delete(source)
      return undefined
    })

    useCase = new MoveItemsToVault(mutator, sync, files)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const addItem = (item: StoredItem): DecryptedItemInterface => {
    storedItems.set(item.uuid, { ...item })
    if (item.content_type === ContentType.TYPES.File) {
      blobLocations.add(blobLocation(item))
    }
    return currentItem(item.uuid)
  }

  it('leaves metadata and the readable source untouched when destination relocation fails', async () => {
    const file = addItem({ uuid: 'file-fails', content_type: ContentType.TYPES.File })
    destinationFailureFor = file.uuid

    const result = await useCase.execute({ items: [file], vault: sharedVault })

    expect(result?.text).toBe('Could not relocate file-fails')
    expect(mutator.changeItem).not.toHaveBeenCalled()
    expect(sync.sync).not.toHaveBeenCalled()
    expect(storedItems.get(file.uuid)?.key_system_identifier).toBeUndefined()
    expect(storedItems.get(file.uuid)?.shared_vault_uuid).toBeUndefined()
    expect(itemIsReadable(file.uuid)).toBe(true)
    expect(blobLocations.has(`target-shared-vault/${file.uuid}`)).toBe(false)
  })

  it('keeps metadata at the readable destination after sync failure and converges after reload without another move', async () => {
    const file = addItem({ uuid: 'file-retry', content_type: ContentType.TYPES.File })
    sync.sync.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(undefined)

    const firstResult = await useCase.execute({ items: [file], vault: sharedVault })

    expect(firstResult?.text).toContain('operation can be retried')
    expect(storedItems.get(file.uuid)).toMatchObject({
      key_system_identifier: sharedVault.systemIdentifier,
      shared_vault_uuid: 'target-shared-vault',
    })
    expect(itemIsReadable(file.uuid)).toBe(true)
    expect(files.moveFileToSharedVault).toHaveBeenCalledTimes(1)

    const reloadedUseCase = new MoveItemsToVault(mutator, sync, files)
    const retryResult = await reloadedUseCase.execute({ items: [currentItem(file.uuid)], vault: sharedVault })

    expect(retryResult).toBeUndefined()
    expect(files.moveFileToSharedVault).toHaveBeenCalledTimes(1)
    expect(sync.sync).toHaveBeenCalledTimes(2)
    expect(itemIsReadable(file.uuid)).toBe(true)
  })

  it('commits readable partial progress, leaves the failed item at its source, and converges on batch retry', async () => {
    const firstFile = addItem({ uuid: 'file-first', content_type: ContentType.TYPES.File })
    const note = addItem({ uuid: 'note-middle', content_type: ContentType.TYPES.Note })
    const failedFile = addItem({
      uuid: 'file-last',
      content_type: ContentType.TYPES.File,
      key_system_identifier: 'source-key-system',
      shared_vault_uuid: 'source-shared-vault',
    })
    destinationFailureFor = failedFile.uuid

    const firstResult = await useCase.execute({ items: [firstFile, note, failedFile], vault: sharedVault })

    expect(firstResult?.text).toBe('Could not relocate file-last')
    expect(storedItems.get(firstFile.uuid)?.shared_vault_uuid).toBe('target-shared-vault')
    expect(storedItems.get(note.uuid)?.key_system_identifier).toBe(sharedVault.systemIdentifier)
    expect(storedItems.get(failedFile.uuid)).toMatchObject({
      key_system_identifier: 'source-key-system',
      shared_vault_uuid: 'source-shared-vault',
    })
    expect(itemIsReadable(firstFile.uuid)).toBe(true)
    expect(itemIsReadable(failedFile.uuid)).toBe(true)
    expect(sync.sync).toHaveBeenCalledTimes(2)

    destinationFailureFor = undefined
    const reloadedUseCase = new MoveItemsToVault(mutator, sync, files)
    const retryResult = await reloadedUseCase.execute({
      items: [currentItem(firstFile.uuid), currentItem(note.uuid), currentItem(failedFile.uuid)],
      vault: sharedVault,
    })

    expect(retryResult).toBeUndefined()
    expect(storedItems.get(failedFile.uuid)?.shared_vault_uuid).toBe('target-shared-vault')
    expect(itemIsReadable(failedFile.uuid)).toBe(true)
    expect(files.moveFileToSharedVault).toHaveBeenCalledTimes(3)
  })

  it('uses the original shared-vault context when moving a file back to user storage', async () => {
    const privateVault = {
      systemIdentifier: 'private-target-key-system',
      isSharedVaultListing: () => false,
    } as VaultListingInterface
    const file = addItem({
      uuid: 'file-out',
      content_type: ContentType.TYPES.File,
      key_system_identifier: 'shared-source-key-system',
      shared_vault_uuid: 'shared-source-vault',
    })

    const result = await useCase.execute({ items: [file], vault: privateVault })

    expect(result).toBeUndefined()
    expect(files.moveFileOutOfSharedVault).toHaveBeenCalledWith(
      expect.objectContaining({ shared_vault_uuid: 'shared-source-vault' }),
    )
    expect(storedItems.get(file.uuid)).toMatchObject({
      key_system_identifier: privateVault.systemIdentifier,
      shared_vault_uuid: undefined,
    })
    expect(itemIsReadable(file.uuid)).toBe(true)
  })
})
