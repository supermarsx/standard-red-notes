/* eslint-disable @typescript-eslint/no-explicit-any */
import { ContentType, Dates, Result, Timestamps, UniqueEntityId, Uuid } from '@standardnotes/domain-core'
import { Timer } from '@standardnotes/time'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'

import { Item } from '../../../Item/Item'
import { ItemHash } from '../../../Item/ItemHash'
import { ItemTransferCalculator } from '../../../Item/ItemTransferCalculator'
import { ItemSaveValidator } from '../../../Item/SaveValidator/ItemSaveValidator'
import { ContentFilter } from '../../../Item/SaveRule/ContentFilter'
import { ContentTypeFilter } from '../../../Item/SaveRule/ContentTypeFilter'
import { OwnershipFilter } from '../../../Item/SaveRule/OwnershipFilter'
import { TimeDifferenceFilter } from '../../../Item/SaveRule/TimeDifferenceFilter'
import { SharedVaultAssociation } from '../../../SharedVault/SharedVaultAssociation'
import { SQLItem } from '../../../../Infra/TypeORM/SQLItem'
import { SQLItemRepository } from '../../../../Infra/TypeORM/SQLItemRepository'
import { SQLItemPersistenceMapper } from '../../../../Mapping/Persistence/SQLItemPersistenceMapper'
import { GetItems } from '../GetItems/GetItems'
import { SaveItems } from '../SaveItems/SaveItems'
import { SaveNewItem } from '../SaveNewItem/SaveNewItem'
import { UpdateExistingItem } from '../UpdateExistingItem/UpdateExistingItem'
import { SyncItems } from './SyncItems'
import { SyncItemsDTO } from './SyncItemsDTO'
import { SyncItemsResponse } from './SyncItemsResponse'
import { encodeSyncToken } from '../SyncToken'

/**
 * Standard Red Notes (t99) — the sync-horizon harness and its three defects.
 *
 * A REAL sync stack (real GetItems, real SaveItems, real SaveNewItem /
 * UpdateExistingItem, real SQLItemRepository) over a real SQLite database, so
 * the response token can be checked against what the rows actually say. The
 * 949-test unit suite is green over the token defect precisely because every
 * one of its repositories is a stub: nothing in it can observe a write that
 * lands between the retrieval snapshot and the end of the save loop.
 *
 * Every assertion here also reads the rows back raw, bypassing every mapper,
 * because the failure mode under investigation is "the row is present with
 * deleted = 0 and the server still tells the client it has it".
 */

const USER_A = '00000000-0000-0000-0000-00000000000a'
const USER_B = '00000000-0000-0000-0000-00000000000b'
const SESSION_A = '00000000-0000-0000-0000-0000000000a1'
const SESSION_PEER = '00000000-0000-0000-0000-0000000000a2'
const VAULT_V = '00000000-0000-0000-0000-0000000000f1'

type Harness = {
  dataSource: DataSource
  repository: SQLItemRepository
  syncItems: SyncItems
  timer: Timer
  /** Runs before each item of the save loop; index is 0-based. */
  onSaveLoopItem?: (index: number) => Promise<void>
  /** Runs inside SaveItems before it stamps its own request clock. */
  onBeforeSaveLoop?: () => Promise<void>
  /** Runs immediately after the retrieval's first read of rows returns. */
  onAfterFirstRowRead?: () => Promise<void>
  destroy: () => Promise<void>
}

const makeLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as Logger

const buildHarness = async (options?: { vaultUuidsForUser?: string[] }): Promise<Harness> => {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [SQLItem],
    synchronize: true,
  })
  await dataSource.initialize()

  const timer = new Timer()
  const log = makeLogger()
  const repository = new SQLItemRepository(dataSource.getRepository(SQLItem), new SQLItemPersistenceMapper(), log)

  const sharedVaultUsers = (options?.vaultUuidsForUser ?? []).map((vaultUuid) => ({
    props: { sharedVaultUuid: Uuid.create(vaultUuid).getValue() },
  }))
  const sharedVaultUserRepository = {
    findByUserUuid: jest.fn().mockResolvedValue(sharedVaultUsers),
    findByUserUuidAndSharedVaultUuid: jest.fn().mockResolvedValue(null),
  } as any

  // Wrap the retrieval's FIRST read of rows so a test can commit a peer write in
  // the sliver between that read and the horizon capture. If the horizon were
  // taken after the read instead of before it, that write would sit below the
  // horizon while being absent from the response — the original defect, smaller.
  const instrumentedRepository = Object.create(repository) as SQLItemRepository
  instrumentedRepository.findContentSizeForComputingTransferLimit = async (query) => {
    const descriptors = await repository.findContentSizeForComputingTransferLimit(query)
    if (harness.onAfterFirstRowRead) {
      await harness.onAfterFirstRowRead()
    }

    return descriptors
  }

  const getItems = new GetItems(
    instrumentedRepository,
    sharedVaultUserRepository,
    10_000_000,
    new ItemTransferCalculator(log),
    timer,
    150,
  )

  const harness: Harness = {
    dataSource,
    repository,
    timer,
    syncItems: undefined as unknown as SyncItems,
    destroy: async () => {
      await dataSource.destroy()
    },
  }

  const domainEventPublisher = { publish: jest.fn() } as any
  const domainEventFactory = {
    createItemsChangedOnServerEvent: jest
      .fn()
      .mockReturnValue({ type: 'ITEMS_CHANGED_ON_SERVER', createdAt: new Date(), meta: {}, payload: {} }),
    createItemRevisionCreationRequested: jest.fn().mockReturnValue({}),
    createItemDumpedEvent: jest.fn().mockReturnValue({}),
    createUserNotificationEvent: jest.fn().mockReturnValue({}),
    createWebSocketMessageRequestedEvent: jest.fn().mockReturnValue({}),
  } as any
  const metricsStore = { storeMetric: jest.fn() } as any

  const saveNewItem = new SaveNewItem(repository, timer, domainEventPublisher, domainEventFactory, metricsStore, log)
  const updateExistingItem = new UpdateExistingItem(
    repository,
    timer,
    domainEventPublisher,
    domainEventFactory,
    1,
    1,
    { execute: jest.fn().mockResolvedValue(Result.ok(null)) } as any,
    { execute: jest.fn().mockResolvedValue(Result.ok(undefined)) } as any,
    { execute: jest.fn().mockResolvedValue(Result.ok(undefined)) } as any,
    metricsStore,
    log,
  )

  // The save loop runs item-by-item; this wrapper lets a test land a peer
  // device's commit in the middle of it, which is exactly the window the
  // response token overshoots.
  let saveLoopIndex = 0
  const hook = {
    execute: async (dto: any) => {
      const index = saveLoopIndex++
      if (harness.onSaveLoopItem) {
        await harness.onSaveLoopItem(index)
      }

      return dto.existingItem !== undefined ? updateExistingItem.execute(dto) : saveNewItem.execute(dto)
    },
  }

  const saveItems = new SaveItems(
    new ItemSaveValidator([
      new OwnershipFilter(),
      new TimeDifferenceFilter(timer),
      new ContentTypeFilter(),
      new ContentFilter(),
    ]),
    repository,
    timer,
    hook as unknown as SaveNewItem,
    hook as unknown as UpdateExistingItem,
    { execute: jest.fn().mockResolvedValue(Result.ok(undefined)) } as any,
    { execute: jest.fn().mockResolvedValue(Result.ok(undefined)) } as any,
    domainEventFactory,
    {
      execute: async () => {
        if (harness.onBeforeSaveLoop) {
          await harness.onBeforeSaveLoop()
        }

        return Result.ok(undefined)
      },
    } as any,
    { toProjection: jest.fn().mockReturnValue({}) } as any,
    false,
    50,
    200 * 1024,
    log,
  )

  harness.syncItems = new SyncItems(
    repository,
    getItems,
    saveItems,
    { execute: jest.fn().mockResolvedValue(Result.ok({ sharedVaults: [] })) } as any,
    { execute: jest.fn().mockResolvedValue(Result.ok([])) } as any,
    { execute: jest.fn().mockResolvedValue(Result.ok([])) } as any,
    { execute: jest.fn().mockResolvedValue(Result.ok([])) } as any,
    log,
  )

  return harness
}

const seedItem = async (
  harness: Harness,
  uuid: string,
  userUuid: string,
  updatedAtTimestamp: number,
  overrides?: { sharedVaultUuid?: string; content?: string; updatedWithSession?: string | null },
): Promise<void> => {
  const item = Item.create(
    {
      duplicateOf: null,
      itemsKeyId: 'items-key',
      content: overrides?.content ?? 'seeded',
      contentType: ContentType.create(ContentType.TYPES.Note).getValue(),
      encItemKey: 'enc-key',
      authHash: null,
      userUuid: Uuid.create(userUuid).getValue(),
      deleted: false,
      updatedWithSession: overrides?.updatedWithSession ? Uuid.create(overrides.updatedWithSession).getValue() : null,
      sharedVaultAssociation: overrides?.sharedVaultUuid
        ? SharedVaultAssociation.create({
            lastEditedBy: Uuid.create(userUuid).getValue(),
            sharedVaultUuid: Uuid.create(overrides.sharedVaultUuid).getValue(),
          }).getValue()
        : undefined,
      dates: Dates.create(new Date(1), new Date(Math.floor(updatedAtTimestamp / 1000))).getValue(),
      timestamps: Timestamps.create(1_000, updatedAtTimestamp).getValue(),
    } as any,
    new UniqueEntityId(uuid),
  ).getValue()

  await harness.repository.insert(item)
}

/** A client-side save of `uuid` with fresh content, as the app would send it. */
const itemHashFor = (uuid: string, userUuid: string, content: string, updatedAtTimestamp: number): ItemHash =>
  ItemHash.create({
    uuid,
    content,
    updated_at_timestamp: updatedAtTimestamp,
    content_type: ContentType.TYPES.Note,
    enc_item_key: 'enc-key',
    items_key_id: 'items-key',
    user_uuid: userUuid,
    duplicate_of: null,
    key_system_identifier: null,
    shared_vault_uuid: null,
    deleted: false,
  } as any).getValue()

const syncDto = (overrides: Partial<SyncItemsDTO>): SyncItemsDTO => ({
  userUuid: USER_A,
  itemHashes: [],
  computeIntegrityHash: false,
  apiVersion: '20200115',
  snjsVersion: '2.200.0',
  readOnlyAccess: false,
  sessionUuid: SESSION_A,
  isFreeUser: false,
  hasContentLimit: true,
  liveSyncEnabled: false,
  ...overrides,
})

/** The microsecond position a v2 sync token encodes. */
const tokenMicros = (token: string): number => {
  const parts = Buffer.from(token, 'base64').toString('utf-8').split(':')

  return Math.round(Number(parts[1]) * 1_000_000)
}

const v3Cursor = (micros: number, uuid: string): string =>
  Buffer.from(`3:${micros}:${uuid}`, 'utf-8').toString('base64')

const v2Token = (micros: number): string => Buffer.from(`2:${micros / 1_000_000}`, 'utf-8').toString('base64')

/** Raw rows, straight out of the database, bypassing every mapper. */
const rawRows = async (harness: Harness, userUuid?: string): Promise<any[]> => {
  const where = userUuid ? ` WHERE user_uuid = '${userUuid}'` : ''

  return harness.dataSource.query(
    `SELECT uuid, user_uuid, deleted, updated_at_timestamp, updated_with_session, shared_vault_uuid FROM items${where} ORDER BY updated_at_timestamp ASC`,
  )
}

/**
 * Follow a sync token to exhaustion: keep paging on cursorToken until the
 * server stops handing one out, and return every uuid delivered along the way.
 * Pagination is NOT an escape hatch for this defect and this proves it.
 */
const pullToExhaustion = async (
  harness: Harness,
  syncToken: string,
  extra?: Partial<SyncItemsDTO>,
): Promise<{ uuids: string[]; sawCursor: boolean; lastResponse: SyncItemsResponse }> => {
  const uuids: string[] = []
  let cursorToken: string | undefined = undefined
  let sawCursor = false
  let lastResponse: SyncItemsResponse | undefined = undefined

  for (let page = 0; page < 50; page++) {
    const result = await harness.syncItems.execute(syncDto({ syncToken, cursorToken, ...extra }))
    if (result.isFailed()) {
      throw new Error(`pull failed: ${result.getError()}`)
    }
    lastResponse = result.getValue()
    uuids.push(...lastResponse.retrievedItems.map((item) => item.id.toString()))
    cursorToken = lastResponse.cursorToken
    if (cursorToken === undefined) {
      break
    }
    sawCursor = true
  }

  return { uuids, sawCursor, lastResponse: lastResponse as SyncItemsResponse }
}

describe('t99 defect 1 — the response token comes from the SAVE half, the items from the GET half', () => {
  const TRIALS = 10

  /**
   * One trial: the client holds `syncToken`, saves `batchSize` of its own
   * items, and a PEER DEVICE commits one brand-new item in the middle of that
   * save loop. Returns whether the peer's item is ever delivered when the
   * response token is followed to exhaustion.
   */
  const runTrial = async (
    batchSize: number,
    trial: number,
  ): Promise<{ delivered: boolean; overshootMicros: number; peerUuid: string; rowsPresent: boolean }> => {
    const harness = await buildHarness()
    try {
      const ownUuids: string[] = []
      for (let i = 0; i < Math.max(batchSize, 1); i++) {
        const uuid = `00000000-0000-0000-0000-${(100 + i).toString().padStart(12, '0')}`
        ownUuids.push(uuid)
        await seedItem(harness, uuid, USER_A, 1_000_000 + i)
      }

      const first = await harness.syncItems.execute(syncDto({}))
      const baseToken = first.getValue().syncToken

      const peerUuid = `00000000-0000-0000-0000-${(900 + trial).toString().padStart(12, '0')}`
      let peerCommittedAt = 0
      const commitPeerWrite = async () => {
        if (peerCommittedAt !== 0) {
          return
        }
        peerCommittedAt = harness.timer.getTimestampInMicroseconds()
        await seedItem(harness, peerUuid, USER_A, peerCommittedAt, {
          content: 'written by the other device',
          updatedWithSession: SESSION_PEER,
        })
      }

      if (batchSize === 0) {
        harness.onBeforeSaveLoop = commitPeerWrite
      } else {
        const landAt = Math.floor(batchSize / 2)
        harness.onSaveLoopItem = async (index) => {
          if (index === landAt) {
            await commitPeerWrite()
          }
        }
      }

      const itemHashes = ownUuids
        .slice(0, batchSize)
        .map((uuid, index) => itemHashFor(uuid, USER_A, `rewritten-${trial}`, 1_000_000 + index))

      const saving = await harness.syncItems.execute(syncDto({ syncToken: baseToken, itemHashes }))
      expect(saving.isFailed()).toBe(false)
      const response = saving.getValue()
      expect(response.savedItems).toHaveLength(batchSize)

      const returnedToken = tokenMicros(response.syncToken)
      const overshootMicros = returnedToken - peerCommittedAt

      // The peer's item was not in this response (it was committed after the
      // retrieval snapshot), so the ONLY way the client can ever see it is the
      // next pull with the token this response handed back.
      expect(response.retrievedItems.map((item) => item.id.toString())).not.toContain(peerUuid)

      const next = await pullToExhaustion(harness, response.syncToken)
      expect(next.sawCursor).toBe(false)

      const rows = await rawRows(harness, USER_A)
      const peerRow = rows.find((row) => row.uuid === peerUuid)

      return {
        delivered: next.uuids.includes(peerUuid),
        overshootMicros,
        peerUuid,
        rowsPresent: peerRow !== undefined && peerRow.deleted === 0,
      }
    } finally {
      await harness.destroy()
    }
  }

  for (const batchSize of [0, 1, 3, 10, 25]) {
    it(`delivers a concurrent write with a client batch of ${batchSize} items`, async () => {
      let lost = 0
      let maxOvershoot = Number.NEGATIVE_INFINITY
      let minOvershoot = Number.POSITIVE_INFINITY

      for (let trial = 0; trial < TRIALS; trial++) {
        const outcome = await runTrial(batchSize, trial)
        // Nothing is ever deleted server-side; the row is present either way.
        expect(outcome.rowsPresent).toBe(true)
        if (!outcome.delivered) {
          lost++
        }
        maxOvershoot = Math.max(maxOvershoot, outcome.overshootMicros)
        minOvershoot = Math.min(minOvershoot, outcome.overshootMicros)
      }

      // eslint-disable-next-line no-console
      console.log(`[t99 d1] batch=${batchSize} lost=${lost}/${TRIALS} overshoot=${minOvershoot}..${maxOvershoot}us`)

      expect(lost).toBe(0)
    })
  }
})

describe('t99 defect 2 — a well-formed cursor for an impossible position', () => {
  it('rejects a cursor issued for another account instead of answering an empty success', async () => {
    const harness = await buildHarness()
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000001', USER_A, 1_000_000)
      await seedItem(harness, '00000000-0000-0000-0000-000000000002', USER_A, 1_000_001)
      await seedItem(harness, '00000000-0000-0000-0000-0000000000b1', USER_B, 9_000_000)

      // Account B's real position, replayed verbatim on account A.
      const foreignCursor = v3Cursor(9_000_000, '00000000-0000-0000-0000-0000000000b1')

      const result = await harness.syncItems.execute(syncDto({ cursorToken: foreignCursor }))

      const rows = await rawRows(harness)
      expect(rows.filter((row) => row.user_uuid === USER_A)).toHaveLength(2)
      expect(rows.every((row) => row.deleted === 0)).toBe(true)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toMatch(/cursor/i)
    } finally {
      await harness.destroy()
    }
  })

  it('rejects a position beyond the server clock instead of answering an empty success', async () => {
    const harness = await buildHarness()
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000001', USER_A, 1_000_000)
      const oneYearAhead = harness.timer.getTimestampInMicroseconds() + 365 * 24 * 3600 * 1_000_000

      const cursorResult = await harness.syncItems.execute(
        syncDto({ cursorToken: v3Cursor(oneYearAhead, '00000000-0000-0000-0000-000000000001') }),
      )
      expect(cursorResult.isFailed()).toBe(true)

      const tokenResult = await harness.syncItems.execute(syncDto({ syncToken: v2Token(oneYearAhead) }))
      expect(tokenResult.isFailed()).toBe(true)

      const rows = await rawRows(harness, USER_A)
      expect(rows).toHaveLength(1)
      expect(rows[0].deleted).toBe(0)
    } finally {
      await harness.destroy()
    }
  })

  it('still honours a cursor that names a row this account can see', async () => {
    const harness = await buildHarness({ vaultUuidsForUser: [VAULT_V] })
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000001', USER_A, 1_000_000)
      await seedItem(harness, '00000000-0000-0000-0000-000000000002', USER_A, 2_000_000)
      // A vault row owned by SOMEONE ELSE but visible to A through the vault:
      // a page can legitimately end on it, so its cursor must be honoured.
      await seedItem(harness, '00000000-0000-0000-0000-000000000003', USER_B, 1_500_000, {
        sharedVaultUuid: VAULT_V,
      })

      const own = await harness.syncItems.execute(
        syncDto({ cursorToken: v3Cursor(1_000_000, '00000000-0000-0000-0000-000000000001') }),
      )
      expect(own.isFailed()).toBe(false)
      expect(own.getValue().retrievedItems.map((item) => item.id.toString())).toEqual([
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
      ])

      const viaVault = await harness.syncItems.execute(
        syncDto({ cursorToken: v3Cursor(1_500_000, '00000000-0000-0000-0000-000000000003') }),
      )
      expect(viaVault.isFailed()).toBe(false)
      expect(viaVault.getValue().retrievedItems.map((item) => item.id.toString())).toEqual([
        '00000000-0000-0000-0000-000000000002',
      ])
    } finally {
      await harness.destroy()
    }
  })

  it('still rejects a malformed token with a failure, not an empty success', async () => {
    const harness = await buildHarness()
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000001', USER_A, 1_000_000)

      for (const token of ['not-base64-at-all', Buffer.from('9:1', 'utf-8').toString('base64')]) {
        const result = await harness.syncItems.execute(syncDto({ syncToken: token }))
        expect(result.isFailed()).toBe(true)
      }
    } finally {
      await harness.destroy()
    }
  })
})

describe('t99 defect 3 — a vault-exclusive sync must not hand back a global token', () => {
  it('does not let a vault-scoped position be replayed as a global one', async () => {
    const harness = await buildHarness({ vaultUuidsForUser: [VAULT_V] })
    try {
      for (let i = 0; i < 8; i++) {
        await seedItem(
          harness,
          `00000000-0000-0000-0000-${(200 + i).toString().padStart(12, '0')}`,
          USER_A,
          1_000_000 + i,
        )
      }
      await seedItem(harness, '00000000-0000-0000-0000-000000000300', USER_A, 1_500_000, {
        sharedVaultUuid: VAULT_V,
      })

      const vaultOnly = await harness.syncItems.execute(syncDto({ sharedVaultUuids: [VAULT_V] }))
      expect(vaultOnly.isFailed()).toBe(false)
      const vaultResponse = vaultOnly.getValue()
      expect(vaultResponse.retrievedItems.map((item) => item.id.toString())).toEqual([
        '00000000-0000-0000-0000-000000000300',
      ])

      const rows = await rawRows(harness, USER_A)
      expect(rows).toHaveLength(9)
      expect(rows.every((row) => row.deleted === 0)).toBe(true)

      // Presenting the vault-exclusive sync's token on a NORMAL sync must not
      // report "you are fully caught up" for an account that owns 9 items.
      const replayed = await harness.syncItems.execute(syncDto({ syncToken: vaultResponse.syncToken }))
      if (replayed.isFailed()) {
        expect(replayed.getError()).toMatch(/scope/i)
      } else {
        expect(replayed.getValue().retrievedItems).toHaveLength(9)
      }
    } finally {
      await harness.destroy()
    }
  })

  it('keeps a vault-exclusive token usable for the same vault scope', async () => {
    const harness = await buildHarness({ vaultUuidsForUser: [VAULT_V] })
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000300', USER_A, 1_500_000, {
        sharedVaultUuid: VAULT_V,
      })

      const first = await harness.syncItems.execute(syncDto({ sharedVaultUuids: [VAULT_V] }))
      const token = first.getValue().syncToken

      await seedItem(harness, '00000000-0000-0000-0000-000000000301', USER_A, Date.now() * 1000 + 5_000_000, {
        sharedVaultUuid: VAULT_V,
      })

      const second = await harness.syncItems.execute(syncDto({ syncToken: token, sharedVaultUuids: [VAULT_V] }))
      expect(second.isFailed()).toBe(false)
      expect(second.getValue().retrievedItems.map((item) => item.id.toString())).toEqual([
        '00000000-0000-0000-0000-000000000301',
      ])
    } finally {
      await harness.destroy()
    }
  })

  it('accepts a global token on a vault-exclusive sync, which can only over-deliver', async () => {
    const harness = await buildHarness({ vaultUuidsForUser: [VAULT_V] })
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000200', USER_A, 1_000_000)
      await seedItem(harness, '00000000-0000-0000-0000-000000000300', USER_A, 1_500_000, {
        sharedVaultUuid: VAULT_V,
      })

      const global = await harness.syncItems.execute(syncDto({}))
      const globalToken = global.getValue().syncToken

      const vaultScoped = await harness.syncItems.execute(
        syncDto({ syncToken: globalToken, sharedVaultUuids: [VAULT_V] }),
      )
      expect(vaultScoped.isFailed()).toBe(false)
      expect(vaultScoped.getValue().retrievedItems).toHaveLength(0)
    } finally {
      await harness.destroy()
    }
  })
})

describe('t99 defect 1 — the own-write skip, and the ceiling that keeps it safe', () => {
  const saveOneItem = async (harness: Harness, uuid: string, baseToken: string, sessionUuid: string | null) => {
    const row = (await rawRows(harness, USER_A)).find((candidate) => candidate.uuid === uuid)

    return harness.syncItems.execute(
      syncDto({
        syncToken: baseToken,
        sessionUuid,
        itemHashes: [itemHashFor(uuid, USER_A, 'edited', row.updated_at_timestamp)],
      }),
    )
  }

  it('does not re-deliver the writes of this request when the column identifies the writer', async () => {
    const harness = await buildHarness()
    try {
      const uuid = '00000000-0000-0000-0000-000000000101'
      await seedItem(harness, uuid, USER_A, 1_000_000)

      const first = await harness.syncItems.execute(syncDto({}))
      const saving = await saveOneItem(harness, uuid, first.getValue().syncToken, SESSION_A)
      expect(saving.getValue().savedItems).toHaveLength(1)

      const rows = await rawRows(harness, USER_A)
      expect(rows[0].updated_with_session).toEqual(SESSION_A)
      expect(rows[0].deleted).toBe(0)

      const next = await pullToExhaustion(harness, saving.getValue().syncToken)
      expect(next.uuids).toEqual([])
    } finally {
      await harness.destroy()
    }
  })

  it('re-delivers its own writes when the column is NULL, rather than withholding them', async () => {
    // The session is not propagated into the sync context on every topology, so
    // `updated_with_session` is NULL there. "We cannot tell who wrote this" must
    // resolve to handing it back again, never to skipping it.
    const harness = await buildHarness()
    try {
      const uuid = '00000000-0000-0000-0000-000000000101'
      await seedItem(harness, uuid, USER_A, 1_000_000)

      const first = await harness.syncItems.execute(syncDto({ sessionUuid: null }))
      const saving = await saveOneItem(harness, uuid, first.getValue().syncToken, null)
      expect(saving.getValue().savedItems).toHaveLength(1)

      const rows = await rawRows(harness, USER_A)
      expect(rows[0].updated_with_session).toBeNull()
      expect(rows[0].deleted).toBe(0)

      const next = await pullToExhaustion(harness, saving.getValue().syncToken)
      expect(next.uuids).toEqual([uuid])
    } finally {
      await harness.destroy()
    }
  })

  it('still delivers a LATER write from the same session, which another tab on the device makes', async () => {
    // Two tabs of one browser share a session uuid. An open-ended "never deliver
    // my own session's writes" would silently withhold the peer tab's save and
    // trade this defect for a fresh one; the ceiling is what prevents that.
    const harness = await buildHarness()
    try {
      const own = '00000000-0000-0000-0000-000000000101'
      const peerTab = '00000000-0000-0000-0000-000000000102'
      await seedItem(harness, own, USER_A, 1_000_000)

      const first = await harness.syncItems.execute(syncDto({}))
      const saving = await saveOneItem(harness, own, first.getValue().syncToken, SESSION_A)
      const tokenCarryingTheSkip = saving.getValue().syncToken

      // The other tab, on the same session, saves AFTER that token was issued.
      await seedItem(harness, peerTab, USER_A, harness.timer.getTimestampInMicroseconds(), {
        content: 'the other tab',
        updatedWithSession: SESSION_A,
      })

      const next = await pullToExhaustion(harness, tokenCarryingTheSkip)
      expect(next.uuids).toEqual([peerTab])

      const rows = await rawRows(harness, USER_A)
      expect(rows.map((row) => row.updated_with_session)).toEqual([SESSION_A, SESSION_A])
      expect(rows.every((row) => row.deleted === 0)).toBe(true)
    } finally {
      await harness.destroy()
    }
  })

  it('keeps the skip off the page boundary as well as off the page', async () => {
    // The cursor, the page and the more-items count all share one query builder;
    // a skip applied to only one of them would make the cursor and the page
    // disagree and strand a row between them.
    const harness = await buildHarness()
    try {
      const uuids: string[] = []
      for (let i = 0; i < 6; i++) {
        const uuid = `00000000-0000-0000-0000-${(400 + i).toString().padStart(12, '0')}`
        uuids.push(uuid)
        await seedItem(harness, uuid, USER_A, 1_000_000 + i)
      }

      const first = await harness.syncItems.execute(syncDto({}))
      const rows = await rawRows(harness, USER_A)
      const saving = await harness.syncItems.execute(
        syncDto({
          syncToken: first.getValue().syncToken,
          itemHashes: uuids.map((uuid) =>
            itemHashFor(uuid, USER_A, 'edited', rows.find((row) => row.uuid === uuid).updated_at_timestamp),
          ),
        }),
      )
      expect(saving.getValue().savedItems).toHaveLength(6)

      // A peer device commits one row after the save loop finished.
      const peer = '00000000-0000-0000-0000-000000000499'
      await seedItem(harness, peer, USER_A, harness.timer.getTimestampInMicroseconds(), {
        updatedWithSession: SESSION_PEER,
      })

      const next = await pullToExhaustion(harness, saving.getValue().syncToken, { limit: 2 })
      expect(next.uuids).toEqual([peer])
    } finally {
      await harness.destroy()
    }
  })
})

describe('t99 defect 1 — unsynchronised concurrency, the shape the operator actually hits', () => {
  it('delivers a peer write raced against the save loop at every batch size', async () => {
    for (const batchSize of [1, 3, 10, 25]) {
      const harness = await buildHarness()
      try {
        const uuids: string[] = []
        for (let i = 0; i < batchSize; i++) {
          const uuid = `00000000-0000-0000-0000-${(600 + i).toString().padStart(12, '0')}`
          uuids.push(uuid)
          await seedItem(harness, uuid, USER_A, 1_000_000 + i)
        }

        const first = await harness.syncItems.execute(syncDto({}))
        const peer = '00000000-0000-0000-0000-000000000699'

        // No hook: the peer write is simply started at the same moment and
        // interleaves wherever the event loop puts it.
        const peerWrite = (async () => {
          await seedItem(harness, peer, USER_A, harness.timer.getTimestampInMicroseconds(), {
            updatedWithSession: SESSION_PEER,
          })
        })()

        const saving = await harness.syncItems.execute(
          syncDto({
            syncToken: first.getValue().syncToken,
            itemHashes: uuids.map((uuid, index) => itemHashFor(uuid, USER_A, 'raced', 1_000_000 + index)),
          }),
        )
        await peerWrite

        const delivered = saving.getValue().retrievedItems.map((item) => item.id.toString())
        if (!delivered.includes(peer)) {
          const next = await pullToExhaustion(harness, saving.getValue().syncToken)
          expect(next.uuids).toContain(peer)
        }

        const rows = await rawRows(harness, USER_A)
        expect(rows.find((row) => row.uuid === peer).deleted).toBe(0)
      } finally {
        await harness.destroy()
      }
    }
  })
})

describe('t99 defect 1 — the ceiling is exclusive at its own boundary', () => {
  // The ceiling is `max(own writes) + 1us`, which is the position the save half
  // would have claimed. A row sitting exactly there is a DIFFERENT write a
  // microsecond later, not one of ours, so it must still be handed over. An
  // inclusive comparison would swallow it and nothing above would notice.
  it('hands over a same-session row at the exact ceiling microsecond', async () => {
    const harness = await buildHarness()
    try {
      const atCeiling = '00000000-0000-0000-0000-000000000701'
      const belowCeiling = '00000000-0000-0000-0000-000000000702'
      await seedItem(harness, belowCeiling, USER_A, 5_000_000, { updatedWithSession: SESSION_A })
      await seedItem(harness, atCeiling, USER_A, 5_000_001, { updatedWithSession: SESSION_A })

      // A token whose skip ceiling is exactly the later row's timestamp: the
      // earlier row is ours and is skipped, the row ON the ceiling is not.
      const token = encodeSyncToken({
        positionMicroseconds: 4_000_000,
        ownWriteSessionUuid: SESSION_A,
        ownWriteCeilingMicroseconds: 5_000_000,
      })

      const pulled = await pullToExhaustion(harness, token)
      expect(pulled.uuids).toEqual([atCeiling])

      const rows = await rawRows(harness, USER_A)
      expect(rows.map((row) => row.uuid)).toEqual([belowCeiling, atCeiling])
      expect(rows.every((row) => row.deleted === 0)).toBe(true)
    } finally {
      await harness.destroy()
    }
  })
})

describe('t99 defect 1 — the two gaps a surviving mutation found', () => {
  it('delivers a row committed between the first read of rows and the horizon capture', async () => {
    // The horizon has to be taken BEFORE the retrieval reads any rows. Taken
    // after, a row committed in between is absent from the response and still
    // below the position the response claims: the same silent skip, narrower.
    const harness = await buildHarness()
    try {
      await seedItem(harness, '00000000-0000-0000-0000-000000000801', USER_A, 1_000_000)

      const first = await harness.syncItems.execute(syncDto({}))

      const peer = '00000000-0000-0000-0000-000000000899'
      harness.onAfterFirstRowRead = async () => {
        harness.onAfterFirstRowRead = undefined
        await seedItem(harness, peer, USER_A, harness.timer.getTimestampInMicroseconds(), {
          updatedWithSession: SESSION_PEER,
        })
      }

      const second = await harness.syncItems.execute(syncDto({ syncToken: first.getValue().syncToken }))
      expect(second.isFailed()).toBe(false)
      expect(second.getValue().retrievedItems.map((item) => item.id.toString())).not.toContain(peer)

      const next = await pullToExhaustion(harness, second.getValue().syncToken)
      expect(next.uuids).toContain(peer)

      const rows = await rawRows(harness, USER_A)
      expect(rows.find((row) => row.uuid === peer).deleted).toBe(0)
    } finally {
      await harness.destroy()
    }
  })

  it('delivers a row with NO recorded writer even when the token asks to skip a session', async () => {
    // A deployment that did not propagate the session wrote rows with a NULL
    // `updated_with_session`, and a later request on a topology that does
    // propagate it presents a token carrying the skip. Those NULL rows are not
    // identifiable as anyone's own writes, so they must be handed over.
    const harness = await buildHarness()
    try {
      const nullWriter = '00000000-0000-0000-0000-000000000901'
      const ownWrite = '00000000-0000-0000-0000-000000000902'
      await seedItem(harness, nullWriter, USER_A, 5_000_000, { updatedWithSession: null })
      await seedItem(harness, ownWrite, USER_A, 5_000_001, { updatedWithSession: SESSION_A })

      const rows = await rawRows(harness, USER_A)
      expect(rows.map((row) => row.updated_with_session)).toEqual([null, SESSION_A])

      const token = encodeSyncToken({
        positionMicroseconds: 4_000_000,
        ownWriteSessionUuid: SESSION_A,
        ownWriteCeilingMicroseconds: 6_000_000,
      })

      const pulled = await pullToExhaustion(harness, token)
      expect(pulled.uuids).toEqual([nullWriter])
    } finally {
      await harness.destroy()
    }
  })
})
