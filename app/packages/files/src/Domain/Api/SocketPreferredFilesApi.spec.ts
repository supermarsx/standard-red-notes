import { ClientDisplayableError } from '@standardnotes/responses'

import { DownloadFileParams } from './DownloadFileParams'
import { FilesApiInterface } from './FilesApiInterface'
import {
  FileSocketTransportInterface,
  SocketFileDownloadOutcome,
  SocketFileDownloadRequest,
  SocketFileUploadOpenOutcome,
  SocketFileUploadRequest,
  SocketFileUploadSession,
} from './FileSocketTransportInterface'
import { SocketPreferredFilesApi } from './SocketPreferredFilesApi'

const REMOTE_IDENTIFIER = 'remote-identifier-9f3c.a:b-1'
const FILE_UUID = '11111111-1111-4111-8111-111111111111'
const VAULT_UUID = '22222222-2222-4222-8222-222222222222'
const VAULT_OWNER_UUID = '33333333-3333-4333-8333-333333333333'

describe('SocketPreferredFilesApi', () => {
  let http: jest.Mocked<FilesApiInterface>
  let laneAvailable: boolean
  let socketRequests: SocketFileDownloadRequest[]
  let socketOutcome: (request: SocketFileDownloadRequest) => Promise<SocketFileDownloadOutcome>
  let socket: FileSocketTransportInterface
  let received: Uint8Array[]
  let uploadRequests: SocketFileUploadRequest[]
  let uploadOutcome: (request: SocketFileUploadRequest) => Promise<SocketFileUploadOpenOutcome>
  let uploadSession: SocketFileUploadSession

  const params = (overrides: Partial<DownloadFileParams> = {}): DownloadFileParams => ({
    file: {
      uuid: FILE_UUID,
      remoteIdentifier: REMOTE_IDENTIFIER,
      encryptedChunkSizes: [4, 4, 2],
      shared_vault_uuid: undefined,
    },
    chunkIndex: 0,
    valetToken: 'valet-token',
    ownershipType: 'user',
    contentRangeStart: 0,
    onBytesReceived: async (bytes) => {
      received.push(bytes)
    },
    ...overrides,
  })

  const sharedVaultParams = (overrides: Partial<DownloadFileParams> = {}): DownloadFileParams =>
    params({
      ownershipType: 'shared-vault',
      file: {
        uuid: FILE_UUID,
        remoteIdentifier: REMOTE_IDENTIFIER,
        encryptedChunkSizes: [4, 4, 2],
        shared_vault_uuid: VAULT_UUID,
      },
      ...overrides,
    })

  const subject = (resolveOwner?: (sharedVaultUuid: string) => string | undefined) =>
    new SocketPreferredFilesApi(http, socket, resolveOwner)

  const openedPosition = {
    transferId: 'transfer-1',
    generation: 1,
    resumeId: 'resume-1',
    nextIndex: 0,
    nextOffset: 0,
    declaredSize: 17,
    maxFrameBytes: 256 * 1024,
  }

  const uploadParams = (overrides: Record<string, unknown> = {}) => ({
    remoteIdentifier: REMOTE_IDENTIFIER,
    fileUuid: FILE_UUID,
    ownershipType: 'user' as const,
    decryptedSize: 10,
    declaredSize: 27,
    mimeType: 'application/octet-stream',
    ...overrides,
  })

  beforeEach(() => {
    received = []
    laneAvailable = false
    socketRequests = []
    uploadRequests = []
    uploadSession = {
      sendChunk: jest.fn(),
      finish: jest.fn(),
      cancel: jest.fn(),
    }
    uploadOutcome = async () => ({ outcome: 'opened', position: openedPosition, session: uploadSession })
    socketOutcome = async () => ({ outcome: 'unavailable' })
    http = {
      createUserFileValetToken: jest.fn().mockResolvedValue('token'),
      startUploadSession: jest.fn().mockResolvedValue({ status: 200, data: {} }),
      uploadFileBytes: jest.fn().mockResolvedValue(true),
      closeUploadSession: jest.fn().mockResolvedValue(true),
      downloadFile: jest.fn().mockResolvedValue(undefined),
      moveFile: jest.fn().mockResolvedValue(true),
      deleteFile: jest.fn().mockResolvedValue({ status: 200, data: {} }),
      getFilesDownloadUrl: jest.fn().mockReturnValue('https://files.example.test/v1/download'),
    } as unknown as jest.Mocked<FilesApiInterface>
    socket = {
      isFileLaneAvailable: () => laneAvailable,
      downloadFileOverSocket: async (request) => {
        socketRequests.push(request)
        return socketOutcome(request)
      },
      uploadFileOverSocket: async (request) => {
        uploadRequests.push(request)
        return uploadOutcome(request)
      },
    }
  })

  describe('capability absent — the configuration nearly every deployment runs', () => {
    it('downloads over HTTP with the request untouched and never consults the socket', async () => {
      const consulted = jest.fn()
      socket = {
        isFileLaneAvailable: () => false,
        downloadFileOverSocket: async (request) => {
          consulted()
          socketRequests.push(request)
          return { outcome: 'unavailable' }
        },
        uploadFileOverSocket: async (request) => {
          consulted()
          uploadRequests.push(request)
          return { outcome: 'unavailable' }
        },
      }
      const request = params()

      await expect(subject().downloadFile(request)).resolves.toBeUndefined()

      expect(http.downloadFile).toHaveBeenCalledTimes(1)
      expect(http.downloadFile).toHaveBeenCalledWith(request)
      expect(consulted).not.toHaveBeenCalled()
      expect(socketRequests).toHaveLength(0)
    })

    it('propagates the HTTP result verbatim, including its errors', async () => {
      const failure = new ClientDisplayableError('network is down')
      http.downloadFile.mockResolvedValue(failure)

      await expect(subject().downloadFile(params())).resolves.toBe(failure)
    })

    it('leaves every non-download operation on HTTP even when the lane is available', async () => {
      laneAvailable = true
      const api = subject()

      await api.startUploadSession('valet', 'user')
      await api.uploadFileBytes('valet', 'user', 1, Uint8Array.from([1]))
      await api.closeUploadSession('valet', 'user')
      await api.deleteFile('valet', 'user')
      await api.moveFile('valet')
      api.getFilesDownloadUrl('user')

      expect(http.startUploadSession).toHaveBeenCalledTimes(1)
      expect(http.uploadFileBytes).toHaveBeenCalledTimes(1)
      expect(http.closeUploadSession).toHaveBeenCalledTimes(1)
      expect(http.deleteFile).toHaveBeenCalledTimes(1)
      expect(http.moveFile).toHaveBeenCalledTimes(1)
      expect(http.getFilesDownloadUrl).toHaveBeenCalledTimes(1)
      expect(socketRequests).toHaveLength(0)
    })
  })

  describe('requests the lane cannot represent stay on HTTP', () => {
    beforeEach(() => {
      laneAvailable = true
    })

    it('sends a shared-vault download over HTTP when the vault owner is not known locally', async () => {
      // The vault has not synced yet, so there is no owner to name. Guessing one
      // would fail closed server-side and read as a permissions bug.
      await subject(() => undefined).downloadFile(sharedVaultParams())

      expect(http.downloadFile).toHaveBeenCalledTimes(1)
      expect(socketRequests).toHaveLength(0)
    })

    it('sends a shared-vault download over HTTP when no owner resolver is installed at all', async () => {
      await subject().downloadFile(sharedVaultParams())

      expect(http.downloadFile).toHaveBeenCalledTimes(1)
      expect(socketRequests).toHaveLength(0)
    })

    it('sends a resumed range over HTTP rather than restarting it as a whole file', async () => {
      await subject().downloadFile(params({ chunkIndex: 1, contentRangeStart: 4 }))

      expect(http.downloadFile).toHaveBeenCalledTimes(1)
      expect(socketRequests).toHaveLength(0)
    })

    it('sends a download whose caller already aborted over HTTP', async () => {
      await subject().downloadFile(params({ shouldAbort: () => true }))

      expect(http.downloadFile).toHaveBeenCalledTimes(1)
      expect(socketRequests).toHaveLength(0)
    })
  })

  describe('capability advertised', () => {
    beforeEach(() => {
      laneAvailable = true
    })

    it('forwards remoteIdentifier and the file uuid byte-identically', async () => {
      socketOutcome = async (request) => {
        await request.onBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
        return { outcome: 'completed', sha256: 'a'.repeat(64) }
      }

      await expect(subject().downloadFile(params())).resolves.toBeUndefined()

      expect(socketRequests).toHaveLength(1)
      expect(socketRequests[0].remoteIdentifier).toBe(REMOTE_IDENTIFIER)
      expect(socketRequests[0].fileUuid).toBe(FILE_UUID)
      expect(socketRequests[0].declaredSize).toBe(10)
      expect(http.downloadFile).not.toHaveBeenCalled()
    })

    it('re-cuts arbitrary socket frames into the file’s declared encrypted chunk sizes', async () => {
      socketOutcome = async (request) => {
        // Deliberately misaligned with [4, 4, 2]: the transport frame size has
        // nothing to do with the encrypted chunk boundaries.
        await request.onBytes(Uint8Array.from([1, 2, 3]))
        await request.onBytes(Uint8Array.from([4, 5, 6, 7, 8]))
        await request.onBytes(Uint8Array.from([9, 10]))
        return { outcome: 'completed', sha256: 'a'.repeat(64) }
      }

      await expect(subject().downloadFile(params())).resolves.toBeUndefined()

      expect(received.map((chunk) => [...chunk])).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10],
      ])
    })

    it('names a shared-vault resource with the owner the vault listing records', async () => {
      const resolve = jest.fn().mockReturnValue(VAULT_OWNER_UUID)
      socketOutcome = async (request) => {
        await request.onBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
        return { outcome: 'completed', sha256: 'a'.repeat(64) }
      }

      await expect(subject(resolve).downloadFile(sharedVaultParams())).resolves.toBeUndefined()

      expect(resolve).toHaveBeenCalledWith(VAULT_UUID)
      expect(socketRequests[0].sharedVault).toEqual({
        sharedVaultUuid: VAULT_UUID,
        sharedVaultOwnerUuid: VAULT_OWNER_UUID,
      })
      // The identifier is the decryptor's AAD on this path exactly as on the
      // personal one — shared ownership changes who may read it, not what it is.
      expect(socketRequests[0].remoteIdentifier).toBe(REMOTE_IDENTIFIER)
      expect(http.downloadFile).not.toHaveBeenCalled()
    })

    it('never attaches a vault reference to a personal file', async () => {
      const resolve = jest.fn().mockReturnValue(VAULT_OWNER_UUID)
      socketOutcome = async (request) => {
        await request.onBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
        return { outcome: 'completed', sha256: 'a'.repeat(64) }
      }

      await subject(resolve).downloadFile(params())

      expect(resolve).not.toHaveBeenCalled()
      expect(socketRequests[0].sharedVault).toBeUndefined()
    })

    it('reports a transfer that completed short of its declared size', async () => {
      socketOutcome = async (request) => {
        await request.onBytes(Uint8Array.from([1, 2, 3, 4]))
        return { outcome: 'completed', sha256: 'a'.repeat(64) }
      }

      const result = await subject().downloadFile(params())

      expect(result).toBeInstanceOf(ClientDisplayableError)
      expect(http.downloadFile).not.toHaveBeenCalled()
    })

    it('treats an aborted transfer as a cancellation, not a failure', async () => {
      socketOutcome = async () => ({ outcome: 'aborted' })

      await expect(subject().downloadFile(params())).resolves.toBeUndefined()
      expect(http.downloadFile).not.toHaveBeenCalled()
    })
  })

  describe('fallback never replays bytes into the decryptor', () => {
    beforeEach(() => {
      laneAvailable = true
    })

    it('falls back to HTTP when the lane disappears before anything is delivered', async () => {
      socketOutcome = async () => ({ outcome: 'unavailable' })

      await expect(subject().downloadFile(params())).resolves.toBeUndefined()
      expect(http.downloadFile).toHaveBeenCalledTimes(1)
    })

    it('falls back to HTTP when a failure is proven to have delivered nothing', async () => {
      socketOutcome = async () => ({
        outcome: 'failed',
        code: 'FILE_BACKEND_ERROR',
        retryable: true,
        safeToFallback: true,
      })

      await expect(subject().downloadFile(params())).resolves.toBeUndefined()
      expect(http.downloadFile).toHaveBeenCalledTimes(1)
      expect(received).toHaveLength(0)
    })

    it('refuses to fall back once bytes have reached the decryptor, even if the transport says it is safe', async () => {
      socketOutcome = async (request) => {
        await request.onBytes(Uint8Array.from([1, 2, 3, 4]))
        return { outcome: 'failed', code: 'SOCKET_CLOSED', retryable: true, safeToFallback: true }
      }

      const result = await subject().downloadFile(params())

      // Restarting over HTTP would hand the decryptor chunk 0 a second time.
      expect(result).toBeInstanceOf(ClientDisplayableError)
      expect(http.downloadFile).not.toHaveBeenCalled()
      expect(received).toHaveLength(1)
    })

    it('refuses to fall back when the transport itself reports the failure as unsafe', async () => {
      socketOutcome = async () => ({
        outcome: 'failed',
        code: 'FILE_INTEGRITY_MISMATCH',
        retryable: false,
        safeToFallback: false,
      })

      const result = await subject().downloadFile(params())

      expect(result).toBeInstanceOf(ClientDisplayableError)
      expect(http.downloadFile).not.toHaveBeenCalled()
    })
  })

  describe('openSocketUpload', () => {
    it('does not consult the socket at all when the lane is absent', async () => {
      laneAvailable = false

      await expect(subject().openSocketUpload(uploadParams())).resolves.toBeUndefined()

      expect(uploadRequests).toHaveLength(0)
    })

    it('forwards the planned ENCRYPTED total as declaredSize, and the plaintext length separately', async () => {
      laneAvailable = true

      const opened = await subject().openSocketUpload(
        uploadParams({ decryptedSize: 5_000_001, declaredSize: 5_000_035 }),
      )

      expect(opened).toEqual({ position: openedPosition, session: uploadSession })
      expect(uploadRequests).toEqual([
        {
          remoteIdentifier: REMOTE_IDENTIFIER,
          fileUuid: FILE_UUID,
          decryptedSize: 5_000_001,
          declaredSize: 5_000_035,
          mimeType: 'application/octet-stream',
        },
      ])
    })

    it('leaves an empty file on HTTP without a round trip, because the gateway refuses a zero size', async () => {
      laneAvailable = true

      await expect(
        subject().openSocketUpload(uploadParams({ decryptedSize: 0, declaredSize: 17 })),
      ).resolves.toBeUndefined()

      expect(uploadRequests).toHaveLength(0)
    })

    it('names the shared vault owner from the vault listing and never guesses one', async () => {
      laneAvailable = true

      const opened = await subject(() => VAULT_OWNER_UUID).openSocketUpload(
        uploadParams({ ownershipType: 'shared-vault', sharedVaultUuid: VAULT_UUID }),
      )

      expect(opened).toBeDefined()
      expect(uploadRequests[0].sharedVault).toEqual({
        sharedVaultUuid: VAULT_UUID,
        sharedVaultOwnerUuid: VAULT_OWNER_UUID,
      })
    })

    it('stays on HTTP when the shared vault owner cannot be resolved locally', async () => {
      laneAvailable = true

      await expect(
        subject(() => undefined).openSocketUpload(
          uploadParams({ ownershipType: 'shared-vault', sharedVaultUuid: VAULT_UUID }),
        ),
      ).resolves.toBeUndefined()

      expect(uploadRequests).toHaveLength(0)
    })

    it('stays on HTTP when a shared-vault upload names no vault at all', async () => {
      laneAvailable = true

      await expect(
        subject(() => VAULT_OWNER_UUID).openSocketUpload(uploadParams({ ownershipType: 'shared-vault' })),
      ).resolves.toBeUndefined()

      expect(uploadRequests).toHaveLength(0)
    })

    it.each([
      ['unavailable', { outcome: 'unavailable' } as SocketFileUploadOpenOutcome],
      ['aborted', { outcome: 'aborted' } as SocketFileUploadOpenOutcome],
      [
        'failed',
        {
          outcome: 'failed',
          code: 'FILE_LIMIT_EXCEEDED',
          retryable: false,
          safeToFallback: true,
        } as SocketFileUploadOpenOutcome,
      ],
    ])('answers undefined so HTTP carries the upload when the open is %s', async (_label, outcome) => {
      laneAvailable = true
      uploadOutcome = async () => outcome

      await expect(subject().openSocketUpload(uploadParams())).resolves.toBeUndefined()

      expect(uploadRequests).toHaveLength(1)
    })

    it('never mints, starts or closes an HTTP upload session itself', async () => {
      laneAvailable = true

      await subject().openSocketUpload(uploadParams())

      expect(http.createUserFileValetToken).not.toHaveBeenCalled()
      expect(http.startUploadSession).not.toHaveBeenCalled()
      expect(http.closeUploadSession).not.toHaveBeenCalled()
      expect(http.uploadFileBytes).not.toHaveBeenCalled()
    })
  })
})
