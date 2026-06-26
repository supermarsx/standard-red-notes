import { type Page, type BrowserContext, type Browser, expect } from '@playwright/test'

/**
 * Helpers for the REAL client<->server SYNC stress/reliability harness.
 *
 * Unlike `stress.ts` (which seeds notes with NO account, so `sync.sync()` is just
 * local IndexedDB persistence), these helpers drive the in-page snjs application
 * to register / sign in against the LOCAL docker server and exercise the actual
 * push/pull sync over `/v1/items` (proxied by nginx, see app/docker/nginx.conf).
 *
 * IN-PAGE APP SURFACE (verified against app source):
 *   - window.mainApplicationGroup.primaryApplication is the snjs Application.
 *   - app.register(email, password, hvmToken, ...)        Application.ts:775
 *       -> UserService.register (services/.../UserService.ts:146). hvmToken is the
 *          optional human-verification (captcha) token; the local server does not
 *          enforce it, so '' is accepted (matches the web UI CreateAccount.tsx,
 *          which passes an empty hvmToken until a captcha is configured).
 *   - app.signIn(email, password, strict, ephemeral, mergeLocal, awaitSync, ...)
 *                                                          Application.ts:793
 *   - app.sync.sync(options)        SyncService.sync       SyncService.ts:987
 *   - app.items.getItems('Note')    items in memory
 *   - app.items.getDirtyItems()     pending (unsynced) set ItemManager
 *   - app.mutator.createItem / changeItem
 *
 * REGISTRATION is ENABLED on this server: docker-compose.yml does NOT set
 * DISABLE_USER_REGISTRATION, and the auth Register use case only refuses when that
 * env is 'true' (server/.../Register.ts:44). A probe POST /v1/users returns a
 * field-validation error ("enter an email and a password"), NOT "registration is
 * currently not allowed", confirming it accepts sign-ups.
 */

/** Minimal shape of the in-page snjs application surface we drive. */
type InPageApp = {
  isLaunched?: () => boolean
  register: (email: string, password: string, hvmToken: string) => Promise<unknown>
  signIn: (
    email: string,
    password: string,
    strict?: boolean,
    ephemeral?: boolean,
    mergeLocal?: boolean,
    awaitSync?: boolean,
  ) => Promise<unknown>
  sync: { sync: (opts?: unknown) => Promise<unknown> }
  items: {
    getItems: (ct: string) => Array<{ uuid: string; title?: string; text?: string }>
    getDirtyItems: () => unknown[]
    findItem: (uuid: string) => { uuid: string; title?: string; text?: string } | undefined
  }
  mutator: {
    createItem: (ct: string, content: unknown, needsSync?: boolean) => Promise<{ uuid: string; payload: unknown }>
    changeItem: (item: unknown, mutate: (m: { mutableContent: { title?: string; text?: string } }) => void) => Promise<unknown>
  }
  user: { isSignedIn: () => boolean }
}

function getApp(w: Window): InPageApp {
  const app = (
    w as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
  ).mainApplicationGroup?.primaryApplication
  if (!app) {
    throw new Error('window.mainApplicationGroup.primaryApplication not available')
  }
  return app
}

export type Account = { email: string; password: string }

/** A fresh, collision-resistant local account. */
export function freshAccount(): Account {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return { email: `stress-${id}@local.test`, password: `Pw-${id}-Aa1!` }
}

/** Wait until the snjs primary application has launched and is reachable. */
export async function waitForApplicationReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = (
        window as unknown as { mainApplicationGroup?: { primaryApplication?: { isLaunched?: () => boolean } } }
      ).mainApplicationGroup?.primaryApplication
      return Boolean(app && typeof app.isLaunched === 'function' && app.isLaunched())
    },
    undefined,
    { timeout: timeoutMs },
  )
}

/**
 * Register a fresh account against the local server and (implicitly) sign in.
 * register() drives a full account-creation + initial sync, so on return the
 * client holds a real session.
 */
export async function registerAccount(page: Page, account: Account): Promise<void> {
  await page.evaluate(async ({ email, password }) => {
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
    ).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const res = (await app.register(email, password, '')) as { error?: { message?: string } } | undefined
    if (res && res.error) {
      throw new Error(`register failed: ${res.error.message ?? JSON.stringify(res.error)}`)
    }
    if (!app.user.isSignedIn()) {
      throw new Error('register returned but user is not signed in')
    }
  }, account)
}

/** Sign in to an existing account on the local server (awaiting the initial sync). */
export async function signIn(page: Page, account: Account): Promise<void> {
  await page.evaluate(async ({ email, password }) => {
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
    ).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    // strict=false, ephemeral=false, mergeLocal=true, awaitSync=true
    const res = (await app.signIn(email, password, false, false, true, true)) as
      | { error?: { message?: string } }
      | undefined
    if (res && res.error) {
      throw new Error(`signIn failed: ${res.error.message ?? JSON.stringify(res.error)}`)
    }
    if (!app.user.isSignedIn()) {
      throw new Error('signIn returned but user is not signed in')
    }
  }, account)
}

export type SyncSeedResult = {
  requested: number
  created: number
  seedMs: number
  pushMs: number
  dirtyAfterPush: number
  noteCount: number
  batches: number
}

/**
 * Seed `count` notes (all dirty), then PUSH them to the server with a single
 * `sync.sync()`. Notes are built in-page in batches to bound memory. Returns the
 * push wall-clock and the residual dirty count (which MUST be 0 if the server
 * accepted every item).
 */
export async function seedAndPush(
  page: Page,
  count: number,
  sizeBytes = 256,
  batchSize = 1000,
): Promise<SyncSeedResult> {
  return page.evaluate(
    async ({ count, sizeBytes, batchSize }) => {
      const app = (
        window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
      ).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('app not available')

      const filler = 'Lorem ipsum dolor sit amet. '
      const reps = Math.max(1, Math.ceil(sizeBytes / filler.length))
      const body = filler.repeat(reps).slice(0, Math.max(0, sizeBytes))

      const seedStart = performance.now()
      let created = 0
      let batches = 0
      for (let start = 0; start < count; start += batchSize) {
        const end = Math.min(start + batchSize, count)
        for (let i = start; i < end; i += 1) {
          // Deterministic title+text so PULL integrity can be byte-checked.
          await app.mutator.createItem('Note', { title: `note-${i}`, text: `body-${i} ${body}` }, true)
          created += 1
        }
        batches += 1
      }
      const seedMs = performance.now() - seedStart

      const pushStart = performance.now()
      await app.sync.sync({ sourceDescription: 'stress-sync-push' })
      const pushMs = performance.now() - pushStart

      return {
        requested: count,
        created,
        seedMs,
        pushMs,
        dirtyAfterPush: app.items.getDirtyItems().length,
        noteCount: app.items.getItems('Note').length,
        batches,
      }
    },
    { count, sizeBytes, batchSize },
  )
}

/** Force a network sync and return its wall-clock + resulting in-memory note count + dirty residue. */
export async function syncNow(page: Page, sourceDescription = 'stress-sync'): Promise<{
  syncMs: number
  noteCount: number
  dirty: number
}> {
  return page.evaluate(async (src) => {
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
    ).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const start = performance.now()
    await app.sync.sync({ sourceDescription: src })
    return {
      syncMs: performance.now() - start,
      noteCount: app.items.getItems('Note').length,
      dirty: app.items.getDirtyItems().length,
    }
  }, sourceDescription)
}

/** In-memory note count. */
export async function noteCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
    ).mainApplicationGroup?.primaryApplication
    return app ? app.items.getItems('Note').length : -1
  })
}

/** Pending (dirty / unsynced) item count. */
export async function dirtyCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
    ).mainApplicationGroup?.primaryApplication
    return app ? app.items.getDirtyItems().length : -1
  })
}

/**
 * Verify integrity of the pulled corpus: every expected note-`i` title is present
 * exactly once and its body starts with the expected `body-i` marker. Returns a
 * small report; `missing`/`corrupt`/`duplicated` MUST all be empty for a clean
 * round-trip. Bodies are sample-checked at `sampleEvery` to keep the page work bounded.
 */
export async function verifyNoteIntegrity(
  page: Page,
  expectedCount: number,
  sampleEvery = 37,
): Promise<{ found: number; missing: number[]; corrupt: number[]; duplicated: number[] }> {
  return page.evaluate(
    ({ expectedCount, sampleEvery }) => {
      const app = (
        window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
      ).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('app not available')
      const notes = app.items.getItems('Note')

      const byTitle = new Map<string, number>()
      for (const n of notes) {
        const t = n.title ?? ''
        byTitle.set(t, (byTitle.get(t) ?? 0) + 1)
      }

      const titleToNote = new Map<string, { title?: string; text?: string }>()
      for (const n of notes) titleToNote.set(n.title ?? '', n)

      const missing: number[] = []
      const corrupt: number[] = []
      const duplicated: number[] = []
      for (let i = 0; i < expectedCount; i += 1) {
        const title = `note-${i}`
        const occurrences = byTitle.get(title) ?? 0
        if (occurrences === 0) {
          missing.push(i)
          continue
        }
        if (occurrences > 1) duplicated.push(i)
        if (i % sampleEvery === 0) {
          const note = titleToNote.get(title)
          if (!note || !(note.text ?? '').startsWith(`body-${i} `)) {
            corrupt.push(i)
          }
        }
      }
      return { found: notes.length, missing, corrupt, duplicated }
    },
    { expectedCount, sampleEvery },
  )
}

/**
 * Create a single titled note, push it, and return its uuid. Used to set up the
 * shared note for the conflict test.
 */
export async function createAndPushNote(page: Page, title: string, text: string): Promise<string> {
  return page.evaluate(
    async ({ title, text }) => {
      const app = (
        window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
      ).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('app not available')
      const created = await app.mutator.createItem('Note', { title, text }, true)
      await app.sync.sync({ sourceDescription: 'stress-sync-conflict-setup' })
      return created.uuid
    },
    { title, text },
  )
}

/** Edit a note's text by uuid (marks dirty) WITHOUT syncing yet. */
export async function editNoteText(page: Page, uuid: string, newText: string): Promise<void> {
  await page.evaluate(
    async ({ uuid, newText }) => {
      const app = (
        window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
      ).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('app not available')
      const item = app.items.findItem(uuid)
      if (!item) throw new Error(`note ${uuid} not found for edit`)
      await app.mutator.changeItem(item, (mutator) => {
        mutator.mutableContent.text = newText
      })
    },
    { uuid, newText },
  )
}

/** All note texts that share the given title (a conflict creates a duplicate same-title note). */
export async function noteTextsByTitle(page: Page, title: string): Promise<string[]> {
  return page.evaluate((title) => {
    const app = (
      window as unknown as { mainApplicationGroup?: { primaryApplication?: InPageApp } }
    ).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    return app.items
      .getItems('Note')
      .filter((n) => (n.title ?? '') === title)
      .map((n) => n.text ?? '')
  }, title)
}

/** Open a fresh, isolated browser context+page on the app, launched and ready. */
export async function openFreshContext(browser: Browser, baseURL: string | undefined): Promise<{
  context: BrowserContext
  page: Page
}> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(baseURL ?? 'http://localhost:3001', { waitUntil: 'domcontentloaded' })
  await waitForApplicationReady(page)
  return { context, page }
}

/** Convenience assertion: the dirty set fully drained (nothing left unsynced). */
export async function expectDrained(page: Page): Promise<void> {
  const dirty = await dirtyCount(page)
  expect(dirty, 'dirty items should drain to 0 after a successful push').toBe(0)
}
