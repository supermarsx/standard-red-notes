import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { DataSource, EntityManager } from 'typeorm'
import { Uuid } from '@standardnotes/domain-core'
import { SyncCommandProtocolError } from '../../Domain/SyncCommand/SyncCommandTypes'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { inSyncingTransaction } from './InSyncingTransaction'

export type CollaborationSaveProof = { room: string; token: string }
export type CollaborationSaveWriteContext = { deviceId: string; proofs: CollaborationSaveProof[] }
export type CollaborationSaveFenceRequest = {
  room: string
  roomEpoch: string
  leaseId: string
  userUuid: string
  deviceId: string
  action: 'claim' | 'renew' | 'release'
  token?: string
}
type FenceRow = {
  room_uuid: string
  owner_uuid: string
  owner_device_id: string
  lease_id: string
  room_epoch: string
  token: string
  expires_at: string | number
}
export const COLLABORATION_SAVE_FENCE_TTL_MS = 20_000

const lost = (itemUuid?: string) =>
  new SyncCommandProtocolError(
    'collaboration_save_fence_lost',
    'The collaboration saver no longer owns this note.',
    409,
    itemUuid,
  )
const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128
const validRoom = (value: unknown): value is string => typeof value === 'string' && !Uuid.create(value).isFailed()
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/**
 * Claim and writes lock the SAME SQL row until their transaction commits. An old
 * in-flight save either commits before a new claim, or sees the new token and
 * fails before touching the note. A gateway precheck alone cannot ensure this.
 */
export class SQLCollaborationSaveFence {
  constructor(
    private readonly dataSource: DataSource,
    private readonly context: SyncCommandTransactionContext,
    private readonly secret: string,
  ) {}

  verifyRequest(body: unknown, timestamp: string, signature: string): CollaborationSaveFenceRequest {
    this.verify('save-fence', body, timestamp, signature)
    const request = body as CollaborationSaveFenceRequest
    if (
      !request ||
      !validRoom(request.room) ||
      !bounded(request.roomEpoch) ||
      !bounded(request.leaseId) ||
      !bounded(request.userUuid) ||
      !bounded(request.deviceId) ||
      !['claim', 'renew', 'release'].includes(request.action) ||
      (request.token !== undefined && !validToken(request.token)) ||
      (request.action !== 'claim' && !validToken(request.token))
    ) {
      throw new SyncCommandProtocolError(
        'invalid_collaboration_save_fence',
        'Invalid collaboration saver request.',
        400,
      )
    }
    return request
  }

  readWriteContext(body: Record<string, unknown>, userUuid: string): CollaborationSaveWriteContext | undefined {
    if (body.collaboration_save_fences === undefined) {
      return undefined
    }
    const proofs = body.collaboration_save_fences
    const deviceId = body.collaboration_save_fence_device_id
    if (
      !bounded(deviceId) ||
      !Array.isArray(proofs) ||
      proofs.length > 32 ||
      proofs.some(
        (proof) => !proof || typeof proof !== 'object' || !validRoom(proof.room) || !validToken(proof.token),
      ) ||
      new Set(proofs.map((proof) => proof.room)).size !== proofs.length
    ) {
      throw lost()
    }
    this.verify(
      'save-proof',
      { userUuid, deviceId, proofs },
      String(body.collaboration_save_fence_timestamp ?? ''),
      String(body.collaboration_save_fence_signature ?? ''),
    )
    return { deviceId, proofs }
  }

  async request(
    request: CollaborationSaveFenceRequest,
  ): Promise<{ room: string; token?: string; expiresAt: number; serverUpdatedAtTimestamp?: number }> {
    return inSyncingTransaction(this.dataSource, async (manager) => {
      const row = await this.lock(manager, request.room)
      const now = Date.now()
      const sameOwner =
        row.owner_uuid === request.userUuid &&
        row.owner_device_id === request.deviceId &&
        row.lease_id === request.leaseId &&
        row.room_epoch === request.roomEpoch
      const active = Number(row.expires_at) > now
      if (request.action === 'claim') {
        if (active && !sameOwner) {
          throw new SyncCommandProtocolError(
            'collaboration_save_fence_busy',
            'Another editor is saving this note.',
            409,
          )
        }
        const token = active && sameOwner ? row.token : randomBytes(32).toString('hex')
        const expiresAt = now + COLLABORATION_SAVE_FENCE_TTL_MS
        await manager.query(
          'UPDATE collaboration_save_fences SET owner_uuid=?,owner_device_id=?,lease_id=?,room_epoch=?,token=?,expires_at=? WHERE room_uuid=?',
          [request.userUuid, request.deviceId, request.leaseId, request.roomEpoch, token, expiresAt, request.room],
        )
        // Read under the same lock that serializes fenced writes. The client
        // can avoid an account-wide catchup only when its clean note matches
        // this exact committed revision; the grant is not a freshness guess.
        const [note] = await manager.query(
          "SELECT updated_at_timestamp FROM items WHERE uuid=? AND content_type='Note' AND deleted=0",
          [request.room],
        )
        const revision = Number(note?.updated_at_timestamp)
        return {
          room: request.room,
          token,
          expiresAt,
          ...(Number.isSafeInteger(revision) && revision > 0 ? { serverUpdatedAtTimestamp: revision } : {}),
        }
      }
      if (!sameOwner || row.token !== request.token || !active) {
        throw lost(request.room)
      }
      const expiresAt = request.action === 'release' ? 0 : now + COLLABORATION_SAVE_FENCE_TTL_MS
      await manager.query('UPDATE collaboration_save_fences SET expires_at=?,token=? WHERE room_uuid=?', [
        expiresAt,
        request.action === 'release' ? '' : row.token,
        request.room,
      ])
      return { room: request.room, ...(request.action === 'renew' ? { token: row.token } : {}), expiresAt }
    })
  }

  async run<T>(
    userUuid: string,
    rooms: string[],
    proof: CollaborationSaveWriteContext | undefined,
    execute: () => Promise<T>,
    candidateRooms?: string[],
  ): Promise<T> {
    const validRooms = [...new Set(rooms.filter(validRoom))].sort()
    if (validRooms.length === 0) {
      return execute()
    }
    const work = async (manager: EntityManager) => {
      let guardedRooms = validRooms
      if (candidateRooms) {
        const placeholders = validRooms.map(() => '?').join(',')
        // Check persisted type as well: changing or omitting content_type must
        // not bypass the fence of an existing note. Other item types need no row.
        const notes = (await manager.query(
          `SELECT uuid FROM items WHERE uuid IN (${placeholders}) AND content_type='Note'`,
          validRooms,
        )) as Array<{ uuid: string }>
        const existingFences = (await manager.query(
          `SELECT room_uuid FROM collaboration_save_fences WHERE room_uuid IN (${placeholders})`,
          validRooms,
        )) as Array<{ room_uuid: string }>
        const candidates = new Set([
          ...candidateRooms,
          ...notes.map((note) => note.uuid),
          ...existingFences.map((row) => row.room_uuid),
        ])
        guardedRooms = validRooms.filter((room) => candidates.has(room))
      }
      for (const room of guardedRooms) {
        const row = await this.lock(manager, room)
        const supplied = proof?.proofs.find((candidate) => candidate.room === room)
        if (supplied) {
          if (
            row.token !== supplied.token ||
            row.owner_uuid !== userUuid ||
            row.owner_device_id !== proof?.deviceId ||
            Number(row.expires_at) <= Date.now()
          ) {
            throw lost(room)
          }
        } else if (Number(row.expires_at) > Date.now()) {
          // Ordinary HTTP writes and other devices cannot bypass a live room.
          throw lost(room)
        }
      }
      return execute()
    }
    if (this.context.manager) {
      return work(this.context.manager)
    }
    let afterCommit: Array<() => Promise<void>> = []
    const result = await inSyncingTransaction(
      this.dataSource,
      (manager) =>
        this.context.runInviteMutation(manager, async () => {
          const value = await work(manager)
          this.context.assertOutboxHealthy()
          afterCommit = this.context.takeAfterCommitOperations()
          return value
        }),
      true,
    )
    await Promise.allSettled(afterCommit.map((operation) => operation()))
    return result
  }

  private async lock(manager: EntityManager, room: string): Promise<FenceRow> {
    const mysql = this.dataSource.options.type === 'mysql' || this.dataSource.options.type === 'mariadb'
    // Inserting even an empty row is necessary: otherwise a save that found no
    // row could race a first claim. SQLite's no-op UPDATE takes its write lock.
    await manager.query(
      mysql
        ? "INSERT INTO collaboration_save_fences (room_uuid,owner_uuid,owner_device_id,lease_id,room_epoch,token,expires_at) VALUES (?,'','','','','',0) ON DUPLICATE KEY UPDATE room_uuid=room_uuid"
        : "INSERT OR IGNORE INTO collaboration_save_fences (room_uuid,owner_uuid,owner_device_id,lease_id,room_epoch,token,expires_at) VALUES (?,'','','','','',0)",
      [room],
    )
    if (!mysql) {
      await manager.query('UPDATE collaboration_save_fences SET room_uuid=room_uuid WHERE room_uuid=?', [room])
    }
    const rows = (await manager.query(
      `SELECT * FROM collaboration_save_fences WHERE room_uuid=?${mysql ? ' FOR UPDATE' : ''}`,
      [room],
    )) as FenceRow[]
    if (!rows[0]) {
      throw lost()
    }
    return rows[0]
  }

  private verify(prefix: string, body: unknown, timestamp: string, signature: string): void {
    if (
      !this.secret ||
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp)) > 30_000 ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      throw new SyncCommandProtocolError(
        'invalid_collaboration_save_fence_signature',
        'Invalid collaboration saver signature.',
        401,
      )
    }
    const expected = createHmac('sha256', this.secret)
      .update(`${prefix}:${timestamp}:${JSON.stringify(body)}`)
      .digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new SyncCommandProtocolError(
        'invalid_collaboration_save_fence_signature',
        'Invalid collaboration saver signature.',
        401,
      )
    }
  }
}
