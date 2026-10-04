/**
 * @jest-environment jsdom
 *
 * Round-trips MermaidNode's persisted size (t113) through
 * exportJSON -> importJSON -> exportJSON, and pins what happens to a stored
 * value another client could have written: it is re-parsed and re-clamped on
 * import, and anything unparseable degrades to "fit the container" rather than
 * being carried through to a style attribute.
 *
 * Like the other decorator nodes, constructing one assigns a key — a write that
 * needs an active editor context — so everything runs inside a headless
 * editor.update(). Only the node class is imported, not its React component.
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $createMermaidNode, MERMAID_VERSION, MermaidNode, SerializedMermaidNode } from './MermaidNode'
import {
  MAX_MERMAID_HEIGHT_PX,
  MAX_MERMAID_WIDTH_PERCENT,
  MAX_MERMAID_WIDTH_PX,
  MIN_MERMAID_HEIGHT_PX,
  MIN_MERMAID_WIDTH_PERCENT,
  MIN_MERMAID_WIDTH_PX,
} from './MermaidWidth'
import { DEFAULT_MERMAID_THEME_MODE, MAX_MERMAID_MAX_HEIGHT_PX, MIN_MERMAID_MAX_HEIGHT_PX } from './MermaidSettings'

const editor = createHeadlessEditor({
  namespace: 'MermaidNodeSerializationTest',
  nodes: [MermaidNode],
  onError: (error) => {
    throw error
  },
})

function inEditor<T>(fn: () => T): T {
  let result: T
  editor.update(
    () => {
      result = fn()
    },
    { discrete: true },
  )
  return result!
}

const CODE = 'graph TD\n  A --> B'

/** Import a hand-written serialization and read back the stored size. */
const importSize = (raw: Partial<SerializedMermaidNode> & Record<string, unknown>) =>
  inEditor(() => {
    const node = MermaidNode.importJSON({
      type: 'mermaid',
      version: MERMAID_VERSION,
      code: CODE,
      theme: 'default',
      viewMode: 'split',
      ...raw,
    } as SerializedMermaidNode)
    return { width: node.getWidth(), height: node.getHeight() }
  })

describe('MermaidNode — a fresh node stores no size at all', () => {
  it('has no width and no height, so it fits its container', () => {
    const { width, height } = inEditor(() => {
      const node = $createMermaidNode(CODE)
      return { width: node.getWidth(), height: node.getHeight() }
    })
    expect(width).toBeUndefined()
    expect(height).toBeUndefined()
  })

  it('omits both from the serialized JSON (they stringify away as undefined)', () => {
    const json = inEditor(() => $createMermaidNode(CODE).exportJSON())
    expect(json.width).toBeUndefined()
    expect(json.height).toBeUndefined()
    expect(JSON.parse(JSON.stringify(json))).not.toHaveProperty('width')
    expect(JSON.parse(JSON.stringify(json))).not.toHaveProperty('height')
  })
})

describe('MermaidNode — the size round-trips', () => {
  // Every pair here is already in range, so a round-trip must be the identity;
  // out-of-range clamping is covered separately below.
  it.each([
    ['50%', 300],
    ['420px', undefined],
    ['100%', MAX_MERMAID_HEIGHT_PX],
    ['80px', MIN_MERMAID_HEIGHT_PX],
  ])('keeps width %s / height %s across export -> import -> export', (width, height) => {
    const roundTripped = inEditor(() => {
      const first = $createMermaidNode(CODE, 'default', 'split', width as string, height as number | undefined)
      const exported = first.exportJSON()
      const reimported = MermaidNode.importJSON(exported)
      return reimported.exportJSON()
    })
    expect(roundTripped.width).toBe(width)
    expect(roundTripped.height).toBe(height)
    expect(roundTripped.type).toBe('mermaid')
    expect(roundTripped.version).toBe(MERMAID_VERSION)
  })

  it('still carries the code, theme and view mode alongside the new fields', () => {
    const json = inEditor(() => $createMermaidNode(CODE, 'forest', 'preview', '60%', 240).exportJSON())
    expect(json).toEqual({
      type: 'mermaid',
      version: MERMAID_VERSION,
      code: CODE,
      theme: 'forest',
      viewMode: 'preview',
      width: '60%',
      height: 240,
      // Version 4 (t118): the shared settings set. Written explicitly so a note
      // keeps the behaviour it was authored with even if a default later moves;
      // `maxHeight` is the one exception — absent means "follow the window", and
      // writing today's resolved pixel number would freeze this window's height
      // into the note.
      fitMode: 'fitWidth',
      maxHeight: undefined,
      alignment: 'left',
      background: 'transparent',
      zoomPan: true,
    })
  })

  it('round-trips every version-4 setting', () => {
    const roundTripped = inEditor(() => {
      const first = $createMermaidNode(CODE, 'app', 'split', undefined, undefined, {
        fitMode: 'actual',
        maxHeight: 'none',
        alignment: 'center',
        background: 'themed',
        zoomPan: false,
      })
      return MermaidNode.importJSON(first.exportJSON()).exportJSON()
    })
    expect(roundTripped.fitMode).toBe('actual')
    expect(roundTripped.maxHeight).toBe('none')
    expect(roundTripped.alignment).toBe('center')
    expect(roundTripped.background).toBe('themed')
    expect(roundTripped.zoomPan).toBe(false)
    expect(roundTripped.theme).toBe('app')
  })

  it.each([
    ['fitMode', 'sideways'],
    ['alignment', 'middle'],
    ['background', 'rainbow'],
    ['zoomPan', 'yes'],
    ['maxHeight', 'tall'],
  ])('falls back to the default for the unparseable stored %s %p', (field, stored) => {
    const json = inEditor(() =>
      MermaidNode.importJSON({
        type: 'mermaid',
        version: 4,
        code: CODE,
        theme: 'default',
        viewMode: 'split',
        [field]: stored,
      } as unknown as SerializedMermaidNode).exportJSON(),
    )
    const defaults: Record<string, unknown> = {
      fitMode: 'fitWidth',
      alignment: 'left',
      background: 'transparent',
      zoomPan: true,
      maxHeight: undefined,
    }
    expect((json as unknown as Record<string, unknown>)[field]).toBe(defaults[field])
  })

  it('clamps a stored maximum height into range instead of trusting it', () => {
    const tooSmall = inEditor(() =>
      MermaidNode.importJSON({
        type: 'mermaid',
        version: 4,
        code: CODE,
        theme: 'default',
        viewMode: 'split',
        maxHeight: 1,
      } as unknown as SerializedMermaidNode).exportJSON(),
    )
    const tooLarge = inEditor(() =>
      MermaidNode.importJSON({
        type: 'mermaid',
        version: 4,
        code: CODE,
        theme: 'default',
        viewMode: 'split',
        maxHeight: 999999,
      } as unknown as SerializedMermaidNode).exportJSON(),
    )
    expect(tooSmall.maxHeight).toBe(MIN_MERMAID_MAX_HEIGHT_PX)
    expect(tooLarge.maxHeight).toBe(MAX_MERMAID_MAX_HEIGHT_PX)
  })
})

describe('MermaidNode — a stored size is re-validated on import, never trusted', () => {
  it('normalizes a bare number to pixels', () => {
    expect(importSize({ width: '420' as unknown as string }).width).toBe('420px')
  })

  it('clamps an out-of-range percentage', () => {
    expect(importSize({ width: '0.5%' }).width).toBe(`${MIN_MERMAID_WIDTH_PERCENT}%`)
    expect(importSize({ width: '250%' }).width).toBe(`${MAX_MERMAID_WIDTH_PERCENT}%`)
  })

  it('clamps an out-of-range pixel width', () => {
    expect(importSize({ width: '2px' }).width).toBe(`${MIN_MERMAID_WIDTH_PX}px`)
    expect(importSize({ width: '100000px' }).width).toBe(`${MAX_MERMAID_WIDTH_PX}px`)
  })

  it('clamps an out-of-range height', () => {
    expect(importSize({ height: 1 }).height).toBe(MIN_MERMAID_HEIGHT_PX)
    expect(importSize({ height: 99999 }).height).toBe(MAX_MERMAID_HEIGHT_PX)
    expect(importSize({ height: -400 }).height).toBe(MIN_MERMAID_HEIGHT_PX)
  })

  it.each([
    ['auto'],
    ['fit-content'],
    ['50 px'],
    ['50vw'],
    ['-20%'],
    ['calc(100% - 2rem)'],
    ['100%;position:fixed;inset:0'],
    ['420px"><script>alert(1)</script>'],
    [''],
    ['   '],
  ])('falls back to fitting for the unparseable stored width %p', (stored) => {
    expect(importSize({ width: stored }).width).toBeUndefined()
  })

  it.each([[null], [undefined], [{}], [[]], ['50%'], [NaN], [Infinity]])(
    'falls back to auto-fit for the unparseable stored height %p',
    (stored) => {
      expect(importSize({ height: stored as unknown as number }).height).toBeUndefined()
    },
  )

  it('never throws, whatever the serialization holds', () => {
    for (const bad of [null, undefined, 0, -1, {}, [], true, () => '50%']) {
      expect(() => importSize({ width: bad as unknown as string, height: bad as unknown as number })).not.toThrow()
    }
  })

  it('re-exports only normalized values, so a malformed stored width cannot be written back out', () => {
    const json = inEditor(() =>
      MermaidNode.importJSON({
        type: 'mermaid',
        version: 2,
        code: CODE,
        theme: 'default',
        viewMode: 'split',
        width: 'auto',
        height: Number.NaN,
      } as SerializedMermaidNode).exportJSON(),
    )
    expect(json.width).toBeUndefined()
    expect(json.height).toBeUndefined()
    expect(JSON.stringify(json)).not.toContain('auto')
  })
})

describe('MermaidNode — backward compatibility with versions 1 and 2', () => {
  it('imports a version-1 node (code only) with no size', () => {
    const { width, height } = inEditor(() => {
      const node = MermaidNode.importJSON({ type: 'mermaid', version: 1, code: CODE } as SerializedMermaidNode)
      return { width: node.getWidth(), height: node.getHeight() }
    })
    expect(width).toBeUndefined()
    expect(height).toBeUndefined()
  })

  it('imports a version-2 node (code + theme + viewMode) with no size', () => {
    const node = inEditor(() =>
      MermaidNode.importJSON({
        type: 'mermaid',
        version: 2,
        code: CODE,
        theme: 'dark',
        viewMode: 'code',
      } as SerializedMermaidNode).exportJSON(),
    )
    expect(node.theme).toBe('dark')
    expect(node.viewMode).toBe('code')
    expect(node.width).toBeUndefined()
    expect(node.height).toBeUndefined()
  })

  it('upgrades what it writes to the current version', () => {
    const node = inEditor(() =>
      MermaidNode.importJSON({ type: 'mermaid', version: 1, code: CODE } as SerializedMermaidNode).exportJSON(),
    )
    expect(node.version).toBe(MERMAID_VERSION)
    expect(MERMAID_VERSION).toBe(4)
  })

  /**
   * The rule that keeps an existing note looking the way it was authored: the
   * default theme MODE moved to `app` (follow the application's light/dark theme)
   * in version 4, but versions 2 and 3 always WROTE a `theme`, so every existing
   * diagram carries an explicit one and keeps it. Only a diagram with no theme at
   * all — a version-1 node — picks up the new default.
   */
  it('keeps a version-2/3 stored theme rather than adopting the new default', () => {
    for (const stored of ['default', 'dark', 'forest', 'neutral', 'base']) {
      const json = inEditor(() =>
        MermaidNode.importJSON({
          type: 'mermaid',
          version: 3,
          code: CODE,
          theme: stored,
          viewMode: 'split',
        } as unknown as SerializedMermaidNode).exportJSON(),
      )
      expect(json.theme).toBe(stored)
    }
  })

  it('gives a version-1 node (no theme at all) the new app-following default', () => {
    const json = inEditor(() =>
      MermaidNode.importJSON({ type: 'mermaid', version: 1, code: CODE } as SerializedMermaidNode).exportJSON(),
    )
    expect(json.theme).toBe(DEFAULT_MERMAID_THEME_MODE)
    expect(json.theme).toBe('app')
  })

  it('keeps rendering a version-3 node: every version-4 field resolves to a default', () => {
    const json = inEditor(() =>
      MermaidNode.importJSON({
        type: 'mermaid',
        version: 3,
        code: CODE,
        theme: 'default',
        viewMode: 'split',
        width: '50%',
        height: 300,
      } as SerializedMermaidNode).exportJSON(),
    )
    expect(json.fitMode).toBe('fitWidth')
    expect(json.maxHeight).toBeUndefined()
    expect(json.alignment).toBe('left')
    expect(json.background).toBe('transparent')
    expect(json.zoomPan).toBe(true)
    // And nothing it DID store was lost.
    expect(json.width).toBe('50%')
    expect(json.height).toBe(300)
    expect(json.theme).toBe('default')
  })
})

describe('MermaidNode — setters normalize too, so no path seats an unvalidated value', () => {
  it('setWidth drops an unparseable value instead of storing it', () => {
    const stored = inEditor(() => {
      const node = $createMermaidNode(CODE, 'default', 'split', '50%')
      node.setWidth('javascript:alert(1)')
      return node.getWidth()
    })
    expect(stored).toBeUndefined()
  })

  it('setWidth clamps a parseable but out-of-range value', () => {
    const stored = inEditor(() => {
      const node = $createMermaidNode(CODE)
      node.setWidth('900%')
      return node.getWidth()
    })
    expect(stored).toBe(`${MAX_MERMAID_WIDTH_PERCENT}%`)
  })

  it('setHeight clamps and setWidth(undefined) returns to fitting', () => {
    const result = inEditor(() => {
      const node = $createMermaidNode(CODE, 'default', 'split', '50%', 300)
      node.setHeight(99999)
      const clamped = node.getHeight()
      node.setWidth(undefined)
      node.setHeight(undefined)
      return { clamped, width: node.getWidth(), height: node.getHeight() }
    })
    expect(result.clamped).toBe(MAX_MERMAID_HEIGHT_PX)
    expect(result.width).toBeUndefined()
    expect(result.height).toBeUndefined()
  })

  it('clone() carries the size, so an edit elsewhere in the note does not reset it', () => {
    const cloned = inEditor(() => {
      const node = $createMermaidNode(CODE, 'neutral', 'preview', '420px', 300)
      const clone = MermaidNode.clone(node)
      return { width: clone.getWidth(), height: clone.getHeight(), theme: clone.getTheme() }
    })
    expect(cloned).toEqual({ width: '420px', height: 300, theme: 'neutral' })
  })
})
