import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'
import { SharedVaultMembershipReconciler, MembershipSnapshotRow } from './SharedVaultMembershipReconciler'
import { TypeORMSharedVaultUser } from './TypeORM/TypeORMSharedVaultUser'
import { authSharedVaultReplicaLock1791936000001 } from '../../migrations/sqlite/1791936000001-auth-shared-vault-replica-lock'

const user = '00000000-0000-4000-8000-000000000001'
const row: MembershipSnapshotRow = {
  uuid: '00000000-0000-4000-8000-000000000002',
  userUuid: user,
  sharedVaultUuid: '00000000-0000-4000-8000-000000000003',
  permission: 'write',
  isDesignatedSurvivor: false,
  createdAtTimestamp: 1,
  updatedAtTimestamp: 2,
}

describe('SharedVaultMembershipReconciler', () => {
  let db: DataSource
  let service: SharedVaultMembershipReconciler
  beforeEach(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSharedVaultUser],
      synchronize: true,
    })
    await db.initialize()
    const runner = db.createQueryRunner()
    await new authSharedVaultReplicaLock1791936000001().up(runner)
    await runner.release()
    service = new SharedVaultMembershipReconciler(db.getRepository(TypeORMSharedVaultUser), {
      error: jest.fn(),
    } as unknown as Logger)
  })
  afterEach(async () => {
    service.stop()
    await db.destroy()
    jest.useRealTimers()
  })

  it('repairs at startup and automatically removes stale rows on the next periodic scan', async () => {
    jest.useFakeTimers()
    const reader = jest.fn().mockResolvedValue([row])
    service.setReader(reader)
    service.start()
    await jest.advanceTimersByTimeAsync(0)
    expect(await db.getRepository(TypeORMSharedVaultUser).count()).toBe(1)
    reader.mockResolvedValue([])
    await jest.advanceTimersByTimeAsync(60_000)
    expect(await db.getRepository(TypeORMSharedVaultUser).count()).toBe(0)
    service.stop()
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('repairs missing rows, permissions and survivor flags then revokes absent memberships', async () => {
    service.setReader(async () => [row])
    await service.reconcile()
    expect(await db.getRepository(TypeORMSharedVaultUser).find()).toEqual([row])
    service.setReader(async () => [{ ...row, permission: 'admin', isDesignatedSurvivor: true }])
    await service.reconcile(user)
    expect((await db.getRepository(TypeORMSharedVaultUser).find())[0]).toMatchObject({
      permission: 'admin',
      isDesignatedSurvivor: true,
    })
    service.setReader(async () => [])
    await service.reconcile()
    expect(await db.getRepository(TypeORMSharedVaultUser).count()).toBe(0)
  })

  it('handles a burst of same-user validations without retry amplification or sharing stale reads', async () => {
    let reads = 0
    const reader = jest.fn(async () => [{ ...row, updatedAtTimestamp: 2 + reads++ }])
    service.setReader(reader)
    await Promise.all(Array.from({ length: 32 }, () => service.reconcile(user)))
    expect(reader).toHaveBeenCalledTimes(32)
    expect((await db.getRepository(TypeORMSharedVaultUser).find())[0].updatedAtTimestamp).toBe(33)
  })

  it.each([
    [user, user],
    [undefined, user],
    [user, undefined],
  ])('cannot resurrect a removed member with delayed scope %s after scope %s', async (olderScope, newerScope) => {
    const other = new SharedVaultMembershipReconciler(db.getRepository(TypeORMSharedVaultUser), {
      error: jest.fn(),
    } as unknown as Logger)
    let release!: (rows: MembershipSnapshotRow[]) => void
    let started!: () => void
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let reads = 0
    service.setReader(async () => {
      if (++reads === 1) {
        started()
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return []
    })
    other.setReader(async () => [])
    const older = service.reconcile(olderScope)
    await readStarted
    await other.reconcile(newerScope)
    release([row])
    await older
    expect(reads).toBe(2)
    expect(await db.getRepository(TypeORMSharedVaultUser).count()).toBe(0)
  })

  it('rejects malformed and duplicate snapshots without deleting the existing replica', async () => {
    await db.getRepository(TypeORMSharedVaultUser).insert(row)
    for (const snapshot of [
      [null],
      [row, row],
      [{ ...row, updatedAtTimestamp: -1 }],
      [{ ...row, userUuid: 'invalid' }],
    ]) {
      service.setReader(async () => snapshot as MembershipSnapshotRow[])
      await expect(service.reconcile(user)).rejects.toThrow()
      expect(await db.getRepository(TypeORMSharedVaultUser).count()).toBe(1)
    }
  })

  it('preserves the replica on source failure and fails closed without a lock singleton', async () => {
    await db.getRepository(TypeORMSharedVaultUser).insert(row)
    service.setReader(async () => {
      throw new Error('source unavailable')
    })
    await expect(service.reconcile()).rejects.toThrow('source unavailable')
    expect(await db.getRepository(TypeORMSharedVaultUser).count()).toBe(1)
    await db.query('DELETE FROM auth_shared_vault_replica_lock')
    const reader = jest.fn().mockResolvedValue([])
    service.setReader(reader)
    await expect(service.reconcile()).rejects.toThrow('generation is unavailable')
    expect(reader).not.toHaveBeenCalled()
  })

  it('keeps unrelated users during a targeted refresh', async () => {
    const second = {
      ...row,
      uuid: '00000000-0000-4000-8000-000000000004',
      userUuid: '00000000-0000-4000-8000-000000000005',
    }
    await db.getRepository(TypeORMSharedVaultUser).insert([row, second])
    service.setReader(async () => [])
    await service.reconcile(user)
    expect(await db.getRepository(TypeORMSharedVaultUser).find()).toEqual([second])
  })
})
