import { ContentType } from '@standardnotes/snjs'

import { deleteLargestItem } from './storageItemActions'

jest.mock('@standardnotes/toast', () => ({
  ToastType: {
    Error: 'error',
    Loading: 'loading',
    Success: 'success',
  },
  addToast: jest.fn(),
  dismissToast: jest.fn(),
}))

jest.mock('@/Utils/NoteExportUtils', () => ({
  createNoteExport: jest.fn(),
}))

const row = (contentType: string) => ({
  uuid: 'item-uuid',
  contentType,
  title: 'Item',
  bytes: 1024,
})

const applicationWithItem = (contentType: string) => {
  const deleteItems = jest.fn().mockResolvedValue(undefined)
  const deleteFile = jest.fn().mockResolvedValue(undefined)
  const sync = jest.fn().mockResolvedValue(undefined)

  return {
    application: {
      items: {
        findItem: jest.fn().mockReturnValue({
          uuid: 'item-uuid',
          content_type: contentType,
        }),
      },
      mutator: { deleteItems },
      files: { deleteFile },
      sync: { sync },
    } as never,
    deleteItems,
    deleteFile,
    sync,
  }
}

describe('deleteLargestItem', () => {
  it.each([
    ContentType.TYPES.ItemsKey,
    ContentType.TYPES.KeySystemItemsKey,
    ContentType.TYPES.KeySystemRootKey,
    ContentType.TYPES.UserPrefs,
    ContentType.TYPES.VaultListing,
    ContentType.TYPES.Tag,
  ])('refuses generic deletion of protected app record %s', async (contentType) => {
    const { application, deleteItems, deleteFile, sync } = applicationWithItem(contentType)

    await expect(deleteLargestItem(application, row(contentType))).resolves.toBe(false)
    expect(deleteItems).not.toHaveBeenCalled()
    expect(deleteFile).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('keeps the established note deletion path available', async () => {
    const { application, deleteItems, sync } = applicationWithItem(ContentType.TYPES.Note)

    await expect(deleteLargestItem(application, row(ContentType.TYPES.Note))).resolves.toBe(true)
    expect(deleteItems).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the scanned row type and live item type disagree', async () => {
    const { application, deleteItems, sync } = applicationWithItem(ContentType.TYPES.ItemsKey)

    await expect(deleteLargestItem(application, row(ContentType.TYPES.Note))).resolves.toBe(false)
    expect(deleteItems).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })
})
