import { FileDownloadProgress, fileProgressToHumanReadableString } from './FileDownloadProgress'

const progressAt = (percentComplete: number, source: FileDownloadProgress['source']): FileDownloadProgress => ({
  encryptedFileSize: 100,
  encryptedBytesDownloaded: percentComplete,
  encryptedBytesRemaining: 100 - percentComplete,
  percentComplete,
  source,
})

describe('fileProgressToHumanReadableString', () => {
  it('should omit the source phrase for a network download', () => {
    expect(fileProgressToHumanReadableString(progressAt(10, 'network'), 'note.txt', { showPercent: false })).toBe(
      'Downloading file  "note.txt"',
    )
  })

  it('should say "from cache" for a memcache download', () => {
    expect(fileProgressToHumanReadableString(progressAt(10, 'memcache'), 'note.txt', { showPercent: false })).toBe(
      'Downloading file from cache "note.txt"',
    )
  })

  it('should say "from backup" for a local download', () => {
    expect(fileProgressToHumanReadableString(progressAt(10, 'local'), 'note.txt', { showPercent: false })).toBe(
      'Downloading file from backup "note.txt"',
    )
  })

  it('should append the percentage when asked', () => {
    expect(fileProgressToHumanReadableString(progressAt(42, 'network'), 'note.txt', { showPercent: true })).toBe(
      'Downloading file  "note.txt" (42%)',
    )
  })

  it('should floor a fractional percentage rather than round it', () => {
    expect(fileProgressToHumanReadableString(progressAt(42.9, 'local'), 'note.txt', { showPercent: true })).toBe(
      'Downloading file from backup "note.txt" (42%)',
    )
  })
})
