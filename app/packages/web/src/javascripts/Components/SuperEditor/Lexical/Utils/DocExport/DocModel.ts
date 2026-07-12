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

const dataUriToImageInline = (src: string, alt?: string): Extract<Inline, { kind: 'image' }> => {
  const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (m && m[2]) {
    return { kind: 'image', mime: m[1] || 'image/png', dataB64: m[3], alt }
  }
  return { kind: 'image', src, alt }
}

/** Turn a single (possibly inline) node into zero or more Inline items. */
const nodeToInlines = (node: LexicalNode): Inline[] => {
  if ($isTextNode(node)) {
    const text = node.getTextContent()
    return text.length > 0 ? [textInline(node)] : []
  }
  if ($isLineBreakNode(node)) {
    return [{ kind: 'lineBreak' }]
  }
  if ($isLinkNode(node)) {
    return [{ kind: 'link', url: node.getURL(), children: collectInlines(node) }]
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
    return collectInlines(node)
  }
  const text = node.getTextContent()
  return text.length > 0 ? [{ kind: 'text', text }] : []
}

const collectInlines = (element: ElementNode): Inline[] => {
  const inlines: Inline[] = []
  for (const child of element.getChildren()) {
    inlines.push(...nodeToInlines(child))
  }
  return inlines
}

/* ----------------------------------------------------------------- list walk */

const listNodeToModel = (listNode: ListNode): ListModel => {
  const listType = listNode.getListType()
  const model: ListModel = {
    ordered: listType === 'number',
    check: listType === 'check',
    items: [],
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
        sublist = listNodeToModel(grandChild)
      } else {
        inlines.push(...nodeToInlines(grandChild))
      }
    }
    const checked = item.getChecked()
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
const nodeToBlocks = (node: LexicalNode): DocBlock[] => {
  if ($isHeadingNode(node)) {
    return [
      {
        kind: 'heading',
        level: headingLevel(node.getTag()),
        align: readAlign(node),
        style: deriveBlockStyle(node.getStyle()),
        inlines: collectInlines(node),
      },
    ]
  }
  if ($isQuoteNode(node)) {
    return [{ kind: 'quote', inlines: collectInlines(node) }]
  }
  if ($isListNode(node)) {
    return [{ kind: 'list', list: listNodeToModel(node) }]
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
        row.push(buildBlocksFromChildren((cellNode as ElementNode).getChildren()))
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
      return [{ kind: 'image', dataB64: img.dataB64, mime: img.mime, src: img.src, alt: img.alt }]
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
        inlines: collectInlines(node),
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
    const nested = buildBlocksFromChildren(node.getChildren())
    if (nested.length > 0) {
      return nested
    }
  }

  // Final fallback — never drop: emit the node's text as a paragraph.
  const text = node.getTextContent()
  return [{ kind: 'paragraph', inlines: [{ kind: 'text', text }] }]
}

const buildBlocksFromChildren = (children: LexicalNode[]): DocBlock[] => {
  const blocks: DocBlock[] = []
  for (const child of children) {
    blocks.push(...nodeToBlocks(child))
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
  editor.setEditorState(editor.parseEditorState(superString))
  await rewriteFileNodes(editor, config)
  return editor.getEditorState().read(() => buildBlocksFromChildren($getRoot().getChildren()))
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
