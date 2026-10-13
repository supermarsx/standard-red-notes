import { type Page, expect } from '@playwright/test'

/**
 * Helpers for measuring how a Mermaid diagram was LAID OUT in the real app.
 *
 * WHY LAYOUT AND NOT "AN SVG APPEARED". For weeks every Mermaid diagram except a
 * sequence diagram was drawn about twelve times too large in Firefox whenever
 * `prefers-reduced-motion: reduce` was on: an `<svg>` appeared, mermaid reported
 * no error, every unit test and every Chromium number was green, and it was
 * declared fixed three times. What was wrong was the layout itself — a viewBox
 * of 3199 x 4285 where 260 x 362 is right, arrows ending 991 units from the box
 * they point at — so those are the numbers read here, in the SVG's own user
 * units, straight from what the browser drew.
 *
 * Everything is measured in SVG USER UNITS relative to the viewBox, so a number
 * means the same thing however the block scaled the picture to fit.
 */

export type Box = { x: number; y: number; w: number; h: number }

export type MermaidLabel = {
  text: string
  /** The `foreignObject` mermaid reserved for the label. */
  slot: Box
  /** Where the label's text really is. */
  textBox: Box
  /** How far the text reaches past its reserved slot; <= 0 when it fits. */
  spill: number
  /** How far the text reaches past the box of the node it belongs to; null for a label on an arrow. */
  spillPastNode: number | null
}

export type MermaidLayout = {
  /** What the block shows in place of a picture when mermaid refused the text. */
  error: string | null
  /** False when the block holds no `<svg>` at all. */
  drawn: boolean
  viewBox: { w: number; h: number }
  /** The `<svg>` as painted, in CSS pixels. */
  painted: Box
  /** The block's scrolling viewport, in CSS pixels. */
  viewport: Box
  /** Painted CSS pixels per user unit. 1 is the diagram's natural size. */
  scale: number
  nodes: Array<{ text: string; box: Box }>
  labels: MermaidLabel[]
  /** For each arrow, how far each end is from the nearest node box. 0 when it lands on one. */
  arrows: Array<{ length: number; startGap: number; endGap: number }>
  /** Sequence-diagram participants: the box, and how far its name reaches past it. */
  actors: Array<{ text: string; box: Box; spill: number }>
  /** How far any drawn text reaches past the picture's own edge; <= 0 when all of it is inside. */
  textPastPicture: number
  /** Total area two node boxes share. 0 when none overlap. */
  nodeOverlapArea: number
}

type LexicalNode = Record<string, unknown>

const paragraph = (text: string): LexicalNode => ({
  children: [{ detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 }],
  direction: 'ltr',
  format: '',
  indent: 0,
  type: 'paragraph',
  version: 1,
  textFormat: 0,
  textStyle: '',
})

/** A serialized Super note: a caption and one Mermaid block per diagram, in order. */
export function superNoteWithDiagrams(diagrams: ReadonlyArray<{ name: string; code: string }>): string {
  const children: LexicalNode[] = []
  for (const { name, code } of diagrams) {
    children.push(paragraph(name))
    // No view mode, fit mode or theme: the block's own defaults, as a person
    // inserting a diagram gets them.
    children.push({ type: 'mermaid', version: 5, code })
  }
  children.push(paragraph('end'))

  return JSON.stringify({ root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } })
}

/**
 * Creates a Super note holding `text` through the in-page application and returns its uuid.
 *
 * It first waits for the application's default items key. On a first launch
 * `isLaunched()` turns true a few hundred milliseconds BEFORE that key exists, and
 * an item created in between cannot be encrypted for the local database: the app
 * then raises "Unable to write to local database. Please restart the app and try
 * again." and its modal covers the note list. Measured in Chromium on Linux,
 * where the gap is long enough to land in every time. That is a defect of the
 * app's own (a note made in the first instant of a first launch), and it is not
 * what the callers of this helper are measuring, so they do not walk into it.
 */
export async function createSuperNote(page: Page, title: string, text: string): Promise<string> {
  await page.waitForFunction(
    () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const app = (window as any).mainApplicationGroup?.primaryApplication
      return Boolean(app) && app.items.getItems('SN|ItemsKey').length > 0
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    undefined,
    { timeout: 60_000 },
  )

  return page.evaluate(
    async ({ title, text }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const app = (window as any).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('window.mainApplicationGroup.primaryApplication not available')
      const template = app.items.createTemplateItem('Note', {
        title,
        text,
        references: [],
        noteType: 'super',
        editorIdentifier: 'com.standardnotes.super-editor',
      })
      const note = await app.mutator.insertItem(template)
      await app.sync.sync({ sourceDescription: 'e2e-mermaid-seed' })
      return note.uuid as string
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    { title, text },
  )
}

/**
 * Opens a note by clicking its row, and proves the note that opened is the one
 * asked for: the list re-sorts while items settle, so a click aimed at one row
 * can land on another.
 */
export async function openNote(page: Page, uuid: string, title: string): Promise<void> {
  const row = page.locator(`.content-list-item[id="${uuid}"]`)
  await expect(async () => {
    await row.scrollIntoViewIfNeeded({ timeout: 5_000 })
    await row.click({ timeout: 5_000 })
    // `:visible`, because every note left open keeps its own editor mounted and
    // hidden, each with these same ids.
    await expect(page.locator('#note-title-editor:visible')).toHaveValue(title, { timeout: 3_000 })
    await expect(page.locator('#super-editor-content:visible')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 45_000 })
}

/**
 * Waits until the note shows `count` Mermaid blocks and each one holds either a
 * picture or an error, then until two readings a moment apart agree — the block
 * re-fits itself after the picture lands, and a reading taken between the two
 * describes neither.
 */
export async function waitForDiagrams(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const blocks = Array.from(document.querySelectorAll('[data-mermaid-block]'))
      return (
        blocks.length === expected &&
        blocks.every((block) => block.querySelector('[data-mermaid-svg-host] svg') || block.querySelector('[role=alert]'))
      )
    },
    count,
    { timeout: 90_000 },
  )

  const reading = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-mermaid-block] [data-mermaid-svg-host] svg'))
        .map((svg) => {
          const rect = svg.getBoundingClientRect()
          return `${svg.getAttribute('viewBox')}@${Math.round(rect.width)}x${Math.round(rect.height)}`
        })
        .join('|'),
    )
  let previous = ''
  await expect
    .poll(
      async () => {
        const current = await reading()
        const settled = current !== '' && current === previous
        previous = current
        return settled
      },
      { intervals: [400], timeout: 30_000, message: 'the diagrams never stopped being re-laid-out' },
    )
    .toBe(true)
}

/** Brings Mermaid block `index` into view and returns the element box to photograph. */
export async function mermaidBlockClip(page: Page, index: number): Promise<Box> {
  return page.evaluate(async (index) => {
    const block = document.querySelectorAll('[data-mermaid-block]')[index]
    if (!block) throw new Error(`no Mermaid block ${index}`)
    block.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = block.getBoundingClientRect()
    return { x: Math.max(0, rect.x), y: Math.max(0, rect.y), w: rect.width, h: rect.height }
  }, index)
}

/** Reads the layout of Mermaid block `index` off the page. Self-contained: it runs in the browser. */
export async function measureMermaidBlock(page: Page, index: number): Promise<MermaidLayout> {
  return page.evaluate((index) => {
    type Rect = { x: number; y: number; w: number; h: number }
    const round = (value: number) => Math.round(value * 100) / 100
    const cssBox = (rect: DOMRect): Rect => ({
      x: round(rect.x),
      y: round(rect.y),
      w: round(rect.width),
      h: round(rect.height),
    })
    const empty: Rect = { x: 0, y: 0, w: 0, h: 0 }

    const block = document.querySelectorAll('[data-mermaid-block]')[index]
    if (!block) throw new Error(`no Mermaid block ${index}`)
    const alert = block.querySelector('[role=alert]')
    const viewportElement = block.querySelector('[data-mermaid-viewport]')
    const svg = block.querySelector<SVGSVGElement>('[data-mermaid-svg-host] svg')
    const base = {
      error: alert ? (alert.textContent ?? '').trim() : null,
      viewport: viewportElement ? cssBox(viewportElement.getBoundingClientRect()) : empty,
    }
    if (!svg) {
      return {
        ...base,
        drawn: false,
        viewBox: { w: 0, h: 0 },
        painted: empty,
        scale: 0,
        nodes: [],
        labels: [],
        arrows: [],
        actors: [],
        textPastPicture: 0,
        nodeOverlapArea: 0,
      }
    }

    const painted = svg.getBoundingClientRect()
    const viewBox = (svg.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    const viewBoxWidth = viewBox.length === 4 ? viewBox[2] : 0
    const viewBoxHeight = viewBox.length === 4 ? viewBox[3] : 0
    const scaleX = viewBoxWidth > 0 ? painted.width / viewBoxWidth : 1
    const scaleY = viewBoxHeight > 0 ? painted.height / viewBoxHeight : 1
    /** A client rectangle in user units from the picture's top-left corner. */
    const userBox = (rect: DOMRect): Rect => ({
      x: round((rect.left - painted.left) / scaleX),
      y: round((rect.top - painted.top) / scaleY),
      w: round(rect.width / scaleX),
      h: round(rect.height / scaleY),
    })
    const textOf = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    /** How far `inner` reaches past `outer` on its worst side, in user units. Negative when well inside. */
    const reachPast = (inner: DOMRect, outer: DOMRect) =>
      round(
        Math.max(
          (outer.left - inner.left) / scaleX,
          (inner.right - outer.right) / scaleX,
          (outer.top - inner.top) / scaleY,
          (inner.bottom - outer.bottom) / scaleY,
        ),
      )
    const textRect = (element: Element): DOMRect => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getBoundingClientRect()
    }

    // Outermost node groups only: a subgraph's cluster is not a node, and a node
    // inside another is not counted twice.
    const nodeGroups = Array.from(svg.querySelectorAll<SVGGElement>('g.node')).filter(
      (group, _position, all) => !all.some((other) => other !== group && other.contains(group)),
    )
    const nodeRects = nodeGroups.map((group) => group.getBoundingClientRect())
    const nodes = nodeGroups.map((group, position) => ({
      text: textOf(group).slice(0, 60),
      box: userBox(nodeRects[position]),
    }))

    const labels = Array.from(svg.querySelectorAll('foreignObject'))
      .filter((slot) => textOf(slot) !== '')
      .map((slot) => {
        const slotRect = slot.getBoundingClientRect()
        const drawnText = textRect(slot)
        const owner = nodeGroups.findIndex((group) => group.contains(slot))
        return {
          text: textOf(slot).slice(0, 60),
          slot: userBox(slotRect),
          textBox: userBox(drawnText),
          spill: reachPast(drawnText, slotRect),
          spillPastNode: owner < 0 ? null : reachPast(drawnText, nodeRects[owner]),
        }
      })

    const gapToNearestNode = (x: number, y: number): number => {
      let nearest = Number.POSITIVE_INFINITY
      for (const rect of nodeRects) {
        const dx = Math.max(rect.left - x, 0, x - rect.right) / scaleX
        const dy = Math.max(rect.top - y, 0, y - rect.bottom) / scaleY
        nearest = Math.min(nearest, Math.hypot(dx, dy))
      }
      return round(nearest)
    }
    const arrows = Array.from(svg.querySelectorAll<SVGPathElement>('path.flowchart-link')).map((path) => {
      const length = path.getTotalLength()
      const matrix = path.getScreenCTM()
      const onScreen = (at: number) => {
        const point = path.getPointAtLength(at)
        return matrix ? new DOMPoint(point.x, point.y).matrixTransform(matrix) : new DOMPoint(point.x, point.y)
      }
      const start = onScreen(0)
      const end = onScreen(length)
      return {
        length: round(length),
        startGap: gapToNearestNode(start.x, start.y),
        endGap: gapToNearestNode(end.x, end.y),
      }
    })

    const svgTexts = Array.from(svg.querySelectorAll('text')).filter((text) => textOf(text) !== '')
    const actors = Array.from(svg.querySelectorAll<SVGRectElement>('rect.actor')).map((actor) => {
      const actorRect = actor.getBoundingClientRect()
      const name = svgTexts.find((text) => {
        const rect = text.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        return cx >= actorRect.left && cx <= actorRect.right && cy >= actorRect.top && cy <= actorRect.bottom
      })
      return {
        text: name ? textOf(name).slice(0, 60) : '',
        box: userBox(actorRect),
        // An actor with no name inside it is as wrong as one whose name hangs out.
        spill: name ? reachPast(name.getBoundingClientRect(), actorRect) : Number.MAX_SAFE_INTEGER,
      }
    })

    const everyText = [
      ...svgTexts.map((text) => text.getBoundingClientRect()),
      ...Array.from(svg.querySelectorAll('foreignObject'))
        .filter((slot) => textOf(slot) !== '')
        .map((slot) => textRect(slot)),
    ]
    const textPastPicture = everyText.length === 0 ? 0 : Math.max(...everyText.map((rect) => reachPast(rect, painted)))

    let nodeOverlapArea = 0
    for (let first = 0; first < nodeRects.length; first++) {
      for (let second = first + 1; second < nodeRects.length; second++) {
        const a = nodeRects[first]
        const b = nodeRects[second]
        const width = (Math.min(a.right, b.right) - Math.max(a.left, b.left)) / scaleX
        const height = (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / scaleY
        if (width > 0.5 && height > 0.5) {
          nodeOverlapArea += width * height
        }
      }
    }

    return {
      ...base,
      drawn: true,
      viewBox: { w: round(viewBoxWidth), h: round(viewBoxHeight) },
      painted: cssBox(painted),
      scale: round(scaleX),
      nodes,
      labels,
      arrows,
      actors,
      textPastPicture: round(textPastPicture),
      nodeOverlapArea: round(nodeOverlapArea),
    }
  }, index)
}
