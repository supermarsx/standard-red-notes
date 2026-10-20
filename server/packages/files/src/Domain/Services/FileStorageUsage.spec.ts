import { FileStorageUsage } from './FileStorageUsage'
import { FileDownloaderInterface } from './FileDownloaderInterface'

describe('FileStorageUsage', () => {
  const create = (listFiles: jest.Mock) =>
    new FileStorageUsage({ listFiles } as unknown as FileDownloaderInterface, 'authority-secret')

  it('counts personal files and owned vaults once, including zero-byte files', async () => {
    const listFiles = jest.fn(async (owner: string) =>
      owner === 'user'
        ? [{ name: 'personal', size: 12 }]
        : [
            { name: 'vault', size: 24 },
            { name: 'empty', size: 0 },
          ],
    )
    await expect(
      create(listFiles).measure({ userUuid: 'user', vaultUuids: ['vault', 'user', 'vault'] }),
    ).resolves.toEqual({
      bytes: 36,
      count: 3,
      complete: true,
    })
    expect(listFiles.mock.calls).toEqual([['user'], ['vault']])
  })

  it('reports measured zero only when listing succeeds with no files', async () => {
    await expect(
      create(jest.fn().mockResolvedValue([])).measure({ userUuid: 'user', vaultUuids: [] }),
    ).resolves.toEqual({
      bytes: 0,
      count: 0,
      complete: true,
    })
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an unavailable or inexact file size: %s',
    async (size) => {
      await expect(
        create(jest.fn().mockResolvedValue([{ name: 'file', size }])).measure({ userUuid: 'user', vaultUuids: [] }),
      ).rejects.toThrow('File size unavailable')
    },
  )

  it('refuses a sum that exceeds the exact numeric range', async () => {
    const listFiles = jest.fn().mockResolvedValue([
      { name: 'large', size: Number.MAX_SAFE_INTEGER },
      { name: 'extra', size: 1 },
    ])
    await expect(create(listFiles).measure({ userUuid: 'user', vaultUuids: [] })).rejects.toThrow(
      'Storage total exceeds exact numeric range',
    )
  })

  it('propagates a failed vault listing rather than reporting a partial total as complete', async () => {
    const failure = new Error('listing unavailable')
    const listFiles = jest
      .fn()
      .mockResolvedValueOnce([{ name: 'personal', size: 12 }])
      .mockRejectedValueOnce(failure)
    await expect(create(listFiles).measure({ userUuid: 'user', vaultUuids: ['vault'] })).rejects.toBe(failure)
  })
})
