import { test, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { waitForApplicationReady } from '../helpers/sync'
import {
  type MermaidLayout,
  createSuperNote,
  measureMermaidBlock,
  mermaidBlockClip,
  openNote,
  superNoteWithDiagrams,
  waitForDiagrams,
} from '../helpers/mermaid'

/**
 * Mermaid diagrams in the real app with `prefers-reduced-motion: reduce` ON, in
 * every engine this file is run in. CI runs it in Firefox AND Chromium on every
 * push, with the same assertions in both.
 *
 * WHY THIS EXISTS. The app's owner uses Firefox on Windows over Remote Desktop,
 * and a Remote Desktop session turns the operating system's animation effects
 * off, which Firefox reports as `prefers-reduced-motion: reduce`. Under that
 * media query the app gives every element `transition-duration: 0.001ms`
 * (stylesheets/_animation.scss), and in Firefox a style written and read back in
 * the same task then returns the value it had BEFORE the write. Mermaid lays a
 * diagram out from exactly such reads, so every diagram with HTML labels was
 * drawn about twelve times too large: a four-node flowchart got a viewBox of
 * 3199 x 4285 where 260 x 362 is right, with its arrows ending 991 units from
 * the boxes they point at. It was that way for weeks (fixed in 85fdee25) while
 * every browser check in CI ran Chromium with no motion preference, which never
 * shows it, and it was reported fixed three times on Chromium numbers.
 *
 * So this file does the two things that were missing: it runs in Firefox, and
 * it turns reduced motion on — and it does not trust either until the page
 * itself says so (the first test). It then reads the LAYOUT the browser drew,
 * not a proxy for it: the picture's natural size, how large it is painted
 * inside its block, whether each arrow ends on a box, and whether each label is
 * inside the box that was sized for it.
 *
 * PROVEN ABLE TO FAIL. With the web bundle of 91988013 (the commit before the
 * fix) served in front of the same server, on Linux with the browser builds CI
 * installs: in Firefox the flowchart fails at a natural size of 3200 x 4286 with
 * arrows 990 units from their boxes and the long-label flowchart at 2303 x 6574,
 * while the sequence diagram — SVG text, nothing resized — passes; in Chromium
 * all three pass. That is the owner's report, "only the sequence diagram looks
 * fine", as one test run. On the fixed build both engines pass at 260 x 363,
 * 450 x 267 and 318 x 702. Stock Firefox 157 gives the same split, on Windows
 * and on Linux.
 *
 * WHAT IT IS NOT. Playwright's Firefox is a patched build of Firefox, run here
 * on Linux with reduced motion EMULATED by the test runner. It is not stock
 * Firefox on Windows following the operating system. It shares the style system
 * that produced the defect, which is why it reproduces it; a defect that lives
 * in Windows font metrics, in the OS preference plumbing, or in a browser other
 * than the ones it is run in is outside what this can see.
 *
 * IN STOCK FIREFOX (the `stock-firefox` project, see playwright.config.ts) the
 * `reducedMotion` option below does nothing: Playwright drives that browser over
 * WebDriver BiDi, which ignores it, and the project sets the browser's own
 * preference instead. The first test is what tells the two apart — it failed,
 * correctly, on the one run where neither was in force.
 *
 * REQUIRES the docker stack up. Runs signed out: nothing here needs an account.
 */

type Expectation = {
  name: string
  code: string
  nodes: number
  arrows: number
  /** Labelled things: node labels plus arrow labels. */
  labels: number
  actors: number
  /** The picture's natural size in user units, as [least, most]. */
  width: [number, number]
  height: [number, number]
}

/**
 * The first two are the owner's own diagrams, as reported. The bounds are wide
 * on purpose — about a third either side of the size every correct run has
 * produced — because label widths follow the fonts installed on the machine. The
 * defect does not hide in that margin: it made each picture 8 to 12 times larger.
 */
const FLOWCHART: Expectation = {
  name: 'flowchart',
  code: [
    'graph TD',
    '  A["Start"]',
    '  B{"Decision"}',
    '  C["OK"]',
    '  D["Rethink"]',
    '  A --> B',
    '  B -->|Yes| C',
    '  B -->|No| D',
  ].join('\n'),
  nodes: 4,
  arrows: 3,
  labels: 6,
  actors: 0,
  width: [170, 400],
  height: [240, 520],
}

const SEQUENCE: Expectation = {
  name: 'sequence diagram',
  code: [
    'sequenceDiagram',
    '  participant U as User',
    '  participant S as Server',
    '  U->>S: Request',
    '  S-->>U: Response',
  ].join('\n'),
  nodes: 0,
  arrows: 0,
  labels: 0,
  // Each participant is drawn at the top and again at the bottom.
  actors: 4,
  width: [300, 650],
  height: [180, 400],
}

const LONG_LABEL: Expectation = {
  name: 'flowchart with long labels',
  code: [
    'graph TD',
    '  A[Collect every input the caller supplied and validate each field] --> B[Persist]',
    '  B --> C{Is the stored record acceptable to the downstream consumer}',
    '  C -->|Yes it is| D[Done]',
    '  C -->|No it is not| A',
  ].join('\n'),
  nodes: 4,
  arrows: 4,
  labels: 6,
  actors: 0,
  width: [250, 700],
  height: [450, 1100],
}

const DIAGRAMS = [FLOWCHART, SEQUENCE, LONG_LABEL] as const

/** An arrow may stop short of a box by its arrowhead. Measured 4 units; the defect left 991. */
const ARROW_REACH = 12
/** Sub-pixel rounding between a measured label and the box sized for it. */
const LABEL_TOLERANCE = 1.5
/**
 * Painted size against natural size. In this window each of these pictures fits
 * its block and every correct run painted it at exactly its natural size, 1. A
 * laid-out-too-large diagram is shrunk to fit instead: 0.14 on the broken build,
 * which on screen is a few specks in an empty box.
 */
const SCALE_FLOOR = 0.5
const SCALE_CEILING = 1.02

const WINDOW = { width: 1600, height: 1000 }

// Not `serial`: each test must give its own verdict. The owner's report was
// "only the sequence diagram looks fine, anything else looks wrong", and a run
// that stops at the first failure cannot say that. After a failure Playwright
// starts a fresh worker, so `beforeAll` opens the app and the note again.
test.describe.configure({ timeout: 3 * 60_000 })

test.describe('Mermaid diagrams with reduced motion on', () => {
  let context: BrowserContext
  let page: Page
  const pageErrors: string[] = []

  test.beforeAll(async ({ browser, baseURL }) => {
    // A hook does not take the describe's timeout; it has to be told.
    test.setTimeout(3 * 60_000)
    // The mode is set HERE, on the context this file opens itself, and then
    // confirmed from inside the page by the first test. A desktop-sized window:
    // the block shrinks a picture to fit, and in a narrow one every diagram is
    // scaled and none is seen at its natural size.
    context = await browser.newContext({ reducedMotion: 'reduce', baseURL, viewport: WINDOW })
    page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForApplicationReady(page)

    const title = `Reduced-motion diagrams ${Date.now()}`
    const uuid = await createSuperNote(page, title, superNoteWithDiagrams(DIAGRAMS))
    await openNote(page, uuid, title)
    await waitForDiagrams(page, DIAGRAMS.length)
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test('the page really is in reduced-motion mode, with every transition clamped rather than removed', async ({
    browser,
    browserName,
  }, testInfo) => {
    // Asked of the page, not of the runner's settings: every earlier measurement
    // of this defect was taken in a browser that turned out not to be in this
    // mode at all.
    const motion = await page.evaluate(() => {
      const probe = document.createElement('div')
      document.body.append(probe)
      const style = getComputedStyle(probe)
      const reading = {
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionProperty: style.transitionProperty,
        transitionDurationSeconds: Number.parseFloat(style.transitionDuration),
      }
      probe.remove()
      return reading
    })
    // Which engine these results came from, in the report and in the log: a
    // result is only worth what the browser that produced it is. Not the user
    // agent string, which the project's device profile overrides.
    const engine = `${browserName} ${browser.version()} on ${process.platform}`
    testInfo.annotations.push({ type: 'engine', description: engine })
    console.log(`[reduced-motion] engine: ${engine}; prefers-reduced-motion: reduce = ${motion.reduce}`)

    expect(motion.reduce, 'matchMedia("(prefers-reduced-motion: reduce)") must match inside the page').toBe(true)
    // The condition the defect needs: an ordinary element still transitions every
    // property, for a duration that is tiny and NOT zero. If the app ever stops
    // doing this the layout tests below still stand, but they would no longer be
    // guarding against this cause, and this line is where that shows.
    expect(motion.transitionProperty, 'an ordinary element still transitions every property').toBe('all')
    expect(motion.transitionDurationSeconds, 'the clamped duration is above zero').toBeGreaterThan(0)
    expect(motion.transitionDurationSeconds, 'the clamped duration is the 0.001ms clamp').toBeLessThan(0.001)
  })

  for (const [index, diagram] of DIAGRAMS.entries()) {
    test(`${diagram.name}: laid out at its natural size, arrows on their boxes, labels inside theirs`, async ({}, testInfo) => {
      const layout = await measureMermaidBlock(page, index)
      await record(page, index, diagram, layout, testInfo)

      // With no picture there is nothing to measure, so these two stop the test.
      // Every number after them is a soft assertion: a wrong layout is wrong in
      // several ways at once, and the report should list all of them.
      expect(layout.error, 'mermaid must not refuse the text').toBeNull()
      expect(layout.drawn, 'the block must hold a picture').toBe(true)

      // What was drawn is the diagram that was written: the counts are what make
      // every "all of them" below mean something.
      expect.soft(layout.nodes.length, 'node boxes').toBe(diagram.nodes)
      expect.soft(layout.arrows.length, 'arrows').toBe(diagram.arrows)
      expect.soft(layout.labels.length, 'labels').toBe(diagram.labels)
      expect.soft(layout.actors.length, 'participant boxes').toBe(diagram.actors)

      // THE NATURAL SIZE. This is the number that was wrong.
      expect.soft(layout.viewBox.w, 'natural width, in user units').toBeGreaterThanOrEqual(diagram.width[0])
      expect.soft(layout.viewBox.w, 'natural width, in user units').toBeLessThanOrEqual(diagram.width[1])
      expect.soft(layout.viewBox.h, 'natural height, in user units').toBeGreaterThanOrEqual(diagram.height[0])
      expect.soft(layout.viewBox.h, 'natural height, in user units').toBeLessThanOrEqual(diagram.height[1])

      // THE PAINTED SIZE, against the natural size and against the block.
      expect.soft(layout.scale, 'painted pixels per user unit').toBeGreaterThanOrEqual(SCALE_FLOOR)
      expect.soft(layout.scale, 'painted pixels per user unit').toBeLessThanOrEqual(SCALE_CEILING)
      expect.soft(layout.painted.w, 'the picture is no wider than the block showing it').toBeLessThanOrEqual(
        layout.viewport.w + 1,
      )
      expect.soft(layout.painted.x, 'the picture starts inside the block showing it').toBeGreaterThanOrEqual(
        layout.viewport.x - 1,
      )

      // THE ARROWS. Laid out from stale boxes, each ended in empty space.
      for (const [position, arrow] of layout.arrows.entries()) {
        expect.soft(arrow.startGap, `arrow ${position + 1} starts on a box`).toBeLessThanOrEqual(ARROW_REACH)
        expect.soft(arrow.endGap, `arrow ${position + 1} ends on a box`).toBeLessThanOrEqual(ARROW_REACH)
      }

      // THE LABELS. Inside the slot measured for them, and inside their own box.
      for (const label of layout.labels) {
        expect.soft(label.spill, `"${label.text}" fits the slot reserved for it`).toBeLessThanOrEqual(LABEL_TOLERANCE)
        if (label.spillPastNode !== null) {
          expect.soft(label.spillPastNode, `"${label.text}" is inside its box`).toBeLessThanOrEqual(LABEL_TOLERANCE)
        }
      }
      for (const actor of layout.actors) {
        expect.soft(actor.text, 'every participant box has its name inside it').not.toBe('')
        expect.soft(actor.spill, `"${actor.text}" is inside its participant box`).toBeLessThanOrEqual(LABEL_TOLERANCE)
      }
      expect.soft(layout.textPastPicture, 'no text is drawn outside the picture').toBeLessThanOrEqual(LABEL_TOLERANCE)
      expect.soft(layout.nodeOverlapArea, 'no two boxes are drawn on top of each other').toBe(0)
    })
  }

  test('nothing in the page threw while the diagrams were drawn', async () => {
    expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([])
  })
})

/**
 * Keeps the numbers and the picture with the run, pass or fail: the numbers in
 * the report and, in one line, in the log; the picture in the test's output
 * folder, which CI uploads. A layout that is wrong is judged from the picture;
 * the numbers say by how much.
 */
async function record(
  page: Page,
  index: number,
  diagram: Expectation,
  layout: MermaidLayout,
  testInfo: TestInfo,
): Promise<void> {
  await testInfo.attach(`${diagram.name} layout`, {
    body: JSON.stringify(layout, null, 2),
    contentType: 'application/json',
  })
  const gaps = layout.arrows.flatMap((arrow) => [arrow.startGap, arrow.endGap])
  console.log(
    `[reduced-motion] ${testInfo.project.name} ${diagram.name}: natural ${layout.viewBox.w} x ${layout.viewBox.h}, ` +
      `painted ${layout.painted.w} x ${layout.painted.h} in a ${layout.viewport.w} wide block (scale ${layout.scale})` +
      (gaps.length > 0 ? `, arrows end within ${Math.max(...gaps)} of a box` : ''),
  )

  const clip = await mermaidBlockClip(page, index)
  await page.screenshot({
    path: testInfo.outputPath(`${diagram.name.replace(/\s+/g, '-')}.png`),
    clip: { x: clip.x, y: clip.y, width: Math.max(1, clip.w), height: Math.max(1, clip.h) },
    animations: 'disabled',
  })
}
