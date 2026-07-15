import { test, expect } from '@playwright/test'
import { dbQueryJson, sqlString } from '../helpers/database'
import { redisParallelLoad } from '../helpers/redis'
import {
  freshAccount,
  openFreshContext,
  registerAccount,
  seedAndPush,
  signIn,
  syncNow,
  verifyNoteIntegrity,
  waitForApplicationReady,
} from '../helpers/sync'

const LOAD_NOTES = positiveInt(process.env.OPS_LOAD_NOTES, 120)
const PARALLEL_CLIENTS = positiveInt(process.env.OPS_LOAD_CLIENTS, 3)
const REDIS_WORKERS = positiveInt(process.env.OPS_REDIS_WORKERS, 4)
const REDIS_OPS_PER_WORKER = positiveInt(process.env.OPS_REDIS_OPS_PER_WORKER, 250)

test.describe.configure({ mode: 'serial', timeout: 6 * 60_000 })

test.describe('ops load and Redis throughput', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'ops load drill runs on chromium only')

  test(`parallel sync holds under Redis churn @ notes=${LOAD_NOTES}, clients=${PARALLEL_CLIENTS}`, async ({
    page,
    browser,
    baseURL,
  }) => {
    const appUrl = baseURL ?? 'http://localhost:3001'
    const account = freshAccount()
    const redisPrefix = `srn:ops-load:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`

    const redisLoad = redisParallelLoad({
      prefix: redisPrefix,
      workers: REDIS_WORKERS,
      opsPerWorker: REDIS_OPS_PER_WORKER,
    })
    let redis: Awaited<ReturnType<typeof redisParallelLoad>> | null = null
    let pushMs = 0

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForApplicationReady(page)
      await registerAccount(page, account)

      const push = await seedAndPush(page, LOAD_NOTES, 512, Math.min(50, LOAD_NOTES))
      expect(push.created, 'all requested notes created before push').toBe(LOAD_NOTES)
      expect(push.dirtyAfterPush, 'server push should drain dirty items').toBe(0)
      pushMs = Math.round(push.pushMs)

      const clients = await Promise.all(
        Array.from({ length: PARALLEL_CLIENTS }, () => openFreshContext(browser, appUrl)),
      )
      try {
        await Promise.all(clients.map((client) => signIn(client.page, account)))
        const pulls = await Promise.all(
          clients.map((client, index) => syncNow(client.page, `ops-load-parallel-pull-${index + 1}`)),
        )
        const integrities = await Promise.all(clients.map((client) => verifyNoteIntegrity(client.page, LOAD_NOTES, 17)))

        for (const [index, pull] of pulls.entries()) {
          expect(pull.dirty, `client ${index + 1} should stay drained after pull`).toBe(0)
          expect(pull.noteCount, `client ${index + 1} should pull the full corpus`).toBeGreaterThanOrEqual(LOAD_NOTES)
        }

        for (const [index, integrity] of integrities.entries()) {
          expect(integrity.missing, `client ${index + 1} missing synced notes`).toEqual([])
          expect(integrity.corrupt, `client ${index + 1} corrupted sampled notes`).toEqual([])
          expect(integrity.duplicated, `client ${index + 1} duplicated notes`).toEqual([])
        }
      } finally {
        await Promise.all(clients.map((client) => client.context.close()))
      }
    } finally {
      redis = await redisLoad
    }
    if (!redis) {
      throw new Error('Redis load did not complete')
    }

    expect(redis.counterValue, 'all Redis worker INCR operations should complete').toBe(
      REDIS_WORKERS * REDIS_OPS_PER_WORKER,
    )
    expect(redis.commandsPerSecond, 'Redis command throughput should be non-trivial').toBeGreaterThanOrEqual(25)
    expect(redis.usedMemoryBytes, 'Redis should report memory usage').toBeGreaterThan(0)

    const persisted = persistedItemCount(account.email)
    expect(persisted.users, 'load account should exist in MariaDB').toBe(1)
    expect(persisted.items, 'MariaDB should hold all pushed notes for the load account').toBeGreaterThanOrEqual(LOAD_NOTES)

    // eslint-disable-next-line no-console
    console.log(
      'OPS LOAD REPORT:',
      JSON.stringify(
        {
          notes: LOAD_NOTES,
          clients: PARALLEL_CLIENTS,
          pushMs,
          redis,
          persisted,
        },
        null,
        2,
      ),
    )
  })
})

function persistedItemCount(email: string): { users: number; items: number } {
  const rows = dbQueryJson<{ users: number; items: number }>(`
SELECT JSON_OBJECT(
  'users', (SELECT COUNT(*) FROM users WHERE email = ${sqlString(email)}),
  'items', (
    SELECT COUNT(*)
    FROM items
    WHERE user_uuid = (SELECT uuid FROM users WHERE email = ${sqlString(email)} LIMIT 1)
      AND content_type = 'Note'
      AND deleted = 0
  )
);
`)
  return rows[0] ?? { users: 0, items: 0 }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
