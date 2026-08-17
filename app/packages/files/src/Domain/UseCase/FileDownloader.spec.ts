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
      encryptedChunkSizes: [1, 1, 1, 1, 1],
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

  it('rejects an oversized chunk instead of hiding the overrun in clamped progress', async () => {
    apiService.downloadFile = jest.fn().mockImplementation(async (params: DownloadFileParams) => {
      await params.onBytesReceived(Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]))
      return undefined
    })
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [4] }, apiService, 'valet-token')

    const onBytes = jest.fn().mockResolvedValue(undefined)
    const result = await downloader.run(onBytes)

    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('had 5 bytes; expected 4') }))
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('rejects empty encrypted metadata because it cannot contain an authenticated final chunk', async () => {
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [] }, apiService, 'valet-token')

    const result = await downloader.run(jest.fn())

    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('authenticated encrypted chunk') }))
    expect(apiService.downloadFile).not.toHaveBeenCalled()
  })

  it.each([{ chunkSizes: [0] }, { chunkSizes: [-1] }, { chunkSizes: [1.5] }, { chunkSizes: [Number.NaN] }])(
    'rejects invalid encrypted chunk sizes $chunkSizes',
    async ({ chunkSizes }) => {
      downloader = new FileDownloader({ ...file, encryptedChunkSizes: chunkSizes }, apiService, 'valet-token')

      const result = await downloader.run(jest.fn())

      expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('invalid encrypted chunk size') }))
      expect(apiService.downloadFile).not.toHaveBeenCalled()
    },
  )

  it('rejects encrypted metadata whose aggregate exceeds a safe integer', async () => {
    downloader = new FileDownloader(
      { ...file, encryptedChunkSizes: [Number.MAX_SAFE_INTEGER, 1] },
      apiService,
      'valet-token',
    )

    const result = await downloader.run(jest.fn())

    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('supported encrypted size') }))
    expect(apiService.downloadFile).not.toHaveBeenCalled()
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
    const request = (apiService.downloadFile as jest.Mock).mock.calls[0][0] as DownloadFileParams
    expect(request.abortSignal?.aborted).toBe(true)
  })

  it('passes back bytes as they are received', async () => {
    let receivedBytes = new Uint8Array()
    downloader = new FileDownloader(file, apiService, 'valet-token')

    await downloader.run(async (encryptedBytes) => {
      receivedBytes = new Uint8Array([...receivedBytes, ...encryptedBytes])
    })

    expect(receivedBytes.length).toEqual(numChunks)
  })

  it('rejects a truncated chunk before forwarding it', async () => {
    apiService.downloadFile = jest.fn().mockImplementation(async (params: DownloadFileParams) => {
      await params.onBytesReceived(Uint8Array.from([0xaa]))
      return undefined
    })
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [2] }, apiService, 'valet-token')
    const onBytes = jest.fn().mockResolvedValue(undefined)

    const result = await downloader.run(onBytes)

    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('had 1 bytes; expected 2') }))
    expect(onBytes).not.toHaveBeenCalled()
  })

  it('rejects a download that ends before all declared encrypted chunks arrive', async () => {
    apiService.downloadFile = jest.fn().mockImplementation(async (params: DownloadFileParams) => {
      await params.onBytesReceived(Uint8Array.from([0xaa]))
      return undefined
    })
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [1, 1] }, apiService, 'valet-token')

    const result = await downloader.run(jest.fn().mockResolvedValue(undefined))

    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('after 1 of 2 encrypted chunks') }))
  })

  it('rejects bytes delivered after all declared encrypted chunks', async () => {
    apiService.downloadFile = jest.fn().mockImplementation(async (params: DownloadFileParams) => {
      await params.onBytesReceived(Uint8Array.from([0xaa]))
      await params.onBytesReceived(Uint8Array.from([0xbb]))
      return undefined
    })
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [1] }, apiService, 'valet-token')
    const onBytes = jest.fn().mockResolvedValue(undefined)

    const result = await downloader.run(onBytes)

    expect(result).toEqual(expect.objectContaining({ text: expect.stringContaining('beyond its encrypted metadata') }))
    expect(onBytes).toHaveBeenCalledTimes(1)
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
