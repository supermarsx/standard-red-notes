import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { dbQueryJson, sqlString } from '../helpers/database'
import {
  freshAccount,
  openFreshContext,
  registerAccount,
  signIn,
  syncNow,
  waitForApplicationReady,
} from '../helpers/sync'

type SessionInfo = {
  accessToken: string
  userUuid: string | null
}

type PersistedItemRow = {
  uuid: string
  user_uuid: string
  content_type: string
  content: string | null
  enc_item_key: string | null
  items_key_id: string | null
  auth_hash: string | null
  deleted: number | boolean
}

type PersistedRevisionRow = {
  uuid: string
  item_uuid: string
  content_type: string
  content: string | null
  enc_item_key: string | null
  items_key_id: string | null
  auth_hash: string | null
}

type PersistedUserRow = {
  uuid: string
  email: string
  encrypted_password: string
  encrypted_server_key: string | null
  pw_salt: string | null
}

type PersistenceHit = {
  area: string
  key: string
  snippet: string
}

const APP_URL = process.env.APP_URL?.trim() || 'http://localhost:3001'

test.describe.configure({ mode: 'serial', timeout: 3 * 60_000 })

test.describe('encryption and data-safety e2e', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'data-safety storage probes run on chromium only')

  test('real sync stores ciphertext, decrypts on another client, isolates users, and clears tombstones', async ({
    page,
    browser,
    baseURL,
  }) => {
    const appUrl = baseURL ?? APP_URL
    const account = freshAccount()
    const marker = `SRN-E2E-SECRET-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const title = `${marker}-TITLE`
    const body = `${marker}-BODY real encrypted round trip`
    const forbiddenTerms = [marker, title, body, account.password]

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page)
    await registerAccount(page, account)

    const created = await createAndSyncNote(page, title, body)
    expect(created.dirty, 'note create should drain after sync').toBe(0)

    const session = await getSessionInfo(page)

    const syncResponse = await apiSync(page.request, appUrl, session.accessToken)
    expectNoPlaintext(syncResponse, forbiddenTerms, 'owner sync API response')
    expect(
      JSON.stringify(syncResponse),
      'owner sync API response should include the encrypted item projection',
    ).toContain(created.uuid)

    const fetchedItem = await apiGetItem(page.request, appUrl, session.accessToken, created.uuid)
    expect(fetchedItem.item?.uuid, 'owner can fetch the encrypted item').toBe(created.uuid)
    expectNoPlaintext(fetchedItem, forbiddenTerms, 'owner get-item API response')
    expectEncryptedItemShape(fetchedItem.item, 'owner get-item API response')

    const itemRow = await getItemRow(created.uuid)
    expect(itemRow, 'item row should exist after sync').toBeTruthy()
    expect(itemRow?.user_uuid, 'item row should belong to the signed-in user').toBe(session.userUuid)
    expect(itemRow?.content_type).toBe('Note')
    expect(Number(itemRow?.deleted), 'created note should not be deleted').toBe(0)
    expectEncryptedItemShape(itemRow, 'items table row')
    expectNoPlaintext(itemRow, forbiddenTerms, 'items table row')

    const userRow = await getUserRow(account.email)
    expect(userRow, 'registered user row should exist').toBeTruthy()
    expect(userRow?.encrypted_password, 'password hash/encrypted verifier should be stored').toBeTruthy()
    expect(userRow?.encrypted_password, 'raw password must never be stored').not.toBe(account.password)
    expectNoPlaintext(userRow, [account.password], 'users table row')

    const revisionRows = await getRevisionRows(created.uuid)
    for (const row of revisionRows) {
      expectEncryptedItemShape(row, 'revisions table row')
      expectNoPlaintext(row, forbiddenTerms, 'revisions table row')
    }

    const persistenceHits = await findPlaintextInBrowserPersistence(page, [marker, title, body])
    expect(
      persistenceHits,
      `browser persistent storage leaked note plaintext:\n${JSON.stringify(persistenceHits, null, 2)}`,
    ).toEqual([])

    const second = await openFreshContext(browser, appUrl)
    try {
      await signIn(second.page, account)
      await syncNow(second.page, 'encryption-data-safety-pull')
      await expect
        .poll(() => readNote(second.page, created.uuid), {
          message: 'fresh client should decrypt the synced note',
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
        })
        .toEqual({ title, text: body })

      const other = await openFreshContext(browser, appUrl)
      try {
        const otherAccount = freshAccount()
        await registerAccount(other.page, otherAccount)
        const otherSession = await getSessionInfo(other.page)
        const unauthorized = await other.page.request.get(itemUrl(appUrl, created.uuid), {
          headers: authorizationHeader(otherSession.accessToken),
        })
        expect(unauthorized.status(), 'another user must not fetch this item by uuid').toBe(404)
        expectNoPlaintext(await safeJson(unauthorized), forbiddenTerms, 'unauthorized get-item response')
      } finally {
        await other.context.close()
      }

      const deleted = await deleteAndSyncNote(page, created.uuid)
      expect(deleted.dirty, 'delete should drain after sync').toBe(0)
      expect(deleted.exists, 'deleted note should leave the local collection').toBe(false)

      await syncNow(second.page, 'encryption-data-safety-delete-pull')
      expect(await readNote(second.page, created.uuid), 'fresh client should observe the delete').toBeNull()

      const tombstone = await getItemRow(created.uuid)
      expect(tombstone, 'deleted item should leave a tombstone row').toBeTruthy()
      expect(Number(tombstone?.deleted), 'tombstone should be marked deleted').toBe(1)
      expect(tombstone?.content, 'deleted tombstone should clear encrypted content').toBeNull()
      expect(tombstone?.enc_item_key, 'deleted tombstone should clear encrypted item key').toBeNull()
      expect(tombstone?.auth_hash, 'deleted tombstone should clear auth hash').toBeNull()
      expect(tombstone?.items_key_id, 'deleted tombstone should clear items key id').toBeNull()
      expectNoPlaintext(tombstone, forbiddenTerms, 'deleted tombstone row')
    } finally {
      await second.context.close()
    }
  })
})

async function createAndSyncNote(page: Page, title: string, text: string): Promise<{ uuid: string; dirty: number }> {
  return page.evaluate(async ({ title, text }) => {
    type App = {
      mutator: { createItem: (ct: string, content: unknown, needsSync?: boolean) => Promise<{ uuid: string }> }
      sync: { sync: (opts?: unknown) => Promise<unknown> }
      items: { getDirtyItems: () => unknown[] }
    }
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: App } }
    ).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const note = await app.mutator.createItem('Note', { title, text }, true)
    await app.sync.sync({ sourceDescription: 'encryption-data-safety-create' })
    return { uuid: note.uuid, dirty: app.items.getDirtyItems().length }
  }, { title, text })
}

async function deleteAndSyncNote(page: Page, uuid: string): Promise<{ dirty: number; exists: boolean }> {
  return page.evaluate(async (uuid) => {
    type Note = { uuid: string }
    type App = {
      mutator: { deleteItem: (item: Note) => Promise<void> }
      sync: { sync: (opts?: unknown) => Promise<unknown> }
      items: { findItem: (uuid: string) => Note | undefined; getDirtyItems: () => unknown[] }
    }
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: App } }
    ).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const item = app.items.findItem(uuid)
    if (!item) throw new Error(`note ${uuid} not found for delete`)
    await app.mutator.deleteItem(item)
    await app.sync.sync({ sourceDescription: 'encryption-data-safety-delete' })
    return { dirty: app.items.getDirtyItems().length, exists: Boolean(app.items.findItem(uuid)) }
  }, uuid)
}

async function readNote(page: Page, uuid: string): Promise<{ title: string; text: string } | null> {
  return page.evaluate((uuid) => {
    type Note = { uuid: string; title?: string; text?: string }
    const app = (
      window as unknown as {
        mainApplicationGroup?: { primaryApplication?: { items?: { findItem: (uuid: string) => Note | undefined } } }
      }
    ).mainApplicationGroup?.primaryApplication
    const note = app?.items?.findItem(uuid)
    return note ? { title: note.title ?? '', text: note.text ?? '' } : null
  }, uuid)
}

async function getSessionInfo(page: Page): Promise<SessionInfo> {
  return page.evaluate(() => {
    type Session = { accessToken?: string | { value?: string } }
    type User = { uuid?: string }
    type App = {
      sessions?: {
        getSession?: () => Session | null
        getUser?: () => User | null
      }
    }
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: App } }
    ).mainApplicationGroup?.primaryApplication
    const session = app?.sessions?.getSession?.()
    const token = typeof session?.accessToken === 'string' ? session.accessToken : session?.accessToken?.value
    if (!token) throw new Error('session access token not available')
    return { accessToken: token, userUuid: app?.sessions?.getUser?.()?.uuid ?? null }
  })
}

async function apiSync(request: APIRequestContext, appUrl: string, accessToken: string): Promise<unknown> {
  const response = await request.post(new URL('/v1/items', appUrl).toString(), {
    headers: authorizationHeader(accessToken),
    data: {
      api: '20200115',
      items: [],
      sync_token: null,
      cursor_token: null,
      limit: 100,
      content_type: 'Note',
    },
  })
  expect(response.ok(), `sync API should succeed: ${response.status()} ${await response.text()}`).toBe(true)
  return response.json()
}

async function apiGetItem(
  request: APIRequestContext,
  appUrl: string,
  accessToken: string,
  uuid: string,
): Promise<{ item?: PersistedItemRow & { [key: string]: unknown } }> {
  const response = await request.get(itemUrl(appUrl, uuid), {
    headers: authorizationHeader(accessToken),
  })
  expect(response.ok(), `get-item API should succeed: ${response.status()} ${await response.text()}`).toBe(true)
  const json = (await response.json()) as {
    item?: PersistedItemRow & { [key: string]: unknown }
    data?: { item?: PersistedItemRow & { [key: string]: unknown } }
  }
  return { item: json.item ?? json.data?.item }
}

function itemUrl(appUrl: string, uuid: string): string {
  return new URL(`/v1/items/${uuid}`, appUrl).toString()
}

function authorizationHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` }
}

async function safeJson(response: { json: () => Promise<unknown>; text: () => Promise<string> }): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return response.text()
  }
}

async function getItemRow(uuid: string): Promise<PersistedItemRow | null> {
  const rows = dbQueryJson<PersistedItemRow>(`
SELECT JSON_OBJECT(
  'uuid', uuid,
  'user_uuid', user_uuid,
  'content_type', content_type,
  'content', content,
  'enc_item_key', enc_item_key,
  'items_key_id', items_key_id,
  'auth_hash', auth_hash,
  'deleted', deleted
)
FROM items
WHERE uuid = ${sqlString(uuid)}
LIMIT 1;
`)
  return rows[0] ?? null
}

async function getRevisionRows(uuid: string): Promise<PersistedRevisionRow[]> {
  return dbQueryJson<PersistedRevisionRow>(`
SELECT JSON_OBJECT(
  'uuid', uuid,
  'item_uuid', item_uuid,
  'content_type', content_type,
  'content', content,
  'enc_item_key', enc_item_key,
  'items_key_id', items_key_id,
  'auth_hash', auth_hash
)
FROM revisions_revisions
WHERE item_uuid = ${sqlString(uuid)}
ORDER BY created_at DESC
LIMIT 10;
`)
}

async function getUserRow(email: string): Promise<PersistedUserRow | null> {
  const rows = dbQueryJson<PersistedUserRow>(`
SELECT JSON_OBJECT(
  'uuid', uuid,
  'email', email,
  'encrypted_password', encrypted_password,
  'encrypted_server_key', encrypted_server_key,
  'pw_salt', pw_salt
)
FROM users
WHERE email = ${sqlString(email)}
LIMIT 1;
`)
  return rows[0] ?? null
}

function expectEncryptedItemShape(value: unknown, label: string): void {
  const item = value as {
    content?: unknown
    enc_item_key?: unknown
    auth_hash?: unknown
    items_key_id?: unknown
    deleted?: unknown
  }
  if (Number(item.deleted) === 1) {
    return
  }
  expect(typeof item.content, `${label}: content should be an encrypted string`).toBe('string')
  expect((item.content as string).length, `${label}: encrypted content should be non-empty`).toBeGreaterThan(0)
  expect(item.content, `${label}: content should be serialized ciphertext, not note JSON`).not.toContain('"title"')
  expect(item.content, `${label}: content should be serialized ciphertext, not note JSON`).not.toContain('"text"')
  expect(item.enc_item_key ?? item.items_key_id ?? item.auth_hash, `${label}: encrypted item metadata should exist`).toBeTruthy()
}

function expectNoPlaintext(value: unknown, terms: string[], label: string): void {
  const text = stringify(value)
  for (const term of terms.filter(Boolean)) {
    expect(text, `${label} leaked plaintext term: ${term}`).not.toContain(term)
  }
}

async function findPlaintextInBrowserPersistence(page: Page, terms: string[]): Promise<PersistenceHit[]> {
  return page.evaluate(async (terms) => {
    type Hit = { area: string; key: string; snippet: string }
    const hits: Hit[] = []

    const stringify = (value: unknown): string => {
      try {
        if (typeof value === 'string') return value
        return JSON.stringify(value) ?? ''
      } catch {
        return String(value)
      }
    }

    const matchingSnippet = (value: unknown): string | null => {
      const text = stringify(value)
      const term = terms.find((candidate) => candidate && text.includes(candidate))
      if (!term) return null
      const index = text.indexOf(term)
      return text.slice(Math.max(0, index - 60), index + term.length + 60)
    }

    const scanValue = (area: string, key: string, value: unknown) => {
      const snippet = matchingSnippet(value)
      if (snippet) {
        hits.push({ area, key, snippet })
      }
    }

    for (const storage of [
      { area: 'localStorage', store: window.localStorage },
      { area: 'sessionStorage', store: window.sessionStorage },
    ]) {
      for (let i = 0; i < storage.store.length; i += 1) {
        const key = storage.store.key(i)
        if (key) scanValue(storage.area, key, storage.store.getItem(key))
      }
    }

    if (!('databases' in indexedDB)) {
      hits.push({ area: 'indexedDB', key: 'databases', snippet: 'indexedDB.databases() is unavailable' })
      return hits
    }

    const databases = await indexedDB.databases()
    for (const database of databases) {
      if (!database.name) continue
      await new Promise<void>((resolve) => {
        const open = indexedDB.open(database.name as string)
        open.onerror = () => {
          hits.push({ area: 'indexedDB', key: database.name as string, snippet: 'failed to open database' })
          resolve()
        }
        open.onsuccess = () => {
          const db = open.result
          const storeNames = Array.from(db.objectStoreNames)
          if (!storeNames.length) {
            db.close()
            resolve()
            return
          }

          const tx = db.transaction(storeNames, 'readonly')
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => {
            hits.push({ area: 'indexedDB', key: database.name as string, snippet: 'failed to scan database' })
            db.close()
            resolve()
          }

          for (const storeName of storeNames) {
            try {
              const cursor = tx.objectStore(storeName).openCursor()
              cursor.onsuccess = () => {
                const current = cursor.result
                if (!current) return
                scanValue(`indexedDB:${database.name}`, `${storeName}:key`, current.key)
                scanValue(`indexedDB:${database.name}`, `${storeName}:value`, current.value)
                current.continue()
              }
              cursor.onerror = () => {
                hits.push({
                  area: `indexedDB:${database.name}`,
                  key: storeName,
                  snippet: 'failed to open cursor',
                })
              }
            } catch (error) {
              hits.push({
                area: `indexedDB:${database.name}`,
                key: storeName,
                snippet: `failed to scan store: ${(error as Error).message}`,
              })
            }
          }
        }
      })
    }

    return hits
  }, terms)
}

function stringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
