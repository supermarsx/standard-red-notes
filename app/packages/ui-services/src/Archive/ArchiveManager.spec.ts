import { Result } from '@standardnotes/domain-core'

import { ArchiveManager } from './ArchiveManager'

describe('ArchiveManager.downloadBackup', () => {
  it.each([
    ['encrypted', true],
    ['decrypted', false],
  ])('rejects instead of silently succeeding when %s backup creation fails', async (_label, encrypted) => {
    const failure = Result.fail('Backup creation stopped because an item was unavailable.')
    const application = {
      createEncryptedBackupFile: {
        execute: jest.fn().mockResolvedValue(failure),
      },
      createDecryptedBackupFile: {
        execute: jest.fn().mockResolvedValue(failure),
      },
    }
    const archive = new ArchiveManager(application as never)
    const downloadSpy = jest.spyOn(archive, 'downloadData')

    await expect(archive.downloadBackup(encrypted)).rejects.toThrow(
      'Backup creation stopped because an item was unavailable.',
    )
    expect(downloadSpy).not.toHaveBeenCalled()
  })
})
