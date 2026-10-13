/**
 * Can Playwright drive the STOCK Firefox named by `STOCK_FIREFOX` at all?
 *
 * Exit 0 and one line saying which browser answered, or exit 1 and one line
 * saying why not. Nothing about the app is loaded.
 *
 * WHY IT IS SEPARATE FROM THE SPECS. The `stock-firefox` project drives whatever
 * Firefox the machine has, over a channel Playwright still calls experimental. A
 * CI runner's Firefox changes with the runner image, not with this repository,
 * so "the browser could not be driven" has to be told apart from "the browser
 * was driven and the app is wrong": the first is a notice and the second is a
 * failure. A spec cannot make that distinction about itself — a diagram that
 * never renders and a browser that never started both end as a timeout — so the
 * CI step asks this question first, and only a browser that passes it is
 * allowed to turn the job red.
 *
 * It also checks the one thing the project relies on beyond launching: that the
 * `ui.prefersReducedMotion` preference reaches the page. Over WebDriver BiDi
 * Playwright's own `reducedMotion` option is ignored, so the preference is the
 * only way that browser gets into the mode the specs are about.
 *
 *   STOCK_FIREFOX=/usr/bin/firefox node helpers/stock-firefox-preflight.mjs
 */
import { firefox } from 'playwright-core'

const executablePath = process.env.STOCK_FIREFOX ?? ''
if (executablePath === '') {
  console.error('STOCK_FIREFOX is not set: name the stock Firefox executable to check.')
  process.exit(1)
}

let browser
try {
  browser = await firefox.launch({
    channel: 'moz-firefox',
    executablePath,
    firefoxUserPrefs: { 'ui.prefersReducedMotion': 1 },
    timeout: 60_000,
  })
  const page = await browser.newPage()
  await page.goto('about:blank')
  const reduce = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (!reduce) {
    throw new Error('it started, but the reduced-motion preference did not reach the page')
  }
  console.log(
    `Stock Firefox ${browser.version()} at ${executablePath} answers over WebDriver BiDi, with reduced motion on.`,
  )
} catch (error) {
  const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
  console.error(`Stock Firefox at ${executablePath} could not be driven: ${reason}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
}
