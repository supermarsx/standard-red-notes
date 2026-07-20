import { FileContent } from '@standardnotes/models'
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

  beforeEach(() => {
    apiService = {} as jest.Mocked<FilesApiInterface>
    apiService.createUserFileValetToken = jest.fn()
    apiService.downloadFile = jest
      .fn()
      .mockImplementation(
        (params: {
          _file: string
          _chunkIndex: number
          _apiToken: string
          _rangeStart: number
          onBytesReceived: (bytes: Uint8Array) => void
        }) => {
          return new Promise<void>((resolve) => {
            for (let i = 0; i < numChunks; i++) {
              params.onBytesReceived(Uint8Array.from([0xaa]))
            }

            resolve()
          })
        },
      )

    file = {
      uuid: '123',
      shared_vault_uuid: undefined,
      encryptedChunkSizes: [100_000],
      remoteIdentifier: '123',
    }
  })

  it('should download as a user when the file is not in a shared vault', async () => {
    downloader = new FileDownloader(file, apiService, 'valet-token')

    // eslint-disable-next-line @typescript-eslint/require-await
    await downloader.run(async () => undefined)

    expect(apiService.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ ownershipType: 'user', valetToken: 'valet-token' }),
    )
  })

  it('should download as a shared vault when the file belongs to one', async () => {
    downloader = new FileDownloader({ ...file, shared_vault_uuid: 'vault-1' }, apiService, 'valet-token')

    // eslint-disable-next-line @typescript-eslint/require-await
    await downloader.run(async () => undefined)

    expect(apiService.downloadFile).toHaveBeenCalledWith(expect.objectContaining({ ownershipType: 'shared-vault' }))
  })

  it('should report progress against the total encrypted size', async () => {
    downloader = new FileDownloader({ ...file, encryptedChunkSizes: [4] }, apiService, 'valet-token')

    const progresses: number[] = []
    // eslint-disable-next-line @typescript-eslint/require-await
    await downloader.run(async (_bytes, progress) => {
      progresses.push(progress.percentComplete)
    })

    expect(progresses).toEqual([25, 50, 75, 100, 125])
  })

  it('should stop forwarding bytes once aborted and resolve with "aborted"', async () => {
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

  it('should pass back bytes as they are received', async () => {
    let receivedBytes = new Uint8Array()

    downloader = new FileDownloader(file, apiService, 'valet-token')

    expect(receivedBytes.length).toBe(0)

    // eslint-disable-next-line @typescript-eslint/require-await
    await downloader.run(async (encryptedBytes) => {
      receivedBytes = new Uint8Array([...receivedBytes, ...encryptedBytes])
    })

    expect(receivedBytes.length).toEqual(numChunks)
  })
})
