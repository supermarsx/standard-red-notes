/**
 * Browser e2e for the account-menu Export/Import entries. Drives the real app in
 * headless Chromium: opens the account menu, asserts both Export and Import are
 * present, opens the Export modal and confirms the three ungated options
 * (Encrypted backup / Decrypted backup / Markdown). Stack-gated.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`${APP}/`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(2800)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
  }

  // Create a note with known content so the Markdown export has something real.
  const NOTE_TITLE = 'ExportMeNote' + Date.now()
  await page.getByRole('button', { name: /Create a new note/i }).first().click({ force: true })
  await page.waitForTimeout(600)
  const bodyEditor = page.locator('#note-text-editor')
  if ((await bodyEditor.count()) > 0) {
    await bodyEditor.click()
    await bodyEditor.fill('markdown export body content')
  }
  await page.locator('#note-title-editor').click()
  await page.locator('#note-title-editor').fill(NOTE_TITLE)
  await page.keyboard.press('Tab') // blur to persist the title
  await page.waitForTimeout(1500)
  check('the new note is saved (appears in the list)', (await page.getByText(NOTE_TITLE).count()) > 0)

  // Open the account menu.
  await page.getByRole('button', { name: /Open Account menu/i }).first().click()
  await page.waitForTimeout(700)
  const menuText = (await page.locator('body').innerText()).toLowerCase()
  check('account menu has an Export entry', /\bexport\b/.test(menuText))
  check('account menu has an Import entry', /\bimport\b/.test(menuText))

  // Open the Export modal.
  await page.getByText(/^Export$/).first().click()
  await page.waitForTimeout(900)
  const body = await page.locator('body').innerText()
  check('Export modal shows the Encrypted backup option', /Encrypted backup/i.test(body))
  check('Export modal shows the Decrypted backup option', /Decrypted backup/i.test(body))
  check('Export modal shows the Markdown option', /Markdown/i.test(body))
  check('Export modal has no premium/upgrade gate', !/upgrade|premium|not entitled|subscribe to/i.test(body))

  // Actually run the Markdown export and verify it downloads a real zip that
  // contains the note (the new markdown-export code, end to end).
  const buttons = page.getByRole('button', { name: /^Export$/ })
  check('Export modal exposes the three Export actions', (await buttons.count()) >= 3)

  let zipOk = false
  let zipHasNote = false
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      buttons.nth(2).click({ force: true }), // Markdown is the third option
    ])
    const path = await download.path()
    const buf = readFileSync(path)
    zipOk = buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b // 'PK' zip magic
    zipHasNote = buf.includes(Buffer.from(NOTE_TITLE)) // note title appears as the .md filename
  } catch (e) {
    console.log('  markdown export error:', e instanceof Error ? e.message.split('\n')[0] : e)
  }
  check('Markdown export downloads a valid .zip', zipOk)
  check('the exported zip contains the note', zipHasNote)

  const fatal = errors.filter((e) => !/favicon|manifest|sourcemap|React DevTools|JSON/i.test(e))
  if (fatal.length) console.log('  console errors:', fatal.slice(0, 4).join(' || '))
  check('no fatal console errors opening export/import', fatal.length === 0)

  await browser.close()
  console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E ERROR:', e instanceof Error ? e.message : e)
  process.exit(1)
})
