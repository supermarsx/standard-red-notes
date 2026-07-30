import { FileContent } from '@standardnotes/models'

import { DownloadFileParams } from '../Api/DownloadFileParams'
import { FilesApiInterface } from '../Api/FilesApiInterface'
import { FileDownloader } from './FileDownloader'

describe('file downloader', () => {
  let apiService: FilesApiInterface
  let downloader: FileDownloader
  let file: {
    uuid: string
    shared_vault_uuid: string | undefined
    encryptedChunkSizes: FileContent['encryptedChunkSizes']
    remoteIdentifier: FileContent['remoteIdentifier']
  }

  const numChunks = 5

  const downloadFiveBytes = async (params: DownloadFileParams): Promise<undefined> => {
    for (let i = 0; i < numChunks; i++) {
      await params.onBytesReceived(Uint8Array.from([0xaa]))
    }

    return undefined
  }

  beforeEach(() => {
    apiService = {} as jest.Mocked<FilesApiInterface>
    apiService.createUserFileValetToken = jest.fn()
    apiService.downloadFile = jest.fn().mockImplementation(downloadFiveBytes)

    file = {
      uuid: '123',
      shared_vault_uuid: undefined,
      encryptedChunkSizes: [5],
      remoteIdentifier: '123',
    }
  })

  it('downloads as a user when the file is not in a shared vault', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')

    await downloader.run(async () => undefined)

    expect(apiService.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipType: 'user', valetToken: 'valet-token' }),
    )
  })

  it('downloads as a shared vault when the file belongs to one', async () => {
    downloader = new FileDownloader({ ...file, shared_vault_uuid: 'vault-1' }, apiService, 'valet-token')

    await downloader.run(async () => undefined)

    expect(apiService.downloadFile).toHaveBeenCalledWith(expect.objectContaining({ ownershipType: 'shared-vault' }))
  })

  it('reports finite progress against the total encrypted size', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')

    const progresses: number[] = []
    await downloader.run(async (_bytes, progress) => {
      progresses.push(progress.percentComplete)
    })

    expect(progresses).toEqual([20, 40, 60, 80, 100])
  })

  it('clamps progress and remaining bytes when the server sends more than the declared size', async () => {
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [4] }, apiService, 'valet-token')

    const progresses: Array<{ percentComplete: number; remaining: number }> = []
    await downloader.run(async (_bytes, progress) => {
      progresses.push({
        percentComplete: progress.percentComplete,
        remaining: progress.encryptedBytesRemaining,
      })
    })

    expect(progresses[progresses.length - 1]).toEqual({ percentComplete: 100, remaining: 0 })
  })

  it('reports an empty encrypted file as complete without dividing by zero', async () => {
    apiService.downloadFile = jest.fn().mockImplementation(async (params: DownloadFileParams) => {
      await params.onBytesReceived(new Uint8Array())

      return undefined
    })
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [] }, apiService, 'valet-token')

    const progresses: number[] = []
    await downloader.run(async (_bytes, progress) => {
      progresses.push(progress.percentComplete)
      expect(progress.encryptedFileSize).toBe(0)
      expect(progress.encryptedBytesRemaining).toBe(0)
    })

    expect(progresses).toEqual([100])
    expect(Number.isFinite(progresses[0])).toBe(true)
  })

  it('passes a bound abort callback and resolves the active run as aborted', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')

    let chunksSeen = 0
    const result = await downloader.run(async (_bytes, _progress, abort) => {
      chunksSeen++
      abort()
      await Promise.resolve()
    })

    expect(chunksSeen).toEqual(1)
    expect(result).toEqual('aborted')
  })

  it('stops forwarding bytes once publicly aborted', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')

    let chunksSeen = 0
    const result = await downloader.run(async () => {
      chunksSeen++
      downloader.abort()
      await Promise.resolve()
    })

    expect(chunksSeen).toEqual(1)
    expect(result).toEqual('aborted')
  })

  it('passes back bytes as they are received', async () => {
    let receivedBytes = new Uint8Array()
    downloader = new FileDownloader(file, apiService, 'valet-token')

    await downloader.run(async (encryptedBytes) => {
      receivedBytes = new Uint8Array([...receivedBytes, ...encryptedBytes])
    })

    expect(receivedBytes.length).toEqual(numChunks)
  })

  it('does not let an idle abort poison a later run', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')
    downloader.abort()

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const result = await downloader.run(onBytes)

    expect(result).toBeUndefined()
    expect(onBytes).toHaveBeenCalledTimes(numChunks)
  })

  it('resets progress between sequential runs', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')

    const firstRunProgress: number[] = []
    const secondRunProgress: number[] = []
    await downloader.run(async (_bytes, progress) => {
      firstRunProgress.push(progress.percentComplete)
    })
    await downloader.run(async (_bytes, progress) => {
      secondRunProgress.push(progress.percentComplete)
    })

    expect(firstRunProgress).toEqual([20, 40, 60, 80, 100])
    expect(secondRunProgress).toEqual(firstRunProgress)
  })

  it('does not let an old run abort a reused downloader', async () => {
    let staleAbort: (() => void) | undefined
    apiService.downloadFile = jest
      .fn()
      .mockImplementationOnce(async (params: DownloadFileParams) => {
        await params.onBytesReceived(Uint8Array.from([0xaa]))
        await new Promise(() => undefined)
      })
      .mockImplementationOnce(async (params: DownloadFileParams) => {
        await params.onBytesReceived(Uint8Array.from([0xbb]))

        return undefined
      })
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [1] }, apiService, 'valet-token')

    const firstResult = await downloader.run(async (_bytes, _progress, abort) => {
      staleAbort = abort
      abort()
    })
    const secondResult = await downloader.run(async () => {
      staleAbort?.()
    })

    expect(firstResult).toBe('aborted')
    expect(secondResult).toBeUndefined()
  })

  it('rejects concurrent runs without starting a second request', async () => {
    apiService.downloadFile = jest.fn().mockImplementation(() => new Promise(() => undefined))
    downloader = new FileDownloader(file, apiService, 'valet-token')

    const firstRun = downloader.run(async () => undefined)
    await expect(downloader.run(async () => undefined)).rejects.toThrow(
      'FileDownloader cannot run more than one download at a time',
    )
    expect(apiService.downloadFile).toHaveBeenCalledTimes(1)

    downloader.abort()
    await expect(firstRun).resolves.toBe('aborted')
  })

  it('can be reused after the API rejects', async () => {
    apiService.downloadFile = jest
      .fn()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockImplementationOnce(downloadFiveBytes)
    downloader = new FileDownloader(file, apiService, 'valet-token')

    await expect(downloader.run(async () => undefined)).rejects.toThrow('network failed')
    await expect(downloader.run(async () => undefined)).resolves.toBeUndefined()
  })
})
