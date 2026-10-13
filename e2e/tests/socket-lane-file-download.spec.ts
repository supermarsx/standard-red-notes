import { test, expect } from '@playwright/test'
import {
  Account,
  freshAccount,
  openFreshContext,
  registerAccount,
  signIn,
  syncUntilQuiescent,
  waitForApplicationReady,
} from '../helpers/sync'
import { SESSION_ROUTES, expectCookieBasedSession, recordSessionMints } from '../helpers/session'
import { type UploadedFile, downloadFile, fileLaneNegotiated, uploadFile } from '../helpers/files'

/**
 * A file stored by one browser, downloaded by another OVER THE SOCKET FILE LANE,
 * compared byte for byte — in every engine this file is run in. CI runs it in
 * Firefox AND Chromium on every push.
 *
 * WHY THIS EXISTS. Downloading a file over the socket's FILES_V1 lane failed in
 * Firefox on every attempt and worked in Chromium on every attempt (fixed in
 * 76e9ad0a). The worker verifies each binary chunk's digest with SubtleCrypto
 * BEFORE it advances the transfer's offset, and it did not wait for that before
 * taking the next message, so the frame behind the last chunk was judged against
 * an offset that had not moved and the transfer was failed as truncated. Which
 * of the two won was a race, and the two engines settle it differently. Every
 * browser step in CI ran Chromium, where the losing order does not occur.
 *
 * THE PREDICATE IS THE LANE'S OWN ACCOUNT, NOT "A DOWNLOAD WORKED". The app
 * falls back to HTTP when the lane delivers nothing, so "the right bytes
 * arrived" is true of a lane that carried none of them — the shape this
 * repository has been caught by before, where a check scored a capability on
 * the absence of one error. Each download here must therefore show ALL of:
 *
 *   - the lane was asked exactly once, and answered `completed`;
 *   - the lane handed the decryptor exactly the encrypted size it was asked for;
 *   - the app reported the bytes as coming from the network, not from a cache;
 *   - no HTTP download request was made for it;
 *   - the decrypted bytes are the ones that were uploaded, by SHA-256.
 *
 * The downloader is a SECOND browser context that signs in: it shares no memory
 * with the uploader, so the bytes cannot come from the uploader's file cache,
 * and the file can only be there if the server really holds it.
 *
 * Three sizes, because the race was between a chunk and the frame behind it: one
 * socket frame (256 KiB) followed by the COMPLETE, two frames, and six.
 *
 * NO RETRIES, HERE OR IN THE CONFIG. The defect was a race; a retry is how a
 * race gets reported as flakiness and then as green.
 *
 * PROVEN ABLE TO FAIL, AND PROVEN TO NEED THIS PREDICATE. With the web bundle of
 * a13e3e9d (the commit before the fix) served in front of the same server, on
 * Linux with the browser builds CI installs, Chromium completes all three over
 * the lane and Firefox completes none:
 *
 *   16 KiB    lane FILE_TRUNCATED, 0 of 16401 bytes — and the app reports NO
 *             error, the right size and the right SHA-256, because it quietly
 *             fetched the file over HTTP instead;
 *   300 KiB   lane FILE_TRUNCATED after 262144 bytes, no fallback, app error;
 *   1.4 MB    lane FILE_CHUNK_OUT_OF_ORDER after 786432 bytes, app error.
 *
 * The first row is the reason for the list above: a test that downloaded the
 * file and compared its bytes would have passed on the broken build. Stock
 * Firefox 157 fails the same three, on Windows and on Linux.
 *
 * WHAT IT IS NOT. Playwright's Firefox on Linux is not stock Firefox on Windows.
 * It runs the same worker, socket and SubtleCrypto code and so the same race;
 * timing that only a slower machine, a real network or another OS produces is
 * outside what this can see.
 *
 * REQUIRES the docker stack up and advertising FILES_V1 (every compose and
 * single-container deployment does). A stack that does not negotiate the lane
 * FAILS this spec rather than skipping it: with no lane there is nothing to test,
 * and a skip would read as a pass.
 */

const FRAME = 256 * 1024
const FILES = [
  { label: 'one socket frame', size: 16 * 1024, seed: 0x1001 },
  { label: 'two socket frames', size: FRAME + 44 * 1024, seed: 0x2002 },
  { label: 'six socket frames', size: 1_400_000, seed: 0x3003 },
] as const

test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })

test.describe('file download over the socket file lane', () => {
  test('a second signed-in browser downloads three files over the lane, byte for byte', async ({
    page,
    browser,
    browserName,
    baseURL,
  }, testInfo) => {
    testInfo.annotations.push({
      type: 'engine',
      description: `${browserName} ${browser.version()} on ${process.platform}`,
    })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(`uploader: ${error.message}`))

    const account: Account = freshAccount()

    // 1. STORE the files from the first browser, through the app's own upload path.
    await page.goto(baseURL ?? '/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page)
    await registerAccount(page, account)
    const bootstrap = await syncUntilQuiescent(page, 'file-lane-bootstrap')
    expect(
      bootstrap.quiescent,
      `the post-registration sync must drain; residual=${JSON.stringify(bootstrap.residualDirtyItems)}`,
    ).toBe(true)

    const uploaded: UploadedFile[] = []
    for (const [position, file] of FILES.entries()) {
      uploaded.push(await uploadFile(page, `lane-${position + 1}.bin`, file.size, file.seed))
    }
    const stored = await syncUntilQuiescent(page, 'file-lane-store')
    expect(
      stored.quiescent,
      `the three file items must reach the server; residual=${JSON.stringify(stored.residualDirtyItems)}`,
    ).toBe(true)
    // The first browser is done. Closing it leaves the second as this account's
    // only session, so nothing but the server can hand it these files.
    await page.close()

    // 2. DOWNLOAD them from a second browser context that signs in.
    const reader = await openFreshContext(browser, baseURL)
    reader.page.on('pageerror', (error) => pageErrors.push(`downloader: ${error.message}`))
    const signInMints = recordSessionMints(reader.page)
    // Every HTTP download of a file's bytes is a GET on the files service's
    // `/v1/files`. The lane makes none.
    const httpDownloads: string[] = []
    reader.page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/v1/files')) {
        httpDownloads.push(request.url())
      }
    })

    try {
      await signIn(reader.page, account)
      // The lane has to authenticate the session production issues. A stack that
      // quietly issues legacy header sessions would pass below and prove nothing
      // about the cookie sessions every real sign-in gets.
      await expectCookieBasedSession({
        recorder: signInMints,
        context: reader.context,
        page: reader.page,
        route: SESSION_ROUTES.signIn,
        label: 'downloading context',
        baseURL,
      })
      const pull = await syncUntilQuiescent(reader.page, 'file-lane-pull')
      expect(
        pull.quiescent,
        `the downloading browser must finish its first sync; residual=${JSON.stringify(pull.residualDirtyItems)}`,
      ).toBe(true)

      // A lane that was never negotiated is a FAILURE here, not a skip.
      await expect
        .poll(() => fileLaneNegotiated(reader.page), {
          timeout: 45_000,
          message: 'this browser never negotiated the socket file lane (FILES_V1), so no download can use it',
        })
        .toBe(true)

      for (const [position, file] of FILES.entries()) {
        const expected = uploaded[position]
        await test.step(`${file.label}: ${file.size} bytes`, async () => {
          const before = httpDownloads.length
          const download = await downloadFile(reader.page, expected.uuid)
          const detail = JSON.stringify(download)
          console.log(
            `[file-lane] ${testInfo.project.name} ${file.label} (${file.size} bytes): ` +
              `lane ${JSON.stringify(download.lane)}, app error ${JSON.stringify(download.error)}, ` +
              `sources ${JSON.stringify(download.sources)}, http downloads ${httpDownloads.length - before}`,
          )

          // Soft assertions: the three sizes fail differently on a broken lane (the
          // smallest falls back to HTTP and still produces the right bytes, the
          // largest does not), and one run should report all of them.

          // What the lane says it did.
          expect.soft(download.lane.length, `the lane was asked exactly once; ${detail}`).toBe(1)
          const lane = download.lane[0] ?? { declaredSize: 0, deliveredBytes: 0, outcome: 'never asked', code: null }
          expect.soft(lane.outcome, `the lane's own outcome; ${detail}`).toBe('completed')
          expect
            .soft(lane.declaredSize, `the encrypted size asked for is larger than the file; ${detail}`)
            .toBeGreaterThan(file.size)
          expect
            .soft(lane.deliveredBytes, `the lane delivered every encrypted byte it was asked for; ${detail}`)
            .toBe(lane.declaredSize)

          // What the app made of it.
          expect.soft(download.error, `the app reported no download error; ${detail}`).toBeNull()
          expect
            .soft(download.sources, `every byte came from the network, none from a cache; ${detail}`)
            .toEqual(['network'])
          expect.soft(httpDownloads.slice(before), 'no HTTP download was made for this file').toEqual([])
          expect.soft(download.size, `decrypted size; ${detail}`).toBe(file.size)
          expect.soft(download.sha256, `decrypted bytes are the uploaded bytes; ${detail}`).toBe(expected.sha256)
        })
      }
    } finally {
      signInMints.dispose()
      await reader.context.close()
    }

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
  })
})
