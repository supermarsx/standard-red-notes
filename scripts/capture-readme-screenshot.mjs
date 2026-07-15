import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(process.env.SRN_SCREENSHOT_OUT ?? join(ROOT, 'docs', 'assets', 'readme-screenshot.png'))
const APP_URL = process.env.APP_URL ?? process.env.SRN_SCREENSHOT_URL ?? 'http://localhost:3001'

const requireFromE2E = createRequire(join(ROOT, 'e2e', 'package.json'))
const { chromium } = requireFromE2E('playwright')

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
].filter(Boolean)

function launchOptions() {
  const executablePath = chromeCandidates.find((candidate) => {
    try {
      return candidate && existsSync(candidate)
    } catch {
      return false
    }
  })
  return executablePath ? { executablePath } : {}
}

async function waitForApp(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.main-ui-view, #footer-bar, body').first().waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(
    () => document.body.children.length > 0 && document.body.innerText.length > 0,
    undefined,
    { timeout: 60_000 },
  )
}

async function seedDemoNotes(page) {
  await page.waitForFunction(
    () => Boolean(window.mainApplicationGroup?.primaryApplication?.mutator),
    undefined,
    { timeout: 30_000 },
  )
  await page.evaluate(async () => {
    const app = window.mainApplicationGroup?.primaryApplication
    if (!app?.mutator || !app?.items) return

    const titles = new Set((app.items.getItems?.('Note') ?? []).map((note) => note.title))
    const notes = [
      {
        title: 'Project launch brief',
        text:
          'Standard Red Notes keeps the Standard Notes encryption model and adds self-hosted operations, invite controls, app passwords, and operator docs.',
      },
      {
        title: 'Research inbox',
        text:
          'Use tags, backlinks, protected notes, file attachments, and advanced search to keep private research organized across devices.',
      },
      {
        title: 'Operations checklist',
        text:
          'Back up the data volume, keep server images current, verify the health endpoint, and review admin registration settings after each deploy.',
      },
    ]

    for (const note of notes) {
      if (!titles.has(note.title)) {
        await app.mutator.createItem('Note', note, true)
      }
    }

    try {
      await app.sync?.sync?.({ sourceDescription: 'readme-screenshot-seed' })
    } catch {
      // A static/offline web app can still render local seeded notes; sync is not
      // required for the screenshot.
    }
  })

  await page.waitForTimeout(800)
  const launchBrief = page.getByText('Project launch brief').first()
  if (await launchBrief.count()) {
    await launchBrief.click({ timeout: 5_000 }).catch(() => undefined)
  }
}

async function polishForScreenshot(page) {
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      body { background: #f8f1ed !important; }
      .sk-modal-background, .modal, [role="dialog"] { display: none !important; }
    `,
  })
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-srn-readme-screenshot', 'true')
  })
  await page.waitForTimeout(500)
}

mkdirSync(dirname(OUT), { recursive: true })

const browser = await chromium.launch({ headless: true, ...launchOptions() })
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  await waitForApp(page)
  await seedDemoNotes(page).catch((error) => {
    console.warn(`Could not seed demo notes; capturing the loaded app shell instead: ${error.message}`)
  })
  await polishForScreenshot(page)
  await page.screenshot({ path: OUT, fullPage: false })
  console.log(`Captured README screenshot from ${APP_URL} -> ${OUT}`)
} finally {
  await browser.close()
}
