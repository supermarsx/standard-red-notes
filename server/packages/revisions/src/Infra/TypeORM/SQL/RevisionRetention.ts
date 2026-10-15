import {
  effectiveRevisionPolicy,
  RevisionPolicyLimits,
  RevisionPolicyResolver,
  RevisionPolicySettings,
  runSharedSqliteTransaction,
} from '@standardnotes/domain-core'
import { EntityManager, Repository, SelectQueryBuilder } from 'typeorm'
import { SQLRevision } from './SQLRevision'

const BATCH = 200
const DAY = 86_400_000

/** The lock row serializes admissions and pruning across processes, including an empty history. */
export class RevisionRetention {
  private cursor = ''
  constructor(
    private readonly repository: Repository<SQLRevision>,
    private readonly policies: RevisionPolicyResolver,
    private readonly now: () => number = Date.now,
  ) {}

  start(onError: () => void): () => void {
    let running = false
    const tick = async () => {
      if (running) {
        return
      }
      running = true
      try {
        await this.sweep()
      } catch {
        onError()
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => void tick(), 60_000)
    timer.unref?.()
    void tick()
    return () => clearInterval(timer)
  }

  private async transaction<T>(
    work: (repository: Repository<SQLRevision>, settings: RevisionPolicySettings) => Promise<T>,
  ): Promise<T> {
    const settings = await this.policies.settings()
    const source = this.repository.manager.connection
    const sqlite = source.options.type === 'better-sqlite3'
    const run = () =>
      source.manager.transaction(async (manager: EntityManager) => {
        if (sqlite) {
          await manager.query('UPDATE revisions_policy_lock SET id = id WHERE id = 1')
        }
        const lock = await manager.query(
          `SELECT id FROM revisions_policy_lock WHERE id = 1${sqlite ? '' : ' FOR UPDATE'}`,
        )
        if (lock.length !== 1) {
          throw new Error('Revision retention lock is unavailable')
        }
        return work(manager.getRepository(SQLRevision), settings)
      })
    return sqlite ? runSharedSqliteTransaction(source, String(source.options.database), run) : run()
  }

  async store(rows: SQLRevision[], automatic: boolean): Promise<void> {
    await this.transaction(async (repository, settings) => {
      const users = new Set<string | null>()
      for (const row of rows) {
        if (!row.content) {
          continue
        }
        const policy = effectiveRevisionPolicy(settings, this.policies.baseline, row.userUuid ?? undefined)
        users.add(row.userUuid)
        // One inadmissible snapshot must not evict all of the useful older history.
        const size = [row.content, row.encItemKey, row.authHash].reduce(
          (total, value) => total + Buffer.byteLength(value ?? '', 'utf8'),
          0,
        )
        if (
          (policy.maxBytesPerUser > 0 && size > policy.maxBytesPerUser) ||
          (policy.maxBytesTotal > 0 && size > policy.maxBytesTotal)
        ) {
          await this.pruneItem(repository, row.itemUuid, policy)
          continue
        }
        const cutoff = this.now() - policy.retentionDays * DAY
        if (policy.retentionDays && row.createdAt.getTime() < cutoff) {
          continue
        }
        if (automatic) {
          await this.checkpoint(repository, row, policy)
        } else {
          await repository.insert(row)
        }
        await this.pruneItem(repository, row.itemUuid, policy)
      }
      for (const user of users) {
        await this.pruneScope(
          repository,
          user,
          effectiveRevisionPolicy(settings, this.policies.baseline, user ?? undefined),
        )
      }
      await this.pruneScope(repository, undefined, effectiveRevisionPolicy(settings, this.policies.baseline))
    })
  }

  async replace(row: SQLRevision): Promise<void> {
    await this.transaction(async (repository, settings) => {
      const { uuid, ...changes } = row
      await repository.update({ uuid }, changes)
      const policy = effectiveRevisionPolicy(settings, this.policies.baseline, row.userUuid ?? undefined)
      await this.pruneItem(repository, row.itemUuid, policy)
      await this.pruneScope(repository, row.userUuid, policy)
      await this.pruneScope(repository, undefined, effectiveRevisionPolicy(settings, this.policies.baseline))
    })
  }

  async reassign(item: string, user: string): Promise<void> {
    await this.transaction(async (repository, settings) => {
      await repository.update({ itemUuid: item }, { userUuid: user })
      const policy = effectiveRevisionPolicy(settings, this.policies.baseline, user)
      await this.pruneItem(repository, item, policy)
      await this.pruneScope(repository, user, policy)
      await this.pruneScope(repository, undefined, effectiveRevisionPolicy(settings, this.policies.baseline))
    })
  }

  private async checkpoint(
    repository: Repository<SQLRevision>,
    row: SQLRevision,
    policy: RevisionPolicyLimits,
  ): Promise<void> {
    const latest = await repository
      .createQueryBuilder('r')
      .where('r.item_uuid = :item', { item: row.itemUuid })
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.uuid', 'DESC')
      .getOne()
    if (latest) {
      const sameContext =
        latest.userUuid === row.userUuid &&
        latest.sharedVaultUuid === row.sharedVaultUuid &&
        latest.keySystemIdentifier === row.keySystemIdentifier &&
        latest.itemsKeyId === row.itemsKeyId
      if (
        sameContext &&
        row.sourceUpdatedAt != null &&
        latest.sourceUpdatedAt != null &&
        row.sourceUpdatedAt <= latest.sourceUpdatedAt
      ) {
        return
      }
      if (
        sameContext &&
        latest.content === row.content &&
        latest.encItemKey === row.encItemKey &&
        latest.authHash === row.authHash
      ) {
        return
      }
      const age = row.updatedAt.getTime() - latest.createdAt.getTime()
      const gap = row.updatedAt.getTime() - latest.updatedAt.getTime()
      if (
        sameContext &&
        latest.editedByUuid === row.editedByUuid &&
        policy.debounceSeconds > 0 &&
        gap >= 0 &&
        gap < policy.debounceSeconds * 1000 &&
        (policy.checkpointSeconds === 0 || age < policy.checkpointSeconds * 1000)
      ) {
        const { uuid: _uuid, createdAt: _createdAt, creationDate: _creationDate, ...changes } = row
        await repository.update(
          { uuid: latest.uuid },
          { ...changes, coalescedChanges: (latest.coalescedChanges ?? 1) + 1 },
        )
        return
      }
    }
    await repository.insert(row)
  }

  private async pruneItem(
    repository: Repository<SQLRevision>,
    item: string,
    policy: RevisionPolicyLimits,
  ): Promise<void> {
    if (policy.retentionDays > 0) {
      await repository
        .createQueryBuilder()
        .delete()
        .where('item_uuid = :item AND created_at < :cutoff', {
          item,
          cutoff: new Date(this.now() - policy.retentionDays * DAY),
        })
        .execute()
    }
    if (policy.maxCountPerItem > 0) {
      await this.trimCount(
        repository,
        () => repository.createQueryBuilder('r').where('r.item_uuid = :item', { item }),
        policy.maxCountPerItem,
      )
    }
  }

  private scope(repository: Repository<SQLRevision>, user: string | null | undefined): SelectQueryBuilder<SQLRevision> {
    const query = repository.createQueryBuilder('r')
    if (user === null) {
      query.where('r.user_uuid IS NULL')
    } else if (user !== undefined) {
      query.where('r.user_uuid = :user', { user })
    }
    return query
  }

  private async trimCount(
    repository: Repository<SQLRevision>,
    query: () => SelectQueryBuilder<SQLRevision>,
    limit: number,
  ): Promise<void> {
    for (;;) {
      const excess = await query()
        .select(['r.uuid'])
        .orderBy('r.created_at', 'DESC')
        .addOrderBy('r.uuid', 'DESC')
        .offset(limit)
        .limit(BATCH)
        .getMany()
      if (!excess.length) {
        return
      }
      await repository.delete(excess.map((row) => row.uuid))
    }
  }

  private bytes(repository: Repository<SQLRevision>): string {
    return ['content', 'enc_item_key', 'auth_hash']
      .map((field) =>
        repository.manager.connection.options.type === 'better-sqlite3'
          ? `LENGTH(CAST(COALESCE(r.${field}, '') AS BLOB))`
          : `OCTET_LENGTH(COALESCE(r.${field}, ''))`,
      )
      .join(' + ')
  }

  private async pruneScope(
    repository: Repository<SQLRevision>,
    user: string | null | undefined,
    policy: RevisionPolicyLimits,
  ): Promise<void> {
    const count = user === undefined ? policy.maxCountTotal : policy.maxCountPerUser
    const bytes = user === undefined ? policy.maxBytesTotal : policy.maxBytesPerUser
    if (count > 0) {
      await this.trimCount(repository, () => this.scope(repository, user), count)
    }
    if (bytes <= 0) {
      return
    }
    const measured = await this.scope(repository, user)
      .select(`COALESCE(SUM(${this.bytes(repository)}), 0)`, 'bytes')
      .getRawOne<{ bytes: string | number }>()
    const total = Number(measured?.bytes)
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error('Revision storage measurement is not a safe integer')
    }
    let excess = total - bytes
    while (excess > 0) {
      const oldest = await this.scope(repository, user)
        .select('r.uuid', 'uuid')
        .addSelect(this.bytes(repository), 'bytes')
        .orderBy('r.created_at', 'ASC')
        .addOrderBy('r.uuid', 'ASC')
        .limit(BATCH)
        .getRawMany<{ uuid: string; bytes: string | number }>()
      if (!oldest.length) {
        throw new Error('Revision storage changed during pruning')
      }
      const remove: string[] = []
      for (const row of oldest) {
        const size = Number(row.bytes)
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error('Invalid revision byte measurement')
        }
        remove.push(row.uuid)
        excess -= size
        if (excess <= 0) {
          break
        }
      }
      await repository.delete(remove)
    }
  }

  /** Bounded rotating sweep also ages out notes which nobody edits or opens again. */
  async sweep(): Promise<void> {
    await this.transaction(async (repository, settings) => {
      const items = await repository
        .createQueryBuilder('r')
        .select('r.item_uuid', 'item')
        .where('r.item_uuid > :cursor', { cursor: this.cursor })
        .distinct(true)
        .orderBy('r.item_uuid', 'ASC')
        .limit(100)
        .getRawMany<{ item: string }>()
      const users = new Set<string | null>()
      for (const { item } of items) {
        const owners = await repository
          .createQueryBuilder('r')
          .select('r.user_uuid', 'user')
          .where('r.item_uuid = :item', { item })
          .distinct(true)
          .getRawMany<{ user: string | null }>()
        for (const { user } of owners) {
          users.add(user)
          await this.pruneItem(
            repository,
            item,
            effectiveRevisionPolicy(settings, this.policies.baseline, user ?? undefined),
          )
        }
      }
      for (const user of users) {
        await this.pruneScope(
          repository,
          user,
          effectiveRevisionPolicy(settings, this.policies.baseline, user ?? undefined),
        )
      }
      await this.pruneScope(repository, undefined, effectiveRevisionPolicy(settings, this.policies.baseline))
      this.cursor = items.length === 100 ? items.at(-1)!.item : ''
    })
  }
}
