import { createHmac } from 'crypto'
import { DataSource } from 'typeorm'
import { SQLCollaborationSaveFence, type CollaborationSaveFenceRequest } from './SQLCollaborationSaveFence'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'
import { CollaborationSaveFences1791936000001 } from '../../../migrations/sqlite/1791936000001-collaboration-save-fences'
import {
  ContentType,
  Dates,
  Timestamps,
  UniqueEntityId,
  Uuid,
  runSharedSqliteTransaction,
} from '@standardnotes/domain-core'
import { mkdtempSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Logger } from 'winston'
import { Item } from '../../Domain/Item/Item'
import { SQLItem } from './SQLItem'
import { SQLItemRepository } from './SQLItemRepository'
import { TransactionAwareItemRepository } from './TransactionAwareItemRepository'
import { SQLItemPersistenceMapper } from '../../Mapping/Persistence/SQLItemPersistenceMapper'

const ROOM = '00000000-0000-0000-0000-000000000001'
const ALICE = '00000000-0000-0000-0000-000000000002'
const BOB = '00000000-0000-0000-0000-000000000003'
const SECRET = 'test-server-secret'

describe('SQL collaboration save fence commit boundary', () => {
  let source: DataSource
  let context: SyncCommandTransactionContext
  let fence: SQLCollaborationSaveFence
  let now: number
  const identity = (userUuid: string): CollaborationSaveFenceRequest => ({
    room: ROOM,
    userUuid,
    deviceId: `device-${userUuid}`,
    leaseId: `lease-${userUuid}`,
    roomEpoch: 'room-epoch',
    action: 'claim',
  })
  beforeEach(async () => {
    now = 1_791_936_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    source = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [SQLItem], synchronize: true })
    await source.initialize()
    const runner = source.createQueryRunner()
    await new CollaborationSaveFences1791936000001().up(runner)
    await source.query('CREATE TABLE test_notes (uuid varchar(36) PRIMARY KEY, content text)')
    await source.query('INSERT INTO test_notes VALUES (?, ?)', [ROOM, 'original'])
    context = new SyncCommandTransactionContext()
    fence = new SQLCollaborationSaveFence(source, context, SECRET)
  })
  afterEach(async () => {
    await source.destroy()
    jest.restoreAllMocks()
  })
  const proof = (token: string, userUuid: string) => ({
    deviceId: identity(userUuid).deviceId,
    proofs: [{ room: ROOM, token }],
  })
  const write = async (value: string) =>
    context.manager!.query('UPDATE test_notes SET content=? WHERE uuid=?', [value, ROOM])

  it('rejects foreign or stale release bindings and cannot release a successor fence', async () => {
    const lease = await fence.request(identity(ALICE))
    for (const patch of [
      { userUuid: BOB },
      { deviceId: 'another-device' },
      { leaseId: 'another-lease' },
      { roomEpoch: 'another-epoch' },
      { token: 'f'.repeat(64) },
    ]) {
      await expect(
        fence.request({ ...identity(ALICE), action: 'release', token: lease.token, ...patch }),
      ).rejects.toMatchObject({ code: 'collaboration_save_fence_lost' })
    }
    await expect(fence.request({ ...identity(ALICE), action: 'renew', token: lease.token })).resolves.toMatchObject({
      token: lease.token,
    })
    now += 30_000
    const successor = await fence.request(identity(BOB))
    await expect(fence.request({ ...identity(ALICE), action: 'release', token: lease.token })).rejects.toMatchObject({
      code: 'collaboration_save_fence_lost',
    })
    await fence.run(BOB, [ROOM], proof(successor.token!, BOB), () => write('successor-still-authorized'))
    expect(await source.query('SELECT content FROM test_notes WHERE uuid=?', [ROOM])).toEqual([
      { content: 'successor-still-authorized' },
    ])
  })

  it('holds the note lock through commit: a takeover waits for an already-dispatched slow save', async () => {
    const leaseA = await fence.request(identity(ALICE))
    let allowWrite!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const delayed = new Promise<void>((resolve) => {
      allowWrite = resolve
    })
    const saveA = fence.run(ALICE, [ROOM], proof(leaseA.token!, ALICE), async () => {
      entered()
      await delayed
      await write('alice-committed-before-takeover')
    })
    await started
    now += 30_000
    let claimed = false
    const claimB = fence.request(identity(BOB)).then((lease) => {
      claimed = true
      return lease
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(claimed).toBe(false)
    allowWrite()
    await saveA
    const leaseB = await claimB
    expect(leaseB.token).not.toBe(leaseA.token)
    expect((await source.query('SELECT content FROM test_notes'))[0].content).toBe('alice-committed-before-takeover')
    let oldWriteRan = false
    await expect(
      fence.run(ALICE, [ROOM], proof(leaseA.token!, ALICE), async () => {
        oldWriteRan = true
        await write('stale-alice')
      }),
    ).rejects.toMatchObject({ code: 'collaboration_save_fence_lost' })
    expect(oldWriteRan).toBe(false)
    await fence.run(BOB, [ROOM], proof(leaseB.token!, BOB), () => write('bob-current'))
    expect((await source.query('SELECT content FROM test_notes'))[0].content).toBe('bob-current')
  })

  it('fences the real transaction-aware item repository and persists the replacement ciphertext', async () => {
    const mapper = new SQLItemPersistenceMapper()
    const logger = { error: jest.fn() } as unknown as Logger
    const base = new SQLItemRepository(source.getRepository(SQLItem), mapper, logger)
    const repository = new TransactionAwareItemRepository(base, context, mapper, logger)
    const note = Item.create(
      {
        duplicateOf: null,
        itemsKeyId: 'items-key',
        content: 'ciphertext-original',
        contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
        encItemKey: 'encrypted-key',
        authHash: 'auth-hash',
        userUuid: Uuid.create(ALICE).getValue(),
        deleted: false,
        updatedWithSession: null,
        dates: Dates.create(new Date(1), new Date(100)).getValue(),
        timestamps: Timestamps.create(100, 100).getValue(),
      },
      new UniqueEntityId(ROOM),
    ).getValue()
    await base.insert(note)
    const leaseA = await fence.request(identity(ALICE))
    let enter!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => {
      enter = resolve
    })
    const delayed = new Promise<void>((resolve) => {
      finish = resolve
    })
    const saveA = fence.run(
      ALICE,
      [ROOM],
      proof(leaseA.token!, ALICE),
      async () => {
        const current = (await repository.findByUuid(Uuid.create(ROOM).getValue()))!
        enter()
        await delayed
        current.props.content = 'ciphertext-alice'
        current.props.timestamps = Timestamps.create(100, 200).getValue()
        current.props.dates = Dates.create(new Date(1), new Date(200)).getValue()
        await repository.update(current, { userUuid: ALICE, updatedAtTimestamp: 100 })
      },
      [ROOM],
    )
    await started
    now += 30_000
    const nextClaim = fence.request(identity(BOB))
    finish()
    await saveA
    const leaseB = await nextClaim
    await expect(
      fence.run(
        ALICE,
        [ROOM],
        proof(leaseA.token!, ALICE),
        async () => {
          note.props.content = 'ciphertext-stale'
          await repository.update(note, { userUuid: ALICE, updatedAtTimestamp: 200 })
        },
        [ROOM],
      ),
    ).rejects.toMatchObject({ code: 'collaboration_save_fence_lost' })
    await fence.run(
      BOB,
      [ROOM],
      proof(leaseB.token!, BOB),
      async () => {
        const current = (await repository.findByUuid(Uuid.create(ROOM).getValue()))!
        expect(current.props.content).toBe('ciphertext-alice')
        current.props.content = 'ciphertext-bob-current'
        current.props.timestamps = Timestamps.create(100, 300).getValue()
        current.props.dates = Dates.create(new Date(1), new Date(300)).getValue()
        await repository.update(current, { userUuid: ALICE, updatedAtTimestamp: 200 })
      },
      [ROOM],
    )
    expect((await base.findByUuid(Uuid.create(ROOM).getValue()))?.props.content).toBe('ciphertext-bob-current')
  })

  it('does not create saver rows for ordinary other item types', async () => {
    await fence.run(ALICE, [ROOM], undefined, async () => undefined, [])
    expect(await source.query('SELECT * FROM collaboration_save_fences')).toEqual([])
  })

  it('serializes an auth replica transaction on another datasource sharing the same SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'srn-save-fence-'))
    const database = join(directory, 'shared.sqlite')
    const syncSource = new DataSource({ type: 'better-sqlite3', database })
    const authSource = new DataSource({ type: 'better-sqlite3', database })
    try {
      await syncSource.initialize()
      await new CollaborationSaveFences1791936000001().up(syncSource.createQueryRunner())
      await syncSource.query('CREATE TABLE auth_shared_vault_replica_lock (value integer)')
      await syncSource.query('INSERT INTO auth_shared_vault_replica_lock VALUES (0)')
      await authSource.initialize()
      const syncContext = new SyncCommandTransactionContext()
      const service = new SQLCollaborationSaveFence(syncSource, syncContext, SECRET)
      const lease = await service.request(identity(ALICE))
      let finish!: () => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const delayed = new Promise<void>((resolve) => {
        finish = resolve
      })
      const save = service.run(ALICE, [ROOM], proof(lease.token!, ALICE), async () => {
        entered()
        await delayed
        await syncContext.manager!.query('UPDATE auth_shared_vault_replica_lock SET value=1')
      })
      await started
      let authEntered = false
      const reconcile = runSharedSqliteTransaction(authSource, database, () =>
        authSource.transaction(async (manager) => {
          authEntered = true
          await manager.query('UPDATE auth_shared_vault_replica_lock SET value=2')
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(authEntered).toBe(false)
      finish()
      await Promise.all([save, reconcile])
      expect(authEntered).toBe(true)
      expect((await syncSource.query('SELECT value FROM auth_shared_vault_replica_lock'))[0].value).toBe(2)
    } finally {
      if (authSource.isInitialized) {
        await authSource.destroy()
      }
      if (syncSource.isInitialized) {
        await syncSource.destroy()
      }
      unlinkSync(database)
      rmdirSync(directory)
    }
  })

  it('rejects active competing owners, other authenticated devices, unproved HTTP writes and expired proofs', async () => {
    const lease = await fence.request(identity(ALICE))
    await expect(fence.request(identity(BOB))).rejects.toMatchObject({ code: 'collaboration_save_fence_busy' })
    await expect(fence.run(ALICE, [ROOM], undefined, () => write('http'))).rejects.toMatchObject({
      code: 'collaboration_save_fence_lost',
    })
    await expect(
      fence.run(ALICE, [ROOM], { ...proof(lease.token!, ALICE), deviceId: 'other-device' }, () => write('other')),
    ).rejects.toMatchObject({ code: 'collaboration_save_fence_lost' })
    now += 30_000
    await expect(fence.run(ALICE, [ROOM], proof(lease.token!, ALICE), () => write('expired'))).rejects.toMatchObject({
      code: 'collaboration_save_fence_lost',
    })
    await fence.run(ALICE, [ROOM], undefined, () => write('ordinary-after-expiry'))
  })

  it('renews the exact owner and invalidates delayed proof after release', async () => {
    const lease = await fence.request(identity(ALICE))
    now += 5_000
    const renewed = await fence.request({ ...identity(ALICE), action: 'renew', token: lease.token })
    expect(renewed.token).toBe(lease.token)
    expect(renewed.expiresAt).toBeGreaterThan(lease.expiresAt)
    await fence.request({ ...identity(ALICE), action: 'release', token: lease.token })
    await expect(fence.run(ALICE, [ROOM], proof(lease.token!, ALICE), () => write('old'))).rejects.toMatchObject({
      code: 'collaboration_save_fence_lost',
    })
    await fence.run(ALICE, [ROOM], undefined, () => write('ordinary-after-release'))
  })

  it('authenticates gateway claims and write proofs and binds the proof to the user and device', () => {
    const body = identity(ALICE)
    const timestamp = String(now)
    const signature = createHmac('sha256', SECRET)
      .update(`save-fence:${timestamp}:${JSON.stringify(body)}`)
      .digest('hex')
    expect(fence.verifyRequest(body, timestamp, signature)).toEqual(body)
    expect(() => fence.verifyRequest({ ...body, userUuid: BOB }, timestamp, signature)).toThrow()
    const proofs = [{ room: ROOM, token: 'a'.repeat(64) }]
    const signed = { userUuid: ALICE, deviceId: body.deviceId, proofs }
    const proofBody = {
      collaboration_save_fences: proofs,
      collaboration_save_fence_device_id: body.deviceId,
      collaboration_save_fence_timestamp: timestamp,
      collaboration_save_fence_signature: createHmac('sha256', SECRET)
        .update(`save-proof:${timestamp}:${JSON.stringify(signed)}`)
        .digest('hex'),
    }
    expect(fence.readWriteContext(proofBody, ALICE)).toEqual({ deviceId: body.deviceId, proofs })
    expect(() => fence.readWriteContext(proofBody, BOB)).toThrow()
    expect(() =>
      fence.readWriteContext({ ...proofBody, collaboration_save_fence_device_id: 'spoofed' }, ALICE),
    ).toThrow()
    now += 31_000
    expect(() => fence.readWriteContext(proofBody, ALICE)).toThrow()
  })
})
