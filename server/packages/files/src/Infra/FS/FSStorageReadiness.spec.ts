import { constants } from 'fs'

import { FSStorageReadiness } from './FSStorageReadiness'

describe('FSStorageReadiness', () => {
  it('requires the configured upload root to be readable and writable without mutating it', async () => {
    const access = jest.fn().mockResolvedValue(undefined)
    const statfs = jest.fn().mockResolvedValue({ bavail: 1n })

    await new FSStorageReadiness('/data/uploads', access, statfs).check()

    expect(access).toHaveBeenCalledWith('/data/uploads', constants.R_OK | constants.W_OK)
    expect(statfs).toHaveBeenCalledWith('/data/uploads')
  })

  it('propagates an inaccessible upload root', async () => {
    const access = jest.fn().mockRejectedValue(new Error('permission denied'))

    await expect(new FSStorageReadiness('/data/uploads', access, jest.fn()).check()).rejects.toThrow(
      'permission denied',
    )
  })

  it.each([0, 0n])('fails closed when the filesystem reports %s available blocks', async (bavail) => {
    const readiness = new FSStorageReadiness(
      '/data/uploads',
      jest.fn().mockResolvedValue(undefined),
      jest.fn().mockResolvedValue({ bavail }),
    )

    await expect(readiness.check()).rejects.toThrow('no available blocks')
  })
})
