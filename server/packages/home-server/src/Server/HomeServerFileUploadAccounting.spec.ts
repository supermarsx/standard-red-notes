import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DomainEventInterface, DomainEventService } from '@standardnotes/domain-events'
import type { SyncTicketIdentity } from '@standard-red-notes/websocket-gateway'

import { createFileUploadAccountant, createFileUploadedDomainEvent } from './HomeServerFileUploadAccounting'
import { HomeServerSyncFilesAdapter, type HomeServerPublishedUpload } from './HomeServerSyncFilesAdapter'

const createdAt = new Date('2026-10-12T12:00:00.000Z')

const personalUpload: HomeServerPublishedUpload = {
  resource: { ownershipType: 'user', remoteIdentifier: 'remote-1', fileUuid: 'file-1' },
  uploaderUuid: 'user-1',
  storageOwnerUuid: 'user-1',
  byteSize: 300_017,
}

const vaultUpload: HomeServerPublishedUpload = {
  resource: {
    ownershipType: 'shared-vault',
    remoteIdentifier: 'remote-2',
    fileUuid: 'file-2',
    sharedVaultUuid: 'vault-1',
    sharedVaultOwnerUuid: 'owner-1',
  },
  // A MEMBER uploaded it; the owner pays.
  uploaderUuid: 'member-1',
  storageOwnerUuid: 'vault-1',
  byteSize: 500_017,
}

function recordingPublisher() {
  const events: DomainEventInterface[] = []

  return { events, publish: jest.fn(async (event: DomainEventInterface) => void events.push(event)) }
}

describe('createFileUploadedDomainEvent', () => {
  /**
   * Field for field what `FinishUploadSession` + the files `DomainEventFactory`
   * publish for the same file over HTTP. Auth's `FileUploadedEventHandler` reads
   * `payload.userUuid` and `payload.fileByteSize` and nothing else, and
   * `FILE_REMOVED` later subtracts the same `fileByteSize`.
   */
  it('is the HTTP lane’s FILE_UPLOADED for a personal file', () => {
    expect(createFileUploadedDomainEvent(personalUpload, createdAt)).toEqual({
      type: 'FILE_UPLOADED',
      createdAt,
      meta: {
        correlation: { userIdentifier: 'user-1', userIdentifierType: 'uuid' },
        origin: DomainEventService.Files,
      },
      payload: {
        userUuid: 'user-1',
        filePath: 'user-1/remote-1',
        fileName: 'remote-1',
        fileByteSize: 300_017,
      },
    })
  })

  it('is the HTTP lane’s SHARED_VAULT_FILE_UPLOADED for a vault file, charged to the vault OWNER', () => {
    expect(createFileUploadedDomainEvent(vaultUpload, createdAt)).toEqual({
      type: 'SHARED_VAULT_FILE_UPLOADED',
      createdAt,
      meta: {
        correlation: { userIdentifier: 'vault-1', userIdentifierType: 'shared-vault-uuid' },
        origin: DomainEventService.Files,
      },
      payload: {
        sharedVaultUuid: 'vault-1',
        // Not `member-1`: auth's handler bills `vaultOwnerUuid`, and a member's
        // upload must not land on the member's own allowance.
        vaultOwnerUuid: 'owner-1',
        filePath: 'vault-1/remote-2',
        fileName: 'remote-2',
        fileByteSize: 500_017,
      },
    })
  })

  it('builds no event for a vault file that names no owner, rather than billing somebody else', () => {
    const ownerless: HomeServerPublishedUpload = {
      ...vaultUpload,
      resource: { ownershipType: 'shared-vault', remoteIdentifier: 'remote-2', sharedVaultUuid: 'vault-1' },
    }
    const vaultless: HomeServerPublishedUpload = {
      ...vaultUpload,
      resource: { ownershipType: 'shared-vault', remoteIdentifier: 'remote-2', sharedVaultOwnerUuid: 'owner-1' },
    }

    expect(createFileUploadedDomainEvent(ownerless, createdAt)).toBeUndefined()
    expect(createFileUploadedDomainEvent(vaultless, createdAt)).toBeUndefined()
  })
})

describe('createFileUploadAccountant', () => {
  it('publishes the upload on the bus, stamped with the time it was counted', async () => {
    const publisher = recordingPublisher()
    const logger = { error: jest.fn() }

    await createFileUploadAccountant(publisher, logger, () => createdAt)(personalUpload)

    expect(publisher.events).toEqual([createFileUploadedDomainEvent(personalUpload, createdAt)])
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('stamps the current time when no clock is supplied', async () => {
    const publisher = recordingPublisher()
    const before = Date.now()

    await createFileUploadAccountant(publisher, { error: jest.fn() })(vaultUpload)

    expect(publisher.events).toHaveLength(1)
    expect(publisher.events[0].type).toBe('SHARED_VAULT_FILE_UPLOADED')
    expect(publisher.events[0].createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(publisher.events[0].createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('never throws when the bus refuses the event, and says by name that a stored file went uncounted', async () => {
    const logger = { error: jest.fn() }
    const publisher = {
      publish: jest.fn(async () => {
        throw new TypeError('subscriber exploded at /data/uploads/user-1/remote-1')
      }),
    }

    await expect(
      createFileUploadAccountant(publisher, logger, () => createdAt)(personalUpload),
    ).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledTimes(1)
    const [message, metadata] = logger.error.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('A file uploaded over the socket lane was stored but could not be counted.')
    expect(metadata.eventType).toBe('FILE_UPLOADED')
    // Classification only: an error message can carry a storage path.
    expect(JSON.stringify(metadata)).not.toContain('/data/uploads')
  })

  it('publishes nothing and logs when a vault file names no owner', async () => {
    const publisher = recordingPublisher()
    const logger = { error: jest.fn() }
    const ownerless: HomeServerPublishedUpload = {
      ...vaultUpload,
      resource: { ownershipType: 'shared-vault', remoteIdentifier: 'remote-2', sharedVaultUuid: 'vault-1' },
    }

    await createFileUploadAccountant(publisher, logger, () => createdAt)(ownerless)

    expect(publisher.publish).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'A file uploaded over the socket lane was stored but not counted: its vault owner is not named.',
    )
  })
})

/**
 * The two halves together, as `HomeServer.createSyncFilesAdapter` composes them:
 * the REAL adapter, real bytes on a real disk, and this accountant as its hook.
 * Each half has its own suite; this is the seam between them, and it is the seam
 * that was missing -- the adapter stored the file and nothing published anything.
 */
describe('a file uploaded over the socket lane reaches the bus', () => {
  const identity: SyncTicketIdentity = {
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    deviceId: 'device-1',
    authorization: 'bearer',
  }
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('publishes exactly one FILE_UPLOADED carrying the bytes on disk, however often the finish is replayed', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'srn-files-accounting-'))
    roots.push(root)
    const publisher = recordingPublisher()
    const adapter = new HomeServerSyncFilesAdapter({
      storageRoot: root,
      authorizer: { authorize: async () => ({ storageOwnerUuid: 'user-1' }) },
      onUploadPublished: createFileUploadAccountant(publisher, { error: jest.fn() }, () => createdAt),
    })
    await adapter.initialize()

    const bytes = Uint8Array.from({ length: 1_000 }, (_value, index) => index % 251)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const signal = () => new AbortController().signal
    const opened = await adapter.openUpload(
      {
        identity,
        descriptor: {
          ownershipType: 'user',
          remoteIdentifier: 'remote-1',
          fileUuid: 'file-1',
          decryptedSize: 983,
          declaredSize: bytes.byteLength,
          mimeType: 'application/octet-stream',
        },
      },
      signal(),
    )
    await adapter.uploadChunk(
      {
        identity,
        header: {
          kind: 'UPLOAD_CHUNK',
          requestId: 'request-1',
          transferId: opened.transferId,
          generation: opened.generation,
          index: 0,
          offset: 0,
          declaredSize: bytes.byteLength,
          byteLength: bytes.byteLength,
          sha256,
          final: true,
        },
        bytes,
      },
      signal(),
    )
    const finish = () =>
      adapter.finishUpload(
        {
          identity,
          transferId: opened.transferId,
          generation: opened.generation,
          declaredSize: bytes.byteLength,
          sha256,
        },
        signal(),
      )

    expect(publisher.events).toEqual([])
    await finish()
    await finish()

    const stored = (await fs.stat(join(root, 'user-1', 'remote-1'))).size
    expect(stored).toBe(1_000)
    expect(publisher.events).toEqual([
      {
        type: 'FILE_UPLOADED',
        createdAt,
        meta: {
          correlation: { userIdentifier: 'user-1', userIdentifierType: 'uuid' },
          origin: DomainEventService.Files,
        },
        // The ENCRYPTED bytes stored (1000), not the decrypted size the client
        // declared for the quota check (983).
        payload: { userUuid: 'user-1', filePath: 'user-1/remote-1', fileName: 'remote-1', fileByteSize: stored },
      },
    ])
  })
})
