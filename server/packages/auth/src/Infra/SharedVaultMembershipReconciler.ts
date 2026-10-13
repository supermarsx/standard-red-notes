import { createHmac } from 'crypto'
import axios from 'axios'
import { EntityManager, Repository } from 'typeorm'
import { Logger } from 'winston'
import { Uuid } from '@standardnotes/domain-core'
import { TypeORMSharedVaultUser } from './TypeORM/TypeORMSharedVaultUser'
import { runAuthTypeORMTransaction } from './TypeORM/AuthTypeORMTransactionCoordinator'

export type MembershipSnapshotRow = {
  uuid: string
  sharedVaultUuid: string
  userUuid: string
  permission: string
  isDesignatedSurvivor: boolean
  createdAtTimestamp: number
  updatedAtTimestamp: number
}
export type MembershipSnapshotReader = (userUuid?: string) => Promise<MembershipSnapshotRow[]>

/** Events invalidate this replica; their payloads never grant access. Reserve a
 * database generation BEFORE reading authority and apply only if it is still
 * current. An older in-flight snapshot cannot overwrite a newer reconciliation,
 * even across auth processes. External I/O never holds database transactions. */
export class SharedVaultMembershipReconciler {
  private reader?: MembershipSnapshotReader
  private timer?: NodeJS.Timeout
  private userRefreshes = new Map<string, Promise<void>>()

  constructor(
    private repository: Repository<TypeORMSharedVaultUser>,
    private logger: Logger,
  ) {}

  setReader(reader: MembershipSnapshotReader): void {
    this.reader = reader
  }

  async reconcile(userUuid?: string): Promise<void> {
    const key = userUuid ?? '*'
    // Do not coalesce requests: an event queued during a source mutation needs
    // its own fresh read. Serialize the user's reads to avoid retry storms from
    // the many concurrent session validations during initial application sync.
    const previous = this.userRefreshes.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.reconcileSnapshot(userUuid))
    this.userRefreshes.set(key, operation)
    try {
      await operation
    } finally {
      if (this.userRefreshes.get(key) === operation) {
        this.userRefreshes.delete(key)
      }
    }
  }

  private async reconcileSnapshot(userUuid?: string): Promise<void> {
    if (!this.reader) {
      throw new Error('Shared-vault membership authority is not configured')
    }
    if (userUuid && Uuid.create(userUuid).isFailed()) {
      throw new Error('Invalid shared-vault membership user')
    }
    const dataSource = this.repository.manager.connection
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = await runAuthTypeORMTransaction(dataSource, async (manager) => {
        await manager.query('UPDATE auth_shared_vault_replica_lock SET generation = generation + 1 WHERE id = 1')
        const state = await manager.query(
          'SELECT generation, full_generation FROM auth_shared_vault_replica_lock WHERE id = 1',
        )
        if (state.length !== 1) {
          throw new Error('Membership replica generation is unavailable')
        }
        const generation = String(state[0].generation)
        if (userUuid) {
          await manager.query('DELETE FROM auth_shared_vault_replica_versions WHERE user_uuid = ?', [userUuid])
          await manager.query('INSERT INTO auth_shared_vault_replica_versions (user_uuid, generation) VALUES (?, ?)', [
            userUuid,
            generation,
          ])
        } else {
          await manager.query('UPDATE auth_shared_vault_replica_lock SET full_generation = generation WHERE id = 1')
        }
        return { generation, fullGeneration: userUuid ? String(state[0].full_generation) : generation }
      })
      const rows = await this.reader(userUuid)
      this.validate(rows, userUuid)
      const applied = await runAuthTypeORMTransaction(dataSource, async (manager) => {
        // This write locks the row until commit, including when another process
        // attempts to reserve the next generation while replacement is running.
        await manager.query('UPDATE auth_shared_vault_replica_lock SET generation = generation WHERE id = 1')
        const state = await manager.query(
          'SELECT generation, full_generation FROM auth_shared_vault_replica_lock WHERE id = 1',
        )
        const current = userUuid
          ? await manager.query('SELECT generation FROM auth_shared_vault_replica_versions WHERE user_uuid = ?', [
              userUuid,
            ])
          : state
        if (
          String(current[0]?.generation) !== reservation.generation ||
          String(state[0]?.full_generation) !== reservation.fullGeneration
        ) {
          return false
        }
        await this.replace(manager, rows, userUuid)
        return true
      })
      if (applied) {
        return
      }
    }
    throw new Error('Membership snapshot was superseded; retry required')
  }

  start(): void {
    if (this.timer) {
      return
    }
    let running = false
    const scan = async (): Promise<void> => {
      if (running) {
        return
      }
      running = true
      try {
        await this.reconcile()
      } catch {
        this.logger.error('Shared-vault membership reconciliation failed; retrying on the next scan.')
      } finally {
        running = false
      }
    }
    void scan()
    this.timer = setInterval(() => void scan(), 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private validate(rows: MembershipSnapshotRow[], userUuid?: string): void {
    if (!Array.isArray(rows) || rows.length > 100_000) {
      throw new Error('Invalid or oversized membership snapshot')
    }
    const pairs = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        throw new Error('Malformed membership snapshot row')
      }
      const pair = `${row.sharedVaultUuid}:${row.userUuid}`
      if (
        Uuid.create(row.uuid).isFailed() ||
        Uuid.create(row.userUuid).isFailed() ||
        Uuid.create(row.sharedVaultUuid).isFailed() ||
        !['read', 'write', 'admin'].includes(row.permission) ||
        typeof row.isDesignatedSurvivor !== 'boolean' ||
        !Number.isSafeInteger(row.createdAtTimestamp) ||
        !Number.isSafeInteger(row.updatedAtTimestamp) ||
        row.createdAtTimestamp < 0 ||
        row.updatedAtTimestamp < row.createdAtTimestamp ||
        (userUuid !== undefined && row.userUuid !== userUuid) ||
        pairs.has(pair)
      ) {
        throw new Error('Malformed membership snapshot')
      }
      pairs.add(pair)
    }
  }

  private async replace(manager: EntityManager, rows: MembershipSnapshotRow[], userUuid?: string): Promise<void> {
    const repository = manager.getRepository(TypeORMSharedVaultUser)
    const removal = repository.createQueryBuilder().delete()
    if (userUuid) {
      removal.where('user_uuid = :userUuid', { userUuid })
    }
    await removal.execute()
    for (let offset = 0; offset < rows.length; offset += 500) {
      await repository.insert(rows.slice(offset, offset + 500))
    }
  }
}

export function remoteMembershipSnapshotReader(baseUrl: string, secret: string): MembershipSnapshotReader {
  const url = new URL('/internal/shared-vault-memberships', baseUrl)
  return async (userUuid) => {
    const timestamp = String(Date.now())
    const signature = createHmac('sha256', secret)
      .update(`membership-snapshot:${timestamp}:${userUuid ?? ''}`)
      .digest('hex')
    const response = await axios.get(url.toString(), {
      params: userUuid ? { userUuid } : undefined,
      headers: { 'x-membership-timestamp': timestamp, 'x-membership-signature': signature },
      timeout: 10_000,
      maxRedirects: 0,
      maxContentLength: 50 * 1024 * 1024,
    })
    if (response.data?.complete !== true) {
      throw new Error('Incomplete membership snapshot')
    }
    return response.data.memberships
  }
}
