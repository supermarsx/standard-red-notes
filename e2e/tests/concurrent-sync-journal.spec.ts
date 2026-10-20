import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { resolve } from 'node:path'

// Exercise the production journal against each browser's real IndexedDB transaction
// scheduler. An in-memory mock cannot prove atomic ownership under contention.
const source = readFileSync(
  resolve(__dirname, '../../app/packages/web/src/javascripts/Services/SyncTransport/SyncTransportOutbox.ts'),
  'utf8',
)
// Constructor parameter properties need compilation, not Node's strip-only API.
const compiled = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText

test.beforeEach(async ({ page }) => {
  await page.route('http://journal.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
  )
  await page.goto('http://journal.test/')
  await page.addScriptTag({
    type: 'module',
    content: `${compiled}; window.journal = { IndexedDbSyncOutbox, ConcurrentIndexedDbSyncOutbox };`,
  })
})

test('independent sockets isolate live commands without hiding abandoned saves', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { ConcurrentIndexedDbSyncOutbox: Store, IndexedDbSyncOutbox: Legacy } = (window as any).journal
    let now = 100
    const a = new Store('a', () => now),
      b = new Store('b', () => now),
      c = new Store('c', () => now)
    const legacy = new Legacy()
    const record = {
      sessionScope: 'session',
      transportScope: 'endpoint-device',
      commandId: 'save-a',
      digest: 'digest',
      bytes: 'exact encrypted bytes',
      createdAt: now,
      sequence: 7,
      operationId: 'action-a',
      dispatchedAt: now,
      socketOnly: true,
    }
    const owners = await Promise.all([
      a.acquireOwner('endpoint-device', 'session', 'a', now, 15000),
      b.acquireOwner('endpoint-device', 'session', 'b', now, 15000),
    ])
    await a.put(record)
    const sibling = await b.oldest('session')
    const oldBuild = await legacy.oldest('session')
    await b.put({ ...record, commandId: 'save-b', operationId: 'action-b' })
    const own = [await a.oldest('session'), await b.oldest('session')].map((r) => r?.commandId)
    await b.delete('session', 'save-b')
    now += 15001
    const racers = await Promise.all([b.oldest('session'), c.oldest('session')])
    const winner = racers[0] ? b : c
    const adopted = racers.find(Boolean)
    const staleWrite = await a.put(record).then(
      () => false,
      () => true,
    )
    const staleDelete = await a.delete('session', 'save-a').then(
      () => false,
      () => true,
    )
    await winner.delete('session', 'save-a')
    const originalCanReconnect = await a.acquireOwner('endpoint-device', 'session', 'a', now, 15000)
    const empty = await winner.oldest('session')
    return {
      owners,
      sibling: !!sibling,
      oldBuild: !!oldBuild,
      own,
      winners: racers.filter(Boolean).length,
      adopted,
      staleWrite,
      staleDelete,
      originalCanReconnect,
      empty: !empty,
    }
  })
  expect(result).toMatchObject({
    owners: [true, true],
    sibling: false,
    oldBuild: false,
    own: ['save-a', 'save-b'],
    winners: 1,
    staleWrite: true,
    staleDelete: true,
    originalCanReconnect: true,
    empty: true,
  })
  expect(result.adopted).toMatchObject({
    sessionScope: 'session',
    commandId: 'save-a',
    digest: 'digest',
    bytes: 'exact encrypted bytes',
    operationId: 'action-a',
    sequence: 7,
    dispatchedAt: 100,
    socketOnly: true,
  })
})

test('an older build can stay connected while new workers save; its orphan is recovered in place', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { ConcurrentIndexedDbSyncOutbox: Store, IndexedDbSyncOutbox: Legacy } = (window as any).journal
    let now = 100
    const legacy = new Legacy(),
      a = new Store('a', () => now),
      b = new Store('b', () => now)
    const record = {
      sessionScope: 'session',
      transportScope: 'endpoint-device',
      commandId: 'legacy-save',
      digest: 'digest',
      bytes: 'legacy exact bytes',
      createdAt: now,
      sequence: 19,
      dispatchedAt: now,
    }
    await legacy.acquireOwner('endpoint-device', 'session', 'old-build', now, 15000)
    await legacy.put(record)
    const newOwner = await a.acquireOwner('endpoint-device', 'session', 'a', now, 15000)
    const blocked = await a.sessionHeldByAnotherOwner('session', 'a', now)
    const live = await a.oldest('session')
    await a.put({ ...record, commandId: 'new-save' })
    const legacySees = (await legacy.oldest('session'))?.commandId
    await a.delete('session', 'new-save')
    await legacy.releaseOwner('endpoint-device', 'session', 'old-build')
    const adopted = await a.oldest('session')
    const excluded = await b.oldest('session')
    now += 10000
    await a.renewOwner('endpoint-device', 'session', 'a', now, 15000)
    now += 10000
    const held = await legacy.heldByAnotherOwner('endpoint-device', 'session', 'old-build', now)
    await a.delete('session', 'legacy-save')
    return {
      newOwner,
      blocked,
      live: !!live,
      legacySees,
      adopted,
      excluded: !!excluded,
      held,
      empty: !(await legacy.oldest('session')),
    }
  })
  expect(result).toMatchObject({
    newOwner: true,
    blocked: false,
    live: false,
    legacySees: 'legacy-save',
    excluded: false,
    held: true,
    empty: true,
  })
  expect(result.adopted).toMatchObject({
    transportScope: 'endpoint-device',
    sessionScope: 'session',
    commandId: 'legacy-save',
    sequence: 19,
    bytes: 'legacy exact bytes',
    dispatchedAt: 100,
  })
})

test('a recovering worker detects losing an adopted command even when its own socket lease is healthy', async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const Store = (window as any).journal.ConcurrentIndexedDbSyncOutbox
    let now = 100
    const a = new Store('a', () => now),
      b = new Store('b', () => now),
      c = new Store('c', () => now)
    await a.put({
      sessionScope: 'session',
      transportScope: 'endpoint-device',
      commandId: 'pending',
      digest: 'digest',
      bytes: 'bytes',
      createdAt: now,
      sequence: 1,
    })
    await a.releaseOwner('endpoint-device', 'session', 'a')
    await b.oldest('session')
    now += 15001
    await c.oldest('session')
    await b.acquireOwner('endpoint-device', 'session', 'b', now, 15000)
    return b.renewOwner('endpoint-device', 'session', 'b', now, 15000)
  })
  expect(outcome).toBe('taken')
})

test('explicit close hands off immediately; revocation and account boundaries cover both journal generations', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { ConcurrentIndexedDbSyncOutbox: Store, IndexedDbSyncOutbox: Legacy } = (window as any).journal
    const a = new Store('a', () => 100),
      b = new Store('b', () => 100),
      legacy = new Legacy()
    const record = {
      sessionScope: 'session',
      transportScope: 'endpoint-device',
      commandId: 'pending',
      digest: 'digest',
      bytes: 'bytes',
      createdAt: 100,
      sequence: 1,
    }
    await a.acquireOwner('endpoint-device', 'session', 'a', 100, 15000)
    await a.put(record)
    const isolated = await b.oldest('other-account')
    await a.releaseOwner('endpoint-device', 'session', 'a')
    const adopted = await b.oldest('session')
    const replaceDenied = await b.put({ ...adopted, bytes: 'different bytes' }).then(
      () => false,
      () => true,
    )
    await legacy.put({ ...record, commandId: 'legacy' })
    await b.quarantineSessionScope('session')
    const resurrectDenied = await b.put(adopted).then(
      () => false,
      () => true,
    )
    return {
      isolated: !isolated,
      adopted: adopted?.commandId,
      replaceDenied,
      resurrectDenied,
      currentEmpty: !(await b.oldest('session')),
      legacyEmpty: !(await legacy.oldest('session')),
    }
  })
  expect(result).toEqual({
    isolated: true,
    adopted: 'pending',
    replaceDenied: true,
    resurrectDenied: true,
    currentEmpty: true,
    legacyEmpty: true,
  })
})
