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
const DEMO_SUPER_TITLE = 'Super note demo'

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
  const seeded = await page.evaluate(async (demoSuperTitle) => {
    const app = window.mainApplicationGroup?.primaryApplication
    if (!app?.mutator || !app?.items) return { superUuid: undefined }

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

    let superNote = (app.items.getItems?.('Note') ?? []).find((note) => note.title === demoSuperTitle)
    if (!superNote) {
      const template = app.items.createTemplateItem('Note', {
        title: demoSuperTitle,
        text: '',
        references: [],
        noteType: 'super',
        editorIdentifier: 'com.standardnotes.super-editor',
      })
      superNote = await app.mutator.insertItem(template)
    }

    try {
      await app.sync?.sync?.({ sourceDescription: 'readme-screenshot-seed' })
    } catch {
      // A static/offline web app can still render local seeded notes; sync is not
      // required for the screenshot.
    }
    return { superUuid: superNote?.uuid }
  }, DEMO_SUPER_TITLE)

  await page.waitForTimeout(800)
  if (seeded.superUuid) {
    const row = page.locator(`.content-list-item[id="${seeded.superUuid}"]`).first()
    await row.waitFor({ state: 'visible', timeout: 20_000 })
    await row.click({ timeout: 10_000 })
    const editor = page.locator('#super-editor-content:visible').first()
    await editor.waitFor({ state: 'visible', timeout: 20_000 })
    await editor.click({ timeout: 5_000 })
    await page.keyboard.type('Self-hosted launch plan')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Encrypted sync, admin controls, and operator drills in one workspace.')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Default theme, Super note editor, and local-first privacy.')
  }
}

async function polishForScreenshot(page) {
  await page.addStyleTag({
    content: `
      * { caret-color: transparent !important; }
      .sk-modal-background, .modal, [role="dialog"] { display: none !important; }
      [data-srn-readme-label] {
        position: fixed;
        top: 18px;
        right: 22px;
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border: 1px solid rgba(190, 31, 45, 0.22);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.9);
        color: #2b2020;
        box-shadow: 0 10px 24px rgba(34, 24, 24, 0.12);
        backdrop-filter: blur(12px);
        font: 650 12px/1.3 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        pointer-events: none;
      }
      [data-srn-readme-label]::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #be1f2d;
        box-shadow: 0 0 0 3px rgba(190, 31, 45, 0.12);
      }
    `,
  })
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-srn-readme-screenshot', 'true')
    const existing = document.querySelector('[data-srn-readme-label]')
    existing?.remove()
    const label = document.createElement('div')
    label.setAttribute('data-srn-readme-label', 'true')
    label.textContent = 'Default theme - Super note demo'
    document.body.append(label)
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
