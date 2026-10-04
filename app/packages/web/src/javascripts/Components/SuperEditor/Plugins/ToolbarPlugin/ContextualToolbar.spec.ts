/**
 * Unit tests for the pure contextual-widget resolver (Feature #273).
 *
 * Covers the active-node-type -> contextual-group mapping in isolation from any
 * React/Lexical rendering: precedence, the generic decorator-block bucket, and
 * the "plain paragraph => no contextual group" case.
 */
import {
  resolveContextualWidget,
  ContextualWidgetKind,
  isImageNodeType,
  isLinkNodeType,
  isDecoratorBlockType,
} from './ContextualToolbar'

const base = {
  isTable: false,
  isImage: false,
  isLink: false,
  isCode: false,
  activeBlockType: null as string | null,
}

describe('resolveContextualWidget', () => {
  it('returns null for a plain paragraph (no special widget active)', () => {
    expect(resolveContextualWidget({ ...base, activeBlockType: 'paragraph' })).toBeNull()
    expect(resolveContextualWidget({ ...base, activeBlockType: null })).toBeNull()
  })

  it('detects a table', () => {
    const result = resolveContextualWidget({ ...base, isTable: true })
    expect(result?.kind).toBe(ContextualWidgetKind.Table)
    expect(result?.label).toBe('Table')
  })

  it('detects an image', () => {
    expect(resolveContextualWidget({ ...base, isImage: true })?.kind).toBe(ContextualWidgetKind.Image)
  })

  it('detects a link', () => {
    expect(resolveContextualWidget({ ...base, isLink: true })?.kind).toBe(ContextualWidgetKind.Link)
  })

  it('detects a code block', () => {
    const result = resolveContextualWidget({ ...base, isCode: true })
    expect(result?.kind).toBe(ContextualWidgetKind.Code)
    expect(result?.label).toBe('Code Block')
  })

  it('detects a decorator block by its type string and labels it', () => {
    const result = resolveContextualWidget({ ...base, activeBlockType: 'math' })
    expect(result?.kind).toBe(ContextualWidgetKind.Block)
    expect(result?.label).toBe('Math')

    expect(resolveContextualWidget({ ...base, activeBlockType: 'kanban' })?.label).toBe('Kanban')
    expect(resolveContextualWidget({ ...base, activeBlockType: 'qr-code' })?.label).toBe('QR Code')
  })

  it('applies precedence table > image > link > code > block', () => {
    // Everything flagged at once: the most specific (table) wins.
    expect(
      resolveContextualWidget({
        isTable: true,
        isImage: true,
        isLink: true,
        isCode: true,
        activeBlockType: 'math',
      })?.kind,
    ).toBe(ContextualWidgetKind.Table)

    // Without table, image wins, then link, then code, then block.
    expect(resolveContextualWidget({ ...base, isImage: true, isLink: true })?.kind).toBe(ContextualWidgetKind.Image)
    expect(resolveContextualWidget({ ...base, isLink: true, isCode: true })?.kind).toBe(ContextualWidgetKind.Link)
    expect(resolveContextualWidget({ ...base, isCode: true, activeBlockType: 'math' })?.kind).toBe(
      ContextualWidgetKind.Code,
    )
  })

  /**
   * Standard Red Notes (t118) — a mermaid diagram gets its OWN section rather than
   * the generic decorator-block bucket, which offered only move/delete/zoom.
   */
  it('detects a mermaid diagram as its own kind, not the generic block bucket', () => {
    const byType = resolveContextualWidget({ ...base, activeBlockType: 'mermaid' })
    expect(byType?.kind).toBe(ContextualWidgetKind.Mermaid)
    expect(byType?.label).toBe('Mermaid')

    // And by the explicit flag, which is how a NODE selection reaches it (a
    // decorator block is normally selected as a node selection, where the
    // toolbar's own block-type detection never runs).
    const byFlag = resolveContextualWidget({ ...base, isMermaid: true })
    expect(byFlag?.kind).toBe(ContextualWidgetKind.Mermaid)
  })

  it('puts the mermaid section behind Table, so a diagram in a cell still edits the table', () => {
    expect(resolveContextualWidget({ ...base, isTable: true, isMermaid: true })?.kind).toBe(ContextualWidgetKind.Table)
  })

  it('puts the mermaid section ahead of image, link, code and the block bucket', () => {
    for (const other of [{ isImage: true }, { isLink: true }, { isCode: true }, { activeBlockType: 'math' }]) {
      expect(resolveContextualWidget({ ...base, ...other, isMermaid: true })?.kind).toBe(ContextualWidgetKind.Mermaid)
    }
  })

  it('still labels mermaid in the decorator-block table, for the active-block label', () => {
    // The generic label map keeps its mermaid entry: it no longer decides the
    // contextual kind, but ToolbarPlugin still reads it for "zoom into <label>".
    expect(isDecoratorBlockType('mermaid')).toBe(true)
  })
})

describe('node-type predicates', () => {
  it('recognizes image node types', () => {
    expect(isImageNodeType('snfile')).toBe(true)
    expect(isImageNodeType('unencrypted-image')).toBe(true)
    expect(isImageNodeType('paragraph')).toBe(false)
  })

  it('recognizes link node types', () => {
    expect(isLinkNodeType('link')).toBe(true)
    expect(isLinkNodeType('autolink')).toBe(true)
    expect(isLinkNodeType('text')).toBe(false)
  })

  it('recognizes decorator block types', () => {
    expect(isDecoratorBlockType('math')).toBe(true)
    expect(isDecoratorBlockType('timeline')).toBe(true)
    expect(isDecoratorBlockType('paragraph')).toBe(false)
  })
})
