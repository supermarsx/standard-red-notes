import 'reflect-metadata'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawn } from 'node:child_process'

import { SettingName } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'

import { AUTH_TYPEORM_ENTITIES } from '../../Bootstrap/DataSource'
import { User } from '../../Domain/User/User'
import {
  appendNextcloudBackupCompletion,
  emptyNextcloudBackupDeliveryState,
} from '../../Domain/Setting/NextcloudBackupDeliveryState'
import { NextcloudBackupStateStore } from '../../Domain/Setting/NextcloudBackupStateStore'
import {
  nextcloudBackupInProcessQueueCountForTesting,
  TypeORMNextcloudBackupStateRepository,
} from './TypeORMNextcloudBackupStateRepository'
import { authTypeORMTransactionQueueStatsForTesting } from './AuthTypeORMTransactionCoordinator'
import { TypeORMNextcloudBackupUserLock } from './TypeORMNextcloudBackupUserLock'
import { TypeORMSetting } from './TypeORMSetting'
import { TypeORMUserRepository } from './TypeORMUserRepository'

describe('TypeORMNextcloudBackupStateRepository', () => {
  const userUuid = '00000000-0000-0000-0000-000000000001'
  const secondUserUuid = '00000000-0000-0000-0000-000000000002'
  const firstRequestUuid = '00000000-0000-0000-0000-000000000010'
  const secondRequestUuid = '00000000-0000-0000-0000-000000000011'
  const nowMs = 1_700_000_000_000

  let temporaryDirectory: string
  let databasePath: string
  let firstDataSource: DataSource
  let secondDataSource: DataSource
  let timestampMicroseconds: number
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>

  const createDataSource = (synchronize: boolean, database = databasePath) =>
    new DataSource({
      type: 'better-sqlite3',
      database,
      entities: AUTH_TYPEORM_ENTITIES,
      synchronize,
      enableWAL: true,
      prepareDatabase: (database) => database.pragma('busy_timeout = 5000'),
      logging: false,
    })

  const insertUser = async (dataSource: DataSource, uuid: string) => {
    await dataSource.getRepository(User).insert({
      uuid,
      encryptedPassword: 'test-password-hash',
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
  }

  const createStore = (dataSource: DataSource) =>
    new NextcloudBackupStateStore(new TypeORMNextcloudBackupStateRepository(dataSource, timer), timer, logger)

  beforeEach(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'srn-nextcloud-state-'))
    databasePath = join(temporaryDirectory, 'auth.sqlite')
    timestampMicroseconds = nowMs * 1_000
    timer = {
      getTimestampInMicroseconds: jest.fn(() => ++timestampMicroseconds),
      convertMicrosecondsToMilliseconds: jest.fn((value: number) => Math.floor(value / 1_000)),
    } as unknown as jest.Mocked<TimerInterface>
    logger = { error: jest.fn() } as unknown as jest.Mocked<Logger>

    firstDataSource = createDataSource(true)
    await firstDataSource.initialize()
    await insertUser(firstDataSource, userUuid)
    await insertUser(firstDataSource, secondUserUuid)
    // Equivalent relative/absolute paths must share the in-process queue.
    secondDataSource = createDataSource(false, relative(process.cwd(), databasePath))
    await secondDataSource.initialize()
  })

  afterEach(async () => {
    if (secondDataSource?.isInitialized) {
      await secondDataSource.destroy()
    }
    if (firstDataSource?.isInitialized) {
      await firstDataSource.destroy()
    }
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('serializes two repository objects sharing TypeORM SQLite single connection state', async () => {
    const firstStore = createStore(firstDataSource)
    const secondStore = createStore(firstDataSource)

    await Promise.all([
      firstStore.runExclusive(userUuid, ({ deliveryState }) => ({
        result: undefined,
        deliveryState: {
          ...deliveryState,
          completed: appendNextcloudBackupCompletion(deliveryState, {
            requestUuid: firstRequestUuid,
            outcome: 'succeeded',
            completedAt: nowMs - 1,
          }),
        },
        lastSuccessAt: nowMs - 1,
      })),
      secondStore.runExclusive(userUuid, ({ deliveryState, lastSuccessAt }) => ({
        result: undefined,
        deliveryState: {
          ...deliveryState,
          completed: appendNextcloudBackupCompletion(deliveryState, {
            requestUuid: secondRequestUuid,
            outcome: 'succeeded',
            completedAt: nowMs,
          }),
        },
        lastSuccessAt: Math.max(lastSuccessAt ?? 0, nowMs),
      })),
    ])

    const state = await firstStore.runExclusive(userUuid, (current) => ({ result: current }))
    expect(state).toEqual({
      status: 'available',
      value: expect.objectContaining({
        lastSuccessAt: nowMs,
        deliveryState: expect.objectContaining({
          completed: expect.arrayContaining([
            expect.objectContaining({ requestUuid: firstRequestUuid }),
            expect.objectContaining({ requestUuid: secondRequestUuid }),
          ]),
        }),
      }),
    })
  })

  it('serializes first-use races across two independent DataSources on one SQLite file', async () => {
    const firstStore = createStore(firstDataSource)
    const secondStore = createStore(secondDataSource)

    const attemptClaim = (store: NextcloudBackupStateStore, contender: string, contenderRequestUuid: string) =>
      store.runExclusive(userUuid, ({ deliveryState }) => {
        if (deliveryState.activeRequest) {
          return { result: `observed:${contender}` }
        }

        return {
          result: `claimed:${contender}`,
          deliveryState: {
            ...deliveryState,
            activeRequest: { requestUuid: contenderRequestUuid, requestedAt: nowMs },
          },
        }
      })

    const results = await Promise.all([
      attemptClaim(firstStore, 'first', firstRequestUuid),
      attemptClaim(secondStore, 'second', secondRequestUuid),
    ])

    const values = results.map((result) => (result.status === 'available' ? result.value : result.status))
    expect(values.filter((value) => value.startsWith('claimed:'))).toHaveLength(1)
    expect(values.filter((value) => value.startsWith('observed:'))).toHaveLength(1)
    expect(nextcloudBackupInProcessQueueCountForTesting()).toBe(0)
    expect(authTypeORMTransactionQueueStatsForTesting()).toEqual({
      activeQueueKeyCount: 0,
      sqliteFileQueueCount: 0,
    })
  })

  it('allows exactly one claim when a child process races the repository', async () => {
    const childRequestUuid = '00000000-0000-0000-0000-000000000099'
    const childScript = `
      const Database = require('better-sqlite3');
      const crypto = require('node:crypto');
      const db = new Database(process.argv[1], { timeout: 5000 });
      db.pragma('foreign_keys = ON');
      process.stdout.write('READY\\n');
      process.stdin.once('data', () => {
        try {
          db.exec('BEGIN IMMEDIATE');
          db.prepare('UPDATE users SET uuid = uuid WHERE uuid = ?').run(process.argv[2]);
          db.prepare('INSERT INTO nextcloud_backup_user_locks (user_uuid, updated_at) VALUES (?, ?) ON CONFLICT(user_uuid) DO UPDATE SET updated_at = excluded.updated_at').run(process.argv[2], process.argv[4]);
          const row = db.prepare('SELECT uuid, value FROM settings WHERE user_uuid = ? AND name = ? ORDER BY updated_at DESC, created_at DESC, uuid DESC LIMIT 1').get(process.argv[2], 'NEXTCLOUD_BACKUP_DELIVERY_STATE');
          const state = row ? JSON.parse(row.value) : { activeRequest: null, consecutiveFailures: 0, retryNotBefore: null, completed: [] };
          let result = 'observed:child';
          if (state.activeRequest === null) {
            result = 'claimed:child';
            state.activeRequest = { requestUuid: process.argv[3], requestedAt: 1700000000000 };
            const value = JSON.stringify(state);
            if (row) {
              db.prepare('UPDATE settings SET value = ?, updated_at = ?, sensitive = 1, server_encryption_version = 0 WHERE uuid = ?').run(value, process.argv[4], row.uuid);
            } else {
              db.prepare('INSERT INTO settings (uuid, name, value, server_encryption_version, created_at, updated_at, user_uuid, sensitive) VALUES (?, ?, ?, 0, ?, ?, ?, 1)').run(crypto.randomUUID(), 'NEXTCLOUD_BACKUP_DELIVERY_STATE', value, process.argv[4], process.argv[4], process.argv[2]);
            }
          }
          db.exec('COMMIT');
          process.stdout.write('RESULT:' + result + '\\n');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          process.stderr.write(String(error));
          process.exitCode = 1;
        } finally {
          db.close();
        }
      });
    `
    const child = spawn(
      process.execPath,
      ['-e', childScript, databasePath, secondUserUuid, childRequestUuid, String(nowMs * 1_000 + 100)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.stderr.on('data', (chunk: string) => (errorOutput += chunk))

    const childCompletion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Child claim timeout: ${errorOutput}`))
      }, 5_000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Child claim failed (${code}): ${errorOutput}`))
        }
      })
    })
    void childCompletion.catch(() => undefined)
    const childReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Child did not become ready: ${errorOutput}`)), 5_000)
      child.stdout.on('data', () => {
        if (output.includes('READY')) {
          clearTimeout(timeout)
          resolve()
        }
      })
      child.once('error', reject)
    })

    try {
      await childReady
      child.stdin.write('GO\n')
      child.stdin.end()

      const parentResult = await createStore(firstDataSource).runExclusive(secondUserUuid, ({ deliveryState }) => {
        if (deliveryState.activeRequest) {
          return { result: 'observed:parent' }
        }

        return {
          result: 'claimed:parent',
          deliveryState: {
            ...deliveryState,
            activeRequest: { requestUuid: secondRequestUuid, requestedAt: nowMs },
          },
        }
      })
      await childCompletion

      const childValue = output.match(/RESULT:(claimed|observed):child/)?.[0].replace('RESULT:', '')
      const parentValue = parentResult.status === 'available' ? parentResult.value : parentResult.status
      const outcomes = [childValue, parentValue]
      expect(outcomes.filter((value) => value?.startsWith('claimed:'))).toHaveLength(1)
      expect(outcomes.filter((value) => value?.startsWith('observed:'))).toHaveLength(1)

      const finalState = await createStore(firstDataSource).readDeliveryState(secondUserUuid)
      expect(finalState).toEqual({
        status: 'available',
        value: expect.objectContaining({ activeRequest: expect.objectContaining({ requestUuid: expect.any(String) }) }),
      })
    } finally {
      if (child.exitCode === null) {
        child.kill()
      }
      await childCompletion.catch(() => undefined)
    }
  })

  it('uses microsecond setting timestamps and preserves private/public setting semantics', async () => {
    const store = createStore(firstDataSource)
    await store.runExclusive(userUuid, () => ({
      result: undefined,
      deliveryState: emptyNextcloudBackupDeliveryState(),
      lastSuccessAt: nowMs,
    }))

    const rows = await firstDataSource.getRepository(TypeORMSetting).findBy({ userUuid })
    const delivery = rows.find((row) => row.name === SettingName.NAMES.NextcloudBackupDeliveryState)
    const lastRun = rows.find((row) => row.name === SettingName.NAMES.NextcloudBackupLastRun)

    expect(Boolean(delivery?.sensitive)).toBe(true)
    expect(Boolean(lastRun?.sensitive)).toBe(false)
    expect(delivery?.serverEncryptionVersion).toBe(0)
    expect(lastRun?.serverEncryptionVersion).toBe(0)
    expect(delivery?.updatedAt).toBeGreaterThanOrEqual(nowMs * 1_000)
    expect(lastRun?.updatedAt).toBeGreaterThanOrEqual(nowMs * 1_000)
  })

  it.each(['backup-first', 'credential-first'] as const)(
    'isolates a committed backup transition from a concurrent credential rollback (%s)',
    async (ordering) => {
      const oldPasswordHash = 'test-password-hash'
      await firstDataSource.getRepository(TypeORMSetting).insert({
        uuid: '00000000-0000-0000-0000-000000000088',
        name: SettingName.NAMES.AccountRecoveryEscrow,
        value: 'opaque-client-ciphertext',
        serverEncryptionVersion: 1,
        createdAt: nowMs * 1_000,
        updatedAt: nowMs * 1_000,
        userUuid: secondUserUuid,
        sensitive: false,
      })
      await firstDataSource.query(`
      CREATE TRIGGER force_credential_transaction_rollback
      BEFORE DELETE ON settings
      WHEN OLD.name = '${SettingName.NAMES.AccountRecoveryEscrow}'
      BEGIN
        SELECT RAISE(ABORT, 'forced credential rollback');
      END
    `)

      const persistedUser = await firstDataSource.getRepository(User).findOneByOrFail({ uuid: secondUserUuid })
      const candidate = {
        ...persistedUser,
        encryptedPassword: 'must-roll-back',
        version: '004',
        updatedAt: new Date(nowMs + 1),
      } as User
      // Both repositories intentionally share one BetterSqlite DataSource and its
      // memoized QueryRunner: this reproduces the nested-savepoint hazard that the
      // shared coordinator prevents.
      const credentialRepository = new TypeORMUserRepository(firstDataSource.getRepository(User))
      const backupStore = createStore(firstDataSource)

      const runCredentialRollback = () =>
        credentialRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
          user: candidate,
          expectedEncryptedPassword: oldPasswordHash,
          expectedProtocolVersion: null,
        })
      const runBackupCommit = () =>
        backupStore.runExclusive(secondUserUuid, ({ deliveryState }) => ({
          result: 'backup-committed',
          deliveryState: {
            ...deliveryState,
            activeRequest: { requestUuid: firstRequestUuid, requestedAt: nowMs },
          },
        }))

      let credentialPromise: ReturnType<typeof runCredentialRollback>
      let backupPromise: ReturnType<typeof runBackupCommit>
      if (ordering === 'backup-first') {
        backupPromise = runBackupCommit()
        // The backup's per-user queue yields once before entering the shared
        // coordinator. Observe that acquisition before queuing credential CAS.
        await Promise.resolve()
        expect(authTypeORMTransactionQueueStatsForTesting().activeQueueKeyCount).toBe(1)
        credentialPromise = runCredentialRollback()
      } else {
        credentialPromise = runCredentialRollback()
        expect(authTypeORMTransactionQueueStatsForTesting().activeQueueKeyCount).toBe(1)
        backupPromise = runBackupCommit()
      }
      expect(authTypeORMTransactionQueueStatsForTesting().activeQueueKeyCount).toBe(1)

      const [credentialAttempt, backupAttempt] = await Promise.allSettled([credentialPromise, backupPromise])

      expect(credentialAttempt).toEqual(expect.objectContaining({ status: 'rejected' }))
      expect(backupAttempt).toEqual({
        status: 'fulfilled',
        value: { status: 'available', value: 'backup-committed' },
      })
      expect(
        (await firstDataSource.getRepository(User).findOneByOrFail({ uuid: secondUserUuid })).encryptedPassword,
      ).toBe(oldPasswordHash)
      expect(
        await firstDataSource.getRepository(TypeORMSetting).findOneBy({
          userUuid: secondUserUuid,
          name: SettingName.NAMES.AccountRecoveryEscrow,
        }),
      ).not.toBeNull()
      await expect(backupStore.readDeliveryState(secondUserUuid)).resolves.toEqual({
        status: 'available',
        value: expect.objectContaining({
          activeRequest: expect.objectContaining({ requestUuid: firstRequestUuid }),
        }),
      })
      expect(nextcloudBackupInProcessQueueCountForTesting()).toBe(0)
      expect(authTypeORMTransactionQueueStatsForTesting()).toEqual({
        activeQueueKeyCount: 0,
        sqliteFileQueueCount: 0,
      })
    },
  )

  it('cascades lock rows on deletion and returns terminal user-not-found afterward', async () => {
    const store = createStore(firstDataSource)
    await store.readDeliveryState(userUuid)
    expect(await firstDataSource.getRepository(TypeORMNextcloudBackupUserLock).countBy({ userUuid })).toBe(1)

    await firstDataSource.getRepository(User).delete({ uuid: userUuid })

    expect(await firstDataSource.getRepository(TypeORMNextcloudBackupUserLock).countBy({ userUuid })).toBe(0)
    await expect(store.readDeliveryState(userUuid)).resolves.toEqual({ status: 'user-not-found' })
  })

  it('serializes user deletion behind an already locked cross-process transition', async () => {
    const childScript = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1], { timeout: 5000 });
      db.pragma('foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE users SET uuid = uuid WHERE uuid = ?').run(process.argv[2]);
      db.prepare('INSERT INTO nextcloud_backup_user_locks (user_uuid, updated_at) VALUES (?, ?) ON CONFLICT(user_uuid) DO UPDATE SET updated_at = excluded.updated_at').run(process.argv[2], 1);
      process.stdout.write('LOCKED\\n');
      setTimeout(() => {
        db.exec('COMMIT');
        db.close();
        process.stdout.write('COMMITTED\\n');
      }, 250);
    `
    const child = spawn(process.execPath, ['-e', childScript, databasePath, userUuid], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (output += chunk))
    child.stderr.on('data', (chunk: string) => (errorOutput += chunk))

    const childCompletion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Child completion timeout: ${errorOutput}`))
      }, 5_000)
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Child failed (${code}): ${errorOutput}`))
        }
      })
    })
    void childCompletion.catch(() => undefined)
    const childLocked = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Child lock timeout: ${errorOutput}`)), 5_000)
      const inspect = () => {
        if (output.includes('LOCKED')) {
          clearTimeout(timeout)
          resolve()
        }
      }
      child.stdout.on('data', inspect)
      child.once('error', reject)
      child.once('exit', (code) => {
        if (!output.includes('LOCKED')) {
          clearTimeout(timeout)
          reject(new Error(`Child exited before locking (${code}): ${errorOutput}`))
        }
      })
    })

    try {
      await childLocked
      await firstDataSource.getRepository(User).delete({ uuid: userUuid })
      await childCompletion

      expect(output).toContain('COMMITTED')
      expect(await firstDataSource.getRepository(TypeORMNextcloudBackupUserLock).countBy({ userUuid })).toBe(0)
      await expect(createStore(firstDataSource).readDeliveryState(userUuid)).resolves.toEqual({
        status: 'user-not-found',
      })
    } finally {
      if (child.exitCode === null) {
        child.kill()
      }
      await childCompletion.catch(() => undefined)
    }
  })
})
