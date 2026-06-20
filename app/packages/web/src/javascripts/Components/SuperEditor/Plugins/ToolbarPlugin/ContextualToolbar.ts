/**
 * Standard Red Notes — Feature #273: contextual toolbar groups for special
 * widgets.
 *
 * When the caret / selection is inside (or on) a "special widget" — a table, an
 * image, a link, a code block, or one of the decorator blocks (math / embed /
 * kanban / timeline / qr / etc.) — the toolbar grows an extra, dynamic group
 * with edit actions relevant to that widget (Word-style contextual ribbon tab).
 *
 * This module owns ONLY the pure mapping from an active Lexical node *type
 * string* (what `node.getType()` returns) to which contextual widget is active,
 * plus its human label. The actual button JSX + Lexical action wiring lives in
 * ToolbarPlugin.tsx (it closes over editor state). Keeping the mapping pure
 * makes it trivially unit-testable and decoupled from React/Lexical.
 *
 * NOTE: the decorator-block type strings below are the values returned by the
 * corresponding node classes' `static getType()` (e.g. MathNode -> 'math'). We
 * intentionally do NOT import those node classes here — the new-BLOCK-nodes
 * agent owns Lexical/Nodes/**; this is a string contract only, so adding a new
 * node type never forces a change here unless we want a tailored group for it.
 */

/** Stable kinds of contextual widget we render a tailored group for. */
export enum ContextualWidgetKind {
  Table = 'table',
  Image = 'image',
  Link = 'link',
  Code = 'code',
  /** A decorator/embedded block (math, embed, kanban, timeline, qr, …). */
  Block = 'block',
}

/**
 * Lexical `getType()` strings that identify each tailored widget kind.
 *
 * Tables/images/code/link are matched by their own dedicated detectors in
 * ToolbarPlugin (range vs. table selection, link ancestor, etc.); the type
 * strings here are used for the generic decorator-block bucket and to give the
 * contextual tab a precise label.
 */
export const IMAGE_NODE_TYPES = new Set<string>(['snfile', 'inline-file', 'unencrypted-image'])

export const CODE_NODE_TYPE = 'code'

export const LINK_NODE_TYPES = new Set<string>(['link', 'autolink'])

export const TABLE_NODE_TYPE = 'table'

/**
 * Decorator / embedded block type -> friendly label. Anything in here gets the
 * generic "block" contextual group (move up/down, delete, zoom). The label is
 * shown on the contextual tab so the user knows what they're acting on.
 */
export const DECORATOR_BLOCK_LABELS: Record<string, string> = {
  math: 'Math',
  'inline-math': 'Math',
  embed: 'Embed',
  'web-embed': 'Web Embed',
  youtube: 'Video',
  kanban: 'Kanban',
  timeline: 'Timeline',
  calendar: 'Calendar',
  datatable: 'Data Table',
  callout: 'Callout',
  'qr-code': 'QR Code',
  excalidraw: 'Drawing',
  mermaid: 'Diagram',
  'sql-query': 'SQL Query',
  'stock-chart': 'Stock Chart',
  tradingview: 'Trading View',
  'file-export': 'File Export',
  footnotes: 'Footnotes',
}

export type ContextualWidget = {
  kind: ContextualWidgetKind
  /** Label shown on the contextual ribbon tab (e.g. "Table", "Math"). */
  label: string
}

const KIND_LABELS: Record<ContextualWidgetKind, string> = {
  [ContextualWidgetKind.Table]: 'Table',
  [ContextualWidgetKind.Image]: 'Image',
  [ContextualWidgetKind.Link]: 'Link',
  [ContextualWidgetKind.Code]: 'Code Block',
  [ContextualWidgetKind.Block]: 'Block',
}

/**
 * Pure resolver: given the set of relevant active node-type strings (as flagged
 * by the Lexical detectors in ToolbarPlugin), decide which single contextual
 * widget — if any — should be shown.
 *
 * Precedence (most specific first): table > image > link > code > generic
 * decorator block. Only ONE contextual group is shown at a time, matching
 * Word's single active contextual tab.
 *
 * `activeBlockType` is the top-level block's `getType()` (used both for the
 * generic decorator-block bucket and to label it precisely).
 */
export function resolveContextualWidget(input: {
  isTable: boolean
  isImage: boolean
  isLink: boolean
  isCode: boolean
  activeBlockType: string | null
}): ContextualWidget | null {
  const { isTable, isImage, isLink, isCode, activeBlockType } = input

  if (isTable) {
    return { kind: ContextualWidgetKind.Table, label: KIND_LABELS[ContextualWidgetKind.Table] }
  }
  if (isImage) {
    return { kind: ContextualWidgetKind.Image, label: KIND_LABELS[ContextualWidgetKind.Image] }
  }
  if (isLink) {
    return { kind: ContextualWidgetKind.Link, label: KIND_LABELS[ContextualWidgetKind.Link] }
  }
  if (isCode) {
    return { kind: ContextualWidgetKind.Code, label: KIND_LABELS[ContextualWidgetKind.Code] }
  }
  if (activeBlockType && activeBlockType in DECORATOR_BLOCK_LABELS) {
    return { kind: ContextualWidgetKind.Block, label: DECORATOR_BLOCK_LABELS[activeBlockType] }
  }

  return null
}

/** Convenience predicates kept here so detection stays declarative + testable. */
export function isImageNodeType(type: string): boolean {
  return IMAGE_NODE_TYPES.has(type)
}

export function isLinkNodeType(type: string): boolean {
  return LINK_NODE_TYPES.has(type)
}

export function isDecoratorBlockType(type: string): boolean {
  return type in DECORATOR_BLOCK_LABELS
}
