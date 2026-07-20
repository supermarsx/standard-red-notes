import { FileBackupsConstantsV1 } from './FileBackupsConstantsV1'

/**
 * These names are the on-disk layout of a v1 file backup directory. Changing any of them makes
 * previously written backups unreadable, so they are pinned here.
 */
describe('FileBackupsConstantsV1', () => {
  it('should pin the v1 backup layout', () => {
    expect(FileBackupsConstantsV1.Version).toBe('1.0.0')
    expect(FileBackupsConstantsV1.MetadataFileName).toBe('metadata.sn.json')
    expect(FileBackupsConstantsV1.BinaryFileName).toBe('file.encrypted')
  })
})
