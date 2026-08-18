import { createHeadlessEditor } from '@lexical/headless'
import { $convertFromMarkdownString } from '@lexical/markdown'
import { $getRoot } from 'lexical'
import { BlockEditorNodes } from '@/Components/SuperEditor/Lexical/Nodes/AllNodes'
import BlocksEditorTheme from '@/Components/SuperEditor/Lexical/Theme/Theme'
import { sanitizeUrl } from '@/Components/SuperEditor/Lexical/Utils/sanitizeUrl'
import { MarkdownTransformers } from '@/Components/SuperEditor/MarkdownTransformers'

type JsonObject = Record<string, unknown>

export type AssistantInlineMark = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code'

export type AssistantRichInline = {
  text: string
  marks?: AssistantInlineMark[]
  style?: string
  link?: string
}

export type AssistantRichList = {
  listType: 'bullet' | 'number' | 'check'
  start?: number
  items: AssistantRichListItem[]
}

export type AssistantRichListItem = {
  content: AssistantRichInline[]
  checked?: boolean
  children?: AssistantRichList
}

export type AssistantRichBlock =
  | {
      type: 'paragraph' | 'quote'
      content: AssistantRichInline[]
      format?: string
      indent?: number
      direction?: 'ltr' | 'rtl' | null
    }
  | {
      type: 'heading'
      level: 1 | 2 | 3 | 4 | 5 | 6
      content: AssistantRichInline[]
      format?: string
      indent?: number
      direction?: 'ltr' | 'rtl' | null
    }
  | { type: 'code'; text: string; language?: string }
  | ({ type: 'list' } & AssistantRichList)

const ALLOWED_MARKDOWN_NODE_TYPES = new Set([
  'root',
  'paragraph',
  'paragraph-styled',
  'heading',
  'heading-styled',
  'quote',
  'quote-styled',
  'code',
  'list',
  'listitem',
  'text',
  'link',
  'linebreak',
])

const MARK_FORMAT: Record<AssistantInlineMark, number> = {
  bold: 1,
  italic: 2,
  strikethrough: 4,
  underline: 8,
  code: 16,
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function childrenOf(node: JsonObject): JsonObject[] {
  if (!Array.isArray(node.children) || !node.children.every(isObject)) {
    return []
  }
  return node.children
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new Error(`${label} must be a string of at most 16,384 characters.`)
  }
}

function safeInlineStyle(value: unknown): string {
  if (value === undefined || value === '') {
    return ''
  }
  if (
    typeof value !== 'string' ||
    value.length > 2_048 ||
    /(?:url\s*\(|expression\s*\(|@import|behavior\s*:|javascript\s*:|[<>])/iu.test(value)
  ) {
    throw new Error('Inline style contains unsupported or unsafe CSS.')
  }
  return value
}

function inlineFormat(marks: unknown): number {
  if (marks === undefined) {
    return 0
  }
  if (!Array.isArray(marks) || marks.some((mark) => typeof mark !== 'string' || !(mark in MARK_FORMAT))) {
    throw new Error('Inline marks must use bold, italic, underline, strikethrough, or code.')
  }
  return marks.reduce((format, mark) => format | MARK_FORMAT[mark as AssistantInlineMark], 0)
}

function textNode(run: AssistantRichInline): JsonObject {
  assertText(run.text, 'Inline text')
  return {
    detail: 0,
    format: inlineFormat(run.marks),
    mode: 'normal',
    style: safeInlineStyle(run.style),
    text: run.text,
    type: 'text',
    version: 1,
  }
}

function inlineNodes(content: AssistantRichInline[]): JsonObject[] {
  if (!Array.isArray(content) || content.length === 0 || content.length > 256) {
    throw new Error('Rich block content must contain between 1 and 256 inline runs.')
  }
  return content.map((run) => {
    if (!isObject(run)) {
      throw new Error('Every rich inline run must be an object.')
    }
    const text = textNode(run)
    if (run.link === undefined) {
      return text
    }
    assertText(run.link, 'Inline link URL')
    return {
      children: [text],
      direction: null,
      format: '',
      indent: 0,
      rel: null,
      target: null,
      title: null,
      type: 'link',
      url: sanitizeUrl(run.link),
      version: 1,
    }
  })
}

function validateBlockLayout(block: { format?: unknown; indent?: unknown; direction?: unknown }): {
  format: string
  indent: number
  direction: 'ltr' | 'rtl' | null
} {
  if (block.format !== undefined && (typeof block.format !== 'string' || block.format.length > 128)) {
    throw new Error('Block format must be a bounded string.')
  }
  if (
    block.indent !== undefined &&
    (!Number.isSafeInteger(block.indent) || Number(block.indent) < 0 || Number(block.indent) > 20)
  ) {
    throw new Error('Block indent must be an integer between 0 and 20.')
  }
  if (
    block.direction !== undefined &&
    block.direction !== null &&
    block.direction !== 'ltr' &&
    block.direction !== 'rtl'
  ) {
    throw new Error('Block direction must be ltr, rtl, or null.')
  }
  return {
    format: typeof block.format === 'string' ? block.format : '',
    indent: typeof block.indent === 'number' ? block.indent : 0,
    direction: block.direction === 'ltr' || block.direction === 'rtl' ? block.direction : null,
  }
}

function richListNode(list: AssistantRichList, createTodoId: () => string, depth = 0): JsonObject {
  if (depth > 8) {
    throw new Error('Rich lists may be nested at most 8 levels.')
  }
  if (!isObject(list) || !['bullet', 'number', 'check'].includes(list.listType)) {
    throw new Error('Rich listType must be bullet, number, or check.')
  }
  if (!Array.isArray(list.items) || list.items.length === 0 || list.items.length > 100) {
    throw new Error('Rich lists must contain between 1 and 100 items.')
  }
  const start = list.start ?? 1
  if (!Number.isSafeInteger(start) || start < 1 || start > 1_000_000) {
    throw new Error('Rich list start must be a positive integer.')
  }
  const children = list.items.map((item, index) => {
    if (!isObject(item)) {
      throw new Error('Every rich list item must be an object.')
    }
    const content = inlineNodes(item.content)
    const nested = item.children ? richListNode(item.children, createTodoId, depth + 1) : undefined
    const checklist = list.listType === 'check'
    return {
      ...(checklist ? { $: { srnChecklistTodoId: createTodoId() }, checked: item.checked === true } : {}),
      children: [...content, ...(nested ? [nested] : [])],
      direction: null,
      format: '',
      indent: depth,
      type: 'listitem',
      value: start + index,
      version: 1,
    }
  })
  return {
    children,
    direction: null,
    format: '',
    indent: depth,
    listType: list.listType,
    start,
    tag: list.listType === 'number' ? 'ol' : 'ul',
    type: 'list',
    version: 1,
  }
}

export function createAssistantRichFragmentNodes(
  blocks: AssistantRichBlock[],
  createTodoId: () => string,
): JsonObject[] {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 100) {
    throw new Error('A rich fragment must contain between 1 and 100 blocks.')
  }
  return blocks.map((block) => {
    if (!isObject(block) || typeof block.type !== 'string') {
      throw new Error('Every rich fragment block must be an object with a supported type.')
    }
    if (block.type === 'list') {
      return richListNode(block as AssistantRichList, createTodoId)
    }
    if (block.type === 'code') {
      assertText(block.text, 'Code block text')
      if (block.language !== undefined && (typeof block.language !== 'string' || block.language.length > 64)) {
        throw new Error('Code language must be a bounded string.')
      }
      return {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: block.text,
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        language: block.language ?? null,
        type: 'code',
        version: 1,
      }
    }
    if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'quote') {
      throw new Error(`Unsupported rich block type: ${block.type}.`)
    }
    const layout = validateBlockLayout(block)
    if (block.type === 'heading' && (!Number.isSafeInteger(block.level) || block.level < 1 || block.level > 6)) {
      throw new Error('Rich heading level must be between 1 and 6.')
    }
    return {
      children: inlineNodes(block.content),
      direction: layout.direction,
      format: layout.format,
      indent: layout.indent,
      ...(block.type === 'heading' ? { tag: `h${block.level}` } : {}),
      type: block.type,
      version: 1,
    }
  })
}

function sanitizeImportedNode(node: JsonObject, parentListType: unknown, createTodoId: () => string): void {
  if (typeof node.type !== 'string' || !ALLOWED_MARKDOWN_NODE_TYPES.has(node.type)) {
    throw new Error(`Markdown fragment produced unsupported node type: ${String(node.type)}.`)
  }
  if (node.type === 'link') {
    if (typeof node.url !== 'string') {
      throw new Error('Markdown link is missing a URL.')
    }
    node.url = sanitizeUrl(node.url)
    node.target = null
    node.rel = null
  }
  if (node.type === 'text') {
    assertText(node.text, 'Imported Markdown text')
    node.style = safeInlineStyle(node.style)
  }
  const children = childrenOf(node)
  if (node.type === 'listitem' && parentListType === 'check') {
    const hasOwnContent = children.length === 0 || children.some((child) => child.type !== 'list')
    if (hasOwnContent) {
      node.$ = { ...(isObject(node.$) ? node.$ : {}), srnChecklistTodoId: createTodoId() }
    }
  }
  for (const child of children) {
    sanitizeImportedNode(child, node.type === 'list' ? node.listType : parentListType, createTodoId)
  }
}

/** Parse a canonical Markdown fragment through the same Lexical importer as Super notes. */
export function createAssistantMarkdownFragmentNodes(markdown: string, createTodoId: () => string): JsonObject[] {
  assertText(markdown, 'Markdown fragment')
  if (!markdown.trim()) {
    throw new Error('Markdown fragment cannot be empty.')
  }
  let lexicalError: Error | undefined
  const editor = createHeadlessEditor({
    namespace: 'AssistantSuperFragment',
    theme: BlocksEditorTheme,
    editable: false,
    nodes: BlockEditorNodes,
    onError: (error) => {
      lexicalError = error
    },
  })
  editor.update(
    () => {
      $getRoot().clear()
      $convertFromMarkdownString(markdown, MarkdownTransformers, undefined, true)
    },
    { discrete: true },
  )
  if (lexicalError) {
    throw lexicalError
  }
  const document = editor.getEditorState().toJSON() as unknown as JsonObject
  const root = isObject(document.root) ? document.root : undefined
  if (!root) {
    throw new Error('Markdown importer returned an invalid document.')
  }
  const nodes = childrenOf(root).map((node) => JSON.parse(JSON.stringify(node)) as JsonObject)
  if (nodes.length === 0 || nodes.length > 100) {
    throw new Error('Markdown fragment must produce between 1 and 100 blocks.')
  }
  for (const node of nodes) {
    sanitizeImportedNode(node, undefined, createTodoId)
  }
  return nodes
}
