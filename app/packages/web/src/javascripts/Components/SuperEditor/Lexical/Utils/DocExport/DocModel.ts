/**
 * Shared intermediate document model for structured note export.
 *
 * Both the DOCX (`DocxGenerator`) and ODT (`OdtGenerator`) generators consume the
 * SAME `DocBlock[]` produced here by a single structured walk of the Lexical/Super
 * tree — no HTML string round-trip. This is the single source of truth for what a
 * note "is" when exported to a word-processor format.
 *
 * FIDELITY RULE — nothing is ever silently dropped. Every recognised block/inline
 * maps to a first-class model node; anything unrecognised falls back to its
 * `getTextContent()` (as a paragraph, or a code block for code-ish source nodes),
 * and unknown *container* nodes are recursed so their children survive. The
 * supported set mirrors the export mapping table in `.orchestration/plans/t46.md`.
 *
 * `superStringToDocModel()` is self-contained: it builds its own headless export
 * editor (`SuperExportNodes`) and replicates HeadlessSuperConverter's snfile→
 * inline/export file-node rewrite so embed behaviour (inline base64 / separate /
 * reference) is honoured identically — it does NOT reach into that class.
 */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  ElementNode,
  LexicalNode,
} from 'lexical'
import { PrefKey, PrefValue, FileItem } from '@standardnotes/snjs'
import { $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import { $isListNode, $isListItemNode, ListNode, ListItemNode } from '@lexical/list'
import { $isCodeNode } from '@lexical/code'
import { $isLinkNode } from '@lexical/link'
import { $isTableNode, $isTableRowNode, $isTableCellNode } from '@lexical/table'
import { $isHorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { $dfs } from '@lexical/utils'
import BlocksEditorTheme from '../../Theme/Theme'
import { SuperExportNodes } from '../../Nodes/AllNodes'
import { $isInlineFileNode, $createInlineFileNode } from '../../../Plugins/InlineFilePlugin/InlineFileNode'
import { $isRemoteImageNode } from '../../../Plugins/RemoteImagePlugin/RemoteImageNode'
import { $createFileExportNode } from '../../Nodes/FileExportNode'
import { $isFileNode } from '../../../Plugins/EncryptedFilePlugin/Nodes/FileUtils'
import { parseFileName } from '@standardnotes/utils'
import { $getChecklistDueAt, $isChecklistItemNode } from '../../Nodes/ChecklistItemNode'
import { checklistDueExportText } from '../../../Checklist/checklistDueDate'

/* ---------------------------------------------------------------- model types */

export type Align = 'left' | 'center' | 'right' | 'justify'

/** Normalised block-level styling derived from a styled node's inline CSS (t40). */
export interface BlockStyle {
  fontSizePt?: number
  bold?: boolean
  italic?: boolean
  /** 6-hex, no leading '#'. */
  color?: string
  spaceBeforeTwips?: number
  spaceAfterTwips?: number
}

export type Inline =
  | {
      kind: 'text'
      text: string
      bold?: boolean
      italic?: boolean
      underline?: boolean
      strike?: boolean
      code?: boolean
      sub?: boolean
      sup?: boolean
      /** 6-hex, no '#'. */
      color?: string
      /** 6-hex, no '#'. */
      bgColor?: string
    }
  | { kind: 'link'; url: string; children: Inline[] }
  | { kind: 'image'; dataB64?: string; mime?: string; src?: string; alt?: string }
  | { kind: 'lineBreak' }

export interface ListItemModel {
  inlines: Inline[]
  checked?: boolean
  children?: ListModel
}

export interface ListModel {
  ordered: boolean
  check: boolean
  items: ListItemModel[]
}

export type DocBlock =
  | { kind: 'paragraph'; style?: BlockStyle; align?: Align; indent?: number; inlines: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; align?: Align; style?: BlockStyle; inlines: Inline[] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'list'; list: ListModel }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'table'; rows: DocBlock[][][] }
  | { kind: 'image'; dataB64?: string; mime?: string; src?: string; alt?: string }
  | { kind: 'hr' }
  | { kind: 'pageBreak' }

export interface DocModelConfig {
  embedBehavior?: PrefValue[PrefKey.SuperNoteExportEmbedBehavior]
  getFileItem?: (id: string) => FileItem | undefined
  getFileBase64?: (id: string) => Promise<string | undefined>
  /** Stable clock snapshot shared by every due-date projection in this document. */
  now?: number
}

/* ------------------------------------------------------------- css utilities */

const parseCssDeclarations = (style: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!style) {
    return out
  }
  for (const declaration of style.split(';')) {
    const idx = declaration.indexOf(':')
    if (idx === -1) {
      continue
    }
    const property = declaration.slice(0, idx).trim().toLowerCase()
    const value = declaration.slice(idx + 1).trim()
    if (property && value) {
      out[property] = value
    }
  }
  return out
}

/** Normalise a CSS colour to 6-hex WITHOUT '#', or undefined if not representable. */
export const normalizeHexColor = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined
  }
  const v = value.trim().toLowerCase()
  const hexMatch = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hexMatch) {
    const hex = hexMatch[1]
    const full = hex.length === 3 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex
    return full.toUpperCase()
  }
  const rgbMatch = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    const toHex = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10)))
        .toString(16)
        .padStart(2, '0')
    return (toHex(rgbMatch[1]) + toHex(rgbMatch[2]) + toHex(rgbMatch[3])).toUpperCase()
  }
  return undefined
}

/** Best-effort CSS length → points (px/pt/em/rem/%; base 16px = 12pt). */
const cssLengthToPt = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined
  }
  const m = value.trim().match(/^(-?\d*\.?\d+)\s*(px|pt|em|rem|%)?$/)
  if (!m) {
    return undefined
  }
  const n = parseFloat(m[1])
  if (!isFinite(n)) {
    return undefined
  }
  switch (m[2]) {
    case 'pt':
      return n
    case 'em':
    case 'rem':
      return n * 12
    case '%':
      return (n / 100) * 12
    case 'px':
    default:
      return n * 0.75
  }
}

/** CSS length → twips (1pt = 20 twips). */
const cssLengthToTwips = (value: string | undefined): number | undefined => {
  const pt = cssLengthToPt(value)
  return pt == null ? undefined : Math.round(pt * 20)
}

const deriveBlockStyle = (styleString: string | undefined): BlockStyle | undefined => {
  const decl = parseCssDeclarations(styleString)
  if (Object.keys(decl).length === 0) {
    return undefined
  }
  const style: BlockStyle = {}
  const fontSizePt = cssLengthToPt(decl['font-size'])
  if (fontSizePt != null) {
    style.fontSizePt = fontSizePt
  }
  const weight = decl['font-weight']
  if (weight === 'bold' || weight === 'bolder' || (/^\d+$/.test(weight || '') && parseInt(weight, 10) >= 600)) {
    style.bold = true
  }
  if (decl['font-style'] === 'italic' || decl['font-style'] === 'oblique') {
    style.italic = true
  }
  const color = normalizeHexColor(decl['color'])
  if (color) {
    style.color = color
  }
  const before = cssLengthToTwips(decl['margin-top'])
  if (before != null) {
    style.spaceBeforeTwips = before
  }
  const after = cssLengthToTwips(decl['margin-bottom'])
  if (after != null) {
    style.spaceAfterTwips = after
  }
  return Object.keys(style).length > 0 ? style : undefined
}

const readAlign = (node: ElementNode): Align | undefined => {
  const format = node.getFormatType()
  switch (format) {
    case 'center':
      return 'center'
    case 'right':
    case 'end':
      return 'right'
    case 'justify':
      return 'justify'
    case 'left':
    case 'start':
      return 'left'
    default:
      return undefined
  }
}

/* --------------------------------------------------------------- inline walk */

/**
 * Bound the structured export walk the same way the IMPORT side is bounded
 * (`DocImport/OdtConverter.ts` MAX_WALK_DEPTH). A hostile or broken Super note
 * with tens of thousands of nested lists/containers would otherwise overflow the
 * JS stack during the recursive walk. Because the walk runs on a plain array of
 * `DocBlock`/`Inline`, exceeding the cap TRUNCATES (we stop descending) rather
 * than throwing — the output degrades gracefully. Far deeper than any real doc.
 */
const MAX_WALK_DEPTH = 200

/**
 * Serialized Lexical node (as produced by `EditorState.toJSON`): an opaque record
 * that MAY carry a `children` array of nested serialized nodes. Used only by the
 * pre-load depth prune below.
 */
interface SerializedNodeLike {
  children?: unknown[]
  [key: string]: unknown
}

/**
 * Deepest serialized-tree level the export walk can ever emit from. A list chain
 * costs the walk two tree levels (ListNode → ListItemNode) per `MAX_WALK_DEPTH`
 * step — the walk's steepest descent — so `2 * MAX_WALK_DEPTH` bounds every node
 * the walk actually reads; the small margin absorbs the root/off-by-one.
 */
const PRUNE_TREE_DEPTH = MAX_WALK_DEPTH * 2 + 2

/**
 * Truncate a serialized editor-state tree so nothing is nested deeper than the
 * walk can emit from, BEFORE it is loaded via `parseEditorState`/`setEditorState`.
 *
 * WHY (this is the actual stack-overflow fix, not the walk's own depth guards):
 * `setEditorState`'s commit unconditionally computes the whole tree's text content
 * — Lexical's `triggerTextContentListeners` → `getEditorStateTextContent` →
 * `$getRoot().getTextContent()` — an UNBOUNDED recursion, independent of our walk.
 * On a pathologically deep note that overflows the JS stack at LOAD time, before
 * the depth-bounded walk (which truncates at `MAX_WALK_DEPTH`) ever runs. Dropping
 * descendants the walk would discard anyway makes the load itself safe and leaves
 * every real note (nesting far below the cap) byte-for-byte unchanged. It also
 * bounds the walk's own final-fallback `getTextContent()` on a deep UNKNOWN
 * container. The prune is ITERATIVE (an explicit stack) so it cannot itself
 * overflow on the very input it defends against.
 */
const pruneSerializedDepth = (state: unknown): unknown => {
  const root = (state as { root?: SerializedNodeLike } | null | undefined)?.root
  if (!root || !Array.isArray(root.children)) {
    return state
  }
  const stack: Array<{ node: SerializedNodeLike; depth: number }> = [{ node: root, depth: 0 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: SerializedNodeLike; depth: number }
    const children = node.children
    if (!Array.isArray(children)) {
      continue
    }
    if (depth >= PRUNE_TREE_DEPTH) {
      // Past the deepest level the walk emits from: drop the subtree so the
      // load-time full-tree getTextContent stays shallow. A container truncated
      // here degrades exactly as the walk's own MAX_WALK_DEPTH guard would.
      node.children = []
      continue
    }
    for (const child of children) {
      if (child && typeof child === 'object') {
        stack.push({ node: child as SerializedNodeLike, depth: depth + 1 })
      }
    }
  }
  return state
}

/**
 * Cap on the decoded byte length of a single embedded (base64 data-URI) image.
 * A note can embed an arbitrarily large base64 image; both generators decode
 * `dataB64` into a `Uint8Array` of exactly that size (`base64ToBytes`), so an
 * unbounded image means an unbounded allocation / OOM on export. Past the cap the
 * image is DROPPED and its alt text is emitted as a plain text inline instead.
 */
const MAX_EMBEDDED_IMAGE_BYTES = 32 * 1024 * 1024

const CODE_ISH_TYPES = new Set(['mermaid', 'sql-query', 'math', 'inline-math', 'gantt-chart', 'timing-diagram'])

const textInline = (node: LexicalNode): Inline => {
  // node is a TextNode here (guarded by caller)
  const textNode = node as unknown as {
    getTextContent: () => string
    hasFormat: (f: string) => boolean
    getStyle: () => string
  }
  const decl = parseCssDeclarations(textNode.getStyle())
  const inline: Extract<Inline, { kind: 'text' }> = {
    kind: 'text',
    text: textNode.getTextContent(),
  }
  if (textNode.hasFormat('bold')) {
    inline.bold = true
  }
  if (textNode.hasFormat('italic')) {
    inline.italic = true
  }
  if (textNode.hasFormat('underline')) {
    inline.underline = true
  }
  if (textNode.hasFormat('strikethrough')) {
    inline.strike = true
  }
  if (textNode.hasFormat('code')) {
    inline.code = true
  }
  if (textNode.hasFormat('subscript')) {
    inline.sub = true
  }
  if (textNode.hasFormat('superscript')) {
    inline.sup = true
  }
  const color = normalizeHexColor(decl['color'])
  if (color) {
    inline.color = color
  }
  const bg = normalizeHexColor(decl['background-color'])
  if (bg) {
    inline.bgColor = bg
  }
  return inline
}

/**
 * Turn a data-URI (or plain URL) `src` into an image inline. Base64 data-URIs are
 * size-capped at the single choke point through which both generators receive
 * `dataB64`: the decoded length is estimated (≈ 3/4 of the base64 length) and, past
 * `MAX_EMBEDDED_IMAGE_BYTES`, the image is dropped and its alt text returned as a
 * plain text inline — bounding both DOCX and ODT at once. Remote (URL-only) images
 * carry no `dataB64`, so they are never decoded here and pass through unbounded.
 */
const dataUriToImageInline = (src: string, alt?: string): Inline => {
  const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (m && m[2]) {
    const b64 = m[3]
    if (Math.floor((b64.length * 3) / 4) > MAX_EMBEDDED_IMAGE_BYTES) {
      return { kind: 'text', text: alt ? `[${alt}]` : '[image]' }
    }
    return { kind: 'image', mime: m[1] || 'image/png', dataB64: b64, alt }
  }
  return { kind: 'image', src, alt }
}

/** Turn a single (possibly inline) node into zero or more Inline items. */
const nodeToInlines = (node: LexicalNode, depth = 0): Inline[] => {
  if ($isTextNode(node)) {
    const text = node.getTextContent()
    return text.length > 0 ? [textInline(node)] : []
  }
  if ($isLineBreakNode(node)) {
    return [{ kind: 'lineBreak' }]
  }
  if ($isLinkNode(node)) {
    return [{ kind: 'link', url: node.getURL(), children: collectInlines(node, depth) }]
  }
  if ($isInlineFileNode(node)) {
    const src = (node as unknown as { __src: string }).__src
    const mime = (node as unknown as { __mimeType: string }).__mimeType
    const name = (node as unknown as { __fileName?: string }).__fileName
    if (mime.startsWith('image/')) {
      return [dataUriToImageInline(src, name)]
    }
    return [{ kind: 'text', text: name ? `[${name}]` : '[file]' }]
  }
  if ($isRemoteImageNode(node)) {
    const src = (node as unknown as { __src: string }).__src
    const alt = (node as unknown as { __alt?: string }).__alt
    return [{ kind: 'image', src, alt }]
  }
  if ($isElementNode(node)) {
    // Mark / Hashtag / Overflow and other inline containers: flatten their children.
    return collectInlines(node, depth)
  }
  const text = node.getTextContent()
  return text.length > 0 ? [{ kind: 'text', text }] : []
}

const collectInlines = (element: ElementNode, depth = 0): Inline[] => {
  if (depth >= MAX_WALK_DEPTH) {
    return []
  }
  const inlines: Inline[] = []
  for (const child of element.getChildren()) {
    inlines.push(...nodeToInlines(child, depth + 1))
  }
  return inlines
}

/* ----------------------------------------------------------------- list walk */

const listNodeToModel = (listNode: ListNode, now: number, depth = 0): ListModel => {
  const listType = listNode.getListType()
  const model: ListModel = {
    ordered: listType === 'number',
    check: listType === 'check',
    items: [],
  }
  // Truncate a pathologically deep list nest instead of overflowing the stack.
  if (depth >= MAX_WALK_DEPTH) {
    return model
  }
  for (const child of listNode.getChildren()) {
    if (!$isListItemNode(child)) {
      continue
    }
    const item = child as ListItemNode
    const inlines: Inline[] = []
    let sublist: ListModel | undefined
    for (const grandChild of item.getChildren()) {
      if ($isListNode(grandChild)) {
        sublist = listNodeToModel(grandChild, now, depth + 1)
      } else {
        inlines.push(...nodeToInlines(grandChild, depth))
      }
    }
    const checked = item.getChecked()
    const dueAt = $isChecklistItemNode(item) ? $getChecklistDueAt(item) : undefined
    if (dueAt) {
      const dueText = checklistDueExportText(dueAt, Boolean(checked), now)
      if (dueText) {
        inlines.push({ kind: 'text', text: ` - ${dueText}`, italic: true })
      }
    }
    const itemModel: ListItemModel = { inlines }
    if (checked != null) {
      itemModel.checked = checked
    }
    if (sublist) {
      itemModel.children = sublist
    }
    model.items.push(itemModel)
  }
  return model
}

/* ---------------------------------------------------------------- block walk */

const headingLevel = (tag: string): 1 | 2 | 3 | 4 | 5 | 6 => {
  const n = parseInt(tag.replace(/[^0-9]/g, ''), 10)
  if (n >= 1 && n <= 6) {
    return n as 1 | 2 | 3 | 4 | 5 | 6
  }
  return 1
}

/** Turn a top-level (block) node into zero or more DocBlocks. Never drops content. */
const nodeToBlocks = (node: LexicalNode, now: number, depth = 0): DocBlock[] => {
  if ($isHeadingNode(node)) {
    return [
      {
        kind: 'heading',
        level: headingLevel(node.getTag()),
        align: readAlign(node),
        style: deriveBlockStyle(node.getStyle()),
        inlines: collectInlines(node, depth),
      },
    ]
  }
  if ($isQuoteNode(node)) {
    return [{ kind: 'quote', inlines: collectInlines(node, depth) }]
  }
  if ($isListNode(node)) {
    return [{ kind: 'list', list: listNodeToModel(node, now, depth) }]
  }
  if ($isCodeNode(node)) {
    return [
      {
        kind: 'code',
        language: node.getLanguage() ?? undefined,
        text: node.getTextContent(),
      },
    ]
  }
  if ($isTableNode(node)) {
    const rows: DocBlock[][][] = []
    for (const rowNode of node.getChildren()) {
      if (!$isTableRowNode(rowNode)) {
        continue
      }
      const row: DocBlock[][] = []
      for (const cellNode of (rowNode as ElementNode).getChildren()) {
        if (!$isTableCellNode(cellNode)) {
          continue
        }
        row.push(buildBlocksFromChildren((cellNode as ElementNode).getChildren(), now, depth + 1))
      }
      rows.push(row)
    }
    return [{ kind: 'table', rows }]
  }
  if ($isHorizontalRuleNode(node)) {
    return [{ kind: 'hr' }]
  }
  if (node.getType() === 'page-break') {
    return [{ kind: 'pageBreak' }]
  }
  if ($isInlineFileNode(node)) {
    const src = (node as unknown as { __src: string }).__src
    const mime = (node as unknown as { __mimeType: string }).__mimeType
    const name = (node as unknown as { __fileName?: string }).__fileName
    if (mime.startsWith('image/')) {
      const img = dataUriToImageInline(src, name)
      // Oversized data-URI images are dropped by the choke point above, which returns
      // a text inline instead — emit that as a paragraph rather than an image block.
      if (img.kind === 'image') {
        return [{ kind: 'image', dataB64: img.dataB64, mime: img.mime, src: img.src, alt: img.alt }]
      }
      return [{ kind: 'paragraph', inlines: [img] }]
    }
    return [{ kind: 'paragraph', inlines: [{ kind: 'text', text: name ? `[${name}]` : '[file]' }] }]
  }
  if ($isRemoteImageNode(node)) {
    const src = (node as unknown as { __src: string }).__src
    const alt = (node as unknown as { __alt?: string }).__alt
    return [{ kind: 'image', src, alt }]
  }
  if (node.getType() === 'file-export') {
    // A "separate"-embed file: reference it by (zippable) filename.
    const name = (node as unknown as { __name: string }).__name
    return [{ kind: 'paragraph', inlines: [{ kind: 'text', text: name }] }]
  }
  if ($isParagraphNode(node)) {
    return [
      {
        kind: 'paragraph',
        style: deriveBlockStyle(node.getStyle()),
        align: readAlign(node),
        indent: node.getIndent() || undefined,
        inlines: collectInlines(node, depth),
      },
    ]
  }

  // Code-ish exotic leaf nodes (mermaid / sql / math / diagrams): keep their
  // source as a code block so nothing is lost.
  if (CODE_ISH_TYPES.has(node.getType())) {
    return [{ kind: 'code', text: node.getTextContent() }]
  }

  // Unknown CONTAINER node (callout / collapsible / etc.): recurse children so
  // their structured content survives.
  if ($isElementNode(node) && node.getChildrenSize() > 0) {
    const nested = buildBlocksFromChildren(node.getChildren(), now, depth + 1)
    if (nested.length > 0) {
      return nested
    }
  }

  // Final fallback — never drop: emit the node's text as a paragraph.
  const text = node.getTextContent()
  return [{ kind: 'paragraph', inlines: [{ kind: 'text', text }] }]
}

const buildBlocksFromChildren = (children: LexicalNode[], now: number, depth = 0): DocBlock[] => {
  if (depth >= MAX_WALK_DEPTH) {
    return []
  }
  const blocks: DocBlock[] = []
  for (const child of children) {
    blocks.push(...nodeToBlocks(child, now, depth))
  }
  return blocks
}

/* ----------------------------------------------------- public entry: super → model */

const createExportEditor = () =>
  createHeadlessEditor({
    namespace: 'BlocksEditor',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (error: Error) => console.error(error),
    nodes: SuperExportNodes,
  })

/**
 * Replicate HeadlessSuperConverter's file-node rewrite so embed behaviour is
 * honoured identically before the walk. Mutates the editor in-place.
 */
const rewriteFileNodes = async (
  editor: ReturnType<typeof createExportEditor>,
  config: DocModelConfig,
): Promise<void> => {
  const embedBehavior = config.embedBehavior ?? 'reference'
  const { getFileItem, getFileBase64 } = config
  if (embedBehavior === 'reference' || !getFileItem) {
    return
  }
  const filenameCounts: Record<string, number> = {}
  const tasks: Promise<void>[] = []
  editor.getEditorState().read(() => {
    for (const { node: fileNode } of $dfs()) {
      if (!$isFileNode(fileNode)) {
        continue
      }
      const id = fileNode.getId()
      const fileItem = getFileItem(id)
      if (!fileItem) {
        continue
      }
      tasks.push(
        (async () => {
          if (embedBehavior === 'inline' && getFileBase64) {
            const base64 = await getFileBase64(id)
            if (!base64) {
              return
            }
            editor.update(
              () => {
                const target = $getNodeByKey(fileNode.getKey())
                if (target && $isFileNode(target)) {
                  target.replace($createInlineFileNode(base64, fileItem.mimeType, fileItem.name))
                }
              },
              { discrete: true },
            )
          } else {
            editor.update(
              () => {
                const target = $getNodeByKey(fileNode.getKey())
                if (!target || !$isFileNode(target)) {
                  return
                }
                filenameCounts[fileItem.name] =
                  filenameCounts[fileItem.name] == undefined ? 0 : filenameCounts[fileItem.name] + 1
                let name = fileItem.name
                if (filenameCounts[name] > 0) {
                  const { name: base, ext } = parseFileName(name)
                  name = `${base}-${fileItem.uuid}.${ext}`
                }
                target.replace($createFileExportNode(name, fileItem.mimeType))
              },
              { discrete: true },
            )
          }
        })(),
      )
    }
  })
  await Promise.all(tasks)
}

/**
 * Parse a Super (Lexical) note string and produce the shared DocModel by walking
 * the tree. Honours embed behaviour via `config` exactly as the other export
 * formats do.
 */
export const superStringToDocModel = async (superString: string, config: DocModelConfig = {}): Promise<DocBlock[]> => {
  if (!superString || superString.length === 0) {
    return []
  }
  const editor = createExportEditor()
  const exportNow = config.now ?? Date.now()
  // Prune pathological nesting BEFORE loading: setEditorState's commit walks the
  // whole tree's text content (Lexical-internal, unbounded), so a deep note would
  // overflow the stack here — before our depth-bounded walk runs. See
  // `pruneSerializedDepth`. Parsing the string to an object first is safe
  // (JSON.parse is iterative) and `parseEditorState` accepts the object directly.
  const serialized = pruneSerializedDepth(JSON.parse(superString))
  editor.setEditorState(editor.parseEditorState(serialized as Parameters<typeof editor.parseEditorState>[0]))
  await rewriteFileNodes(editor, config)
  return editor.getEditorState().read(() => buildBlocksFromChildren($getRoot().getChildren(), exportNow))
}

/**
 * Trivial DocModel for a plain / markdown (non-Super) note: one paragraph per
 * line, so these notes also produce a real .docx/.odt instead of falling back to
 * a text blob.
 */
export const buildPlainTextDocModel = (text: string): DocBlock[] => {
  const lines = text.split(/\r?\n/)
  return lines.map((line) => ({
    kind: 'paragraph',
    inlines: line.length > 0 ? [{ kind: 'text', text: line }] : [],
  }))
}
