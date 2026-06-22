/**
 * Browser smoke e2e: drives the REAL built web app at :3002 in headless Chromium
 * (Playwright). Closes the "needs a human" gap — proves the bundle actually boots
 * and the core note-taking + Super editor work in a real browser. Stack-gated:
 * skips if the app isn't served.
 *
 * Usage: node e2e/browser.e2e.mjs   (requires `docker compose up app` + chromium
 * installed via `npx playwright install chromium`).
 */
import { chromium } from 'playwright'

const APP = process.env.APP_URL ?? 'http://localhost:3002'

let failures = 0
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${name}`)
  if (!cond) failures++
}

async function main() {
  const reachable = await fetch(`${APP}/`).then((r) => r.status === 200).catch(() => false)
  if (!reachable) {
    console.log('SKIP: app not reachable on', APP)
    process.exit(0)
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto(`${APP}/`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(2500)

  // 1. The rebranded app booted.
  const title = await page.title()
  check('app boots with the rebranded title', /Standard Red Notes/.test(title))
  check('notes view rendered (note title editor present)', (await page.locator('#note-title-editor').count()) > 0)

  // 2. Create a note and type into it.
  const unique = 'Smoke note ' + Date.now()
  await page.getByRole('button', { name: /Create a new note/i }).first().click()
  await page.waitForTimeout(500)
  const titleInput = page.locator('#note-title-editor')
  await titleInput.click()
  await titleInput.fill(unique)
  await page.waitForTimeout(300)
  const bodyEditor = page.locator('#note-text-editor')
  if ((await bodyEditor.count()) > 0) {
    await bodyEditor.click()
    await bodyEditor.fill('typed in a real browser')
  }
  await page.waitForTimeout(800)

  // 3. The note shows up in the note list by its unique title.
  check('the new note appears in the list by title', (await page.getByText(unique).count()) > 0)

  // 4. The Super (rich) editor loads when the note type is switched.
  let superLoaded = false
  try {
    await page.getByRole('button', { name: /Change note type/i }).first().click()
    await page.waitForTimeout(500)
    await page.getByText(/^Super/).first().click()
    await page.waitForSelector('#blocks-editor, [data-lexical-editor="true"], .ContentEditable__root', { timeout: 8000 })
    superLoaded = true
  } catch {
    superLoaded = (await page.locator('#blocks-editor, .ContentEditable__root').count()) > 0
  }
  check('the Super (Lexical) editor loads', superLoaded)

  // 5. No fatal console errors during the whole flow.
  const fatal = consoleErrors.filter((e) => !/favicon|manifest|sourcemap|Download the React DevTools/i.test(e))
  if (fatal.length) console.log('  console errors:', fatal.slice(0, 5).join(' || '))
  check('no fatal console/page errors during the flow', fatal.length === 0)

  await browser.close()
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
