import { test, expect } from '@playwright/test'
import {
  Account,
  dirtyCount,
  freshAccount,
  noteTextsByTitle,
  openFreshContext,
  registerAccount,
  signIn,
  syncUntilQuiescent,
  waitForApplicationReady,
} from '../helpers/sync'

/**
 * The AUTHENTICATED browser session under `SERVICE_PROXY_TYPE=grpc`.
 *
 * WHY THIS EXISTS. `grpc` moves exactly two things off HTTP, not "every internal
 * call" as docker-compose.yml claims: `GRPCServiceProxy.validateSession`, which
 * runs on EVERY authenticated request, and `callSyncingServer` for `items/sync`
 * at api 20200115. A gRPC auth fault therefore does not degrade sync, it fails
 * authentication outright: validateSession retries three times on UNAVAILABLE
 * and then throws, with NO HTTP fallback (GRPCServiceProxy.ts:134-163). Setting
 * the switch also binds the durable command port, which makes the gateway
 * advertise the realtime SYNC_ITEMS lane, so the client may choose a different
 * transport for saves than it does under the default HTTP proxies.
 *
 * Every other browser spec runs under those default proxies, so none of that
 * was ever exercised by a real sign-in. This spec is the one that is: it drives
 * the REAL client (the built bundle, the in-page snjs application, real crypto,
 * real requests through the app's nginx) through register -> save -> sign in
 * again in a SECOND browser context -> read the note back. A fresh account means
 * a fresh session token, so the very first authenticated request cannot be
 * answered from the gateway's cross-service token cache: it must go through
 * validateSession. A second context proves the note reached the SERVER, not just
 * local IndexedDB.
 *
 * It is deliberately transport-agnostic and passes under either proxy setting.
 * Asserting the configuration is CI's job (the step that greps the container's
 * api-gateway .env), so this file stays runnable against any stack.
 *
 * REQUIRES the docker stack up (app front door proxying /v1). Chromium only:
 * this is a server round trip, not a cross-engine bootstrap smoke.
 */

// A register + two full drains + a second-context sign-in and pull legitimately
// exceeds the 60s smoke cap, and a hang must fail rather than wedge the runner.
test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 })

test.describe('authenticated browser session over the configured service proxies', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'server round-trip spec runs on chromium only')

  test('registers, saves an acknowledged note, and reads it back after a fresh sign-in', async ({
    page,
    browser,
    baseURL,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    const account: Account = freshAccount()
    const unique = `grpc-auth-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const noteText = `body ${unique}`

    // 1. REGISTER through the real client. This is account creation + the first
    //    authenticated round trip, i.e. the first validateSession of this token.
    await page.goto(baseURL ?? '/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page)
    await registerAccount(page, account)

    // 2. The account bootstrap (items key, preferences, the default note) must
    //    reach the server before anything else is claimed about saves.
    const bootstrap = await syncUntilQuiescent(page, 'grpc-auth-bootstrap')
    expect(
      bootstrap.quiescent,
      `the post-registration sync must drain; residual=${JSON.stringify(bootstrap.residualDirtyItems)}`,
    ).toBe(true)

    // 3. SAVE a note and require the ACKNOWLEDGEMENT. A drained dirty set is the
    //    client's record that the server accepted the upload; a transport that
    //    resolves its sync without uploading leaves the note dirty and fails here.
    const created = await page.evaluate(
      async ({ title, text }) => {
        const app = (
          window as unknown as {
            mainApplicationGroup?: {
              primaryApplication?: {
                mutator: {
                  createItem: (ct: string, content: unknown, needsSync?: boolean) => Promise<{ uuid: string }>
                }
              }
            }
          }
        ).mainApplicationGroup?.primaryApplication
        if (!app) throw new Error('app not available')
        const item = await app.mutator.createItem('Note', { title, text }, true)
        return item.uuid
      },
      { title: unique, text: noteText },
    )
    expect(created, 'the note should be created in the page').toBeTruthy()

    const save = await syncUntilQuiescent(page, 'grpc-auth-save')
    expect(
      save.quiescent,
      `the save must be acknowledged by the server; residual=${JSON.stringify(save.residualDirtyItems)}`,
    ).toBe(true)
    expect(await dirtyCount(page), 'nothing may stay unsynced after an acknowledged save').toBe(0)

    // 4. READ it back from a SECOND browser context that SIGNS IN. A separate
    //    context shares no IndexedDB, no session and no in-memory items, so the
    //    note can only appear if the server really holds it — and the sign-in
    //    itself mints a second fresh token that must survive validateSession.
    const reader = await openFreshContext(browser, baseURL)
    try {
      await signIn(reader.page, account)
      const pull = await syncUntilQuiescent(reader.page, 'grpc-auth-pull')
      expect(
        pull.quiescent,
        `the second client must reach a quiescent dirty set; residual=${JSON.stringify(pull.residualDirtyItems)}`,
      ).toBe(true)

      const texts = await noteTextsByTitle(reader.page, unique)
      expect(texts, 'the signed-in second client must pull back exactly the saved note').toEqual([noteText])
    } finally {
      await reader.context.close()
    }

    expect(pageErrors, 'the authenticated flow must not raise a page error').toEqual([])
  })
})
