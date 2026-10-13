import 'reflect-metadata'
import { createHmac } from 'crypto'
import { DataSource } from 'typeorm'
import { Request, Response } from 'express'
import { runSharedSqliteTransaction } from '@standardnotes/domain-core'
import { TypeORMSharedVaultUser } from '../TypeORM/TypeORMSharedVaultUser'
import { TypeORMSharedVault } from '../TypeORM/TypeORMSharedVault'
import { AnnotatedMembershipSnapshotController } from './AnnotatedMembershipSnapshotController'
import { readSharedVaultMembershipSnapshot } from '../readSharedVaultMembershipSnapshot'

const userUuid = '00000000-0000-4000-8000-000000000001'
const vaultUuid = '00000000-0000-4000-8000-000000000002'
const secret = 'test-membership-secret'

describe('Membership authority snapshot', () => {
  let db: DataSource
  beforeEach(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSharedVaultUser, TypeORMSharedVault],
      synchronize: true,
    })
    await db.initialize()
    await db
      .getRepository(TypeORMSharedVault)
      .insert({ uuid: vaultUuid, userUuid, fileUploadBytesUsed: 0, createdAtTimestamp: 1, updatedAtTimestamp: 2 })
    await db.getRepository(TypeORMSharedVaultUser).insert({
      uuid: '00000000-0000-4000-8000-000000000003',
      userUuid,
      sharedVaultUuid: vaultUuid,
      permission: 'admin',
      isDesignatedSurvivor: true,
      createdAtTimestamp: 1,
      updatedAtTimestamp: 2,
    })
  })
  afterEach(async () => {
    await db.destroy()
  })

  const call = async (scope?: string, signatureScope = scope, timestamp = String(Date.now())) => {
    const headers: Record<string, string> = {
      'x-membership-timestamp': timestamp,
      'x-membership-signature': createHmac('sha256', secret)
        .update(`membership-snapshot:${timestamp}:${signatureScope ?? ''}`)
        .digest('hex'),
    }
    const request = {
      query: scope ? { userUuid: scope } : {},
      get: (name: string) => headers[name],
    } as unknown as Request
    const response = { sendStatus: jest.fn(), setHeader: jest.fn(), json: jest.fn() } as unknown as Response
    await new AnnotatedMembershipSnapshotController(db.getRepository(TypeORMSharedVaultUser), secret).get(
      request,
      response,
    )
    return response
  }

  it('returns complete signed snapshots and omits memberships in deleted vaults', async () => {
    const response = await call(userUuid)
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        complete: true,
        memberships: [expect.objectContaining({ userUuid, permission: 'admin' })],
      }),
    )
    await db.getRepository(TypeORMSharedVault).delete({ uuid: vaultUuid })
    expect(await readSharedVaultMembershipSnapshot(db.getRepository(TypeORMSharedVaultUser))).toEqual([])
  })

  it('rejects tampered user scope, expired signatures and malformed UUIDs', async () => {
    expect((await call(userUuid, 'different-scope')).sendStatus).toHaveBeenCalledWith(401)
    expect((await call(userUuid, userUuid, String(Date.now() - 31_000))).sendStatus).toHaveBeenCalledWith(401)
    expect((await call('not-a-uuid')).sendStatus).toHaveBeenCalledWith(401)
  })

  it('waits for an overlapping SQLite membership mutation to commit or roll back', async () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((done) => {
      entered = done
    })
    const gate = new Promise<void>((done) => {
      release = done
    })
    const mutation = runSharedSqliteTransaction(db, ':memory:', () =>
      db.transaction(async (manager) => {
        await manager.query('UPDATE shared_vault_users SET permission = ?', ['read'])
        entered()
        await gate
        throw new Error('rollback')
      }),
    )
    await started
    let completed = false
    const snapshot = readSharedVaultMembershipSnapshot(db.getRepository(TypeORMSharedVaultUser)).then((rows) => {
      completed = true
      return rows
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await expect(mutation).rejects.toThrow('rollback')
    expect(await snapshot).toEqual([expect.objectContaining({ permission: 'admin' })])
  })
})
