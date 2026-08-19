import { createChecklistTodoId } from '@/Components/SuperEditor/Lexical/Nodes/ChecklistItemNode'
import {
  AssistantRichBlock,
  createAssistantMarkdownFragmentNodes,
  createAssistantRichFragmentNodes,
} from './assistantSuperNoteFragments'

export const MAX_ASSISTANT_SUPER_PATCH_OPERATIONS = 32
export const MAX_ASSISTANT_SUPER_PATCH_BYTES = 64 * 1024
export const MAX_ASSISTANT_STRUCTURE_BLOCKS = 100

type JsonObject = Record<string, unknown>

export type AssistantBlockLocator =
  | { nodeKey: string }
  | { nodeUuid: string }
  | { todoId: string }
  | { path: number[] }
  | { heading: { text: string; occurrence?: number } }

export type AssistantInsertableBlock =
  | { kind: 'paragraph'; text: string; marks?: number }
  | { kind: 'heading'; text: string; level?: number; marks?: number }
  | { kind: 'checklist-item'; text: string; checked?: boolean; marks?: number }
  | { kind: 'list-item'; text: string; marks?: number }
  | { kind: 'rich-fragment'; blocks: AssistantRichBlock[] }
  | { kind: 'markdown-fragment'; markdown: string }

type AssistantStructuralPatchOperationBody =
  | {
      type: 'insert'
      position: 'before' | 'after' | 'inside-section'
      target: AssistantBlockLocator
      block: AssistantInsertableBlock
    }
  | {
      type: 'replace-text'
      target: AssistantBlockLocator
      expectedText: string
      text: string
      marks?: number
    }
  | { type: 'toggle-checklist'; target: AssistantBlockLocator; checked: boolean }
  | {
      type: 'move'
      target: AssistantBlockLocator
      destination: { position: 'before' | 'after' | 'inside-section'; target: AssistantBlockLocator }
    }
  | { type: 'delete'; target: AssistantBlockLocator }
  | {
      type: 'update-attrs'
      target: AssistantBlockLocator
      attrs: {
        format?: string | number
        style?: string
        indent?: number
        direction?: 'ltr' | 'rtl' | null
        tag?: `h${1 | 2 | 3 | 4 | 5 | 6}`
        checked?: boolean
      }
    }

/**
 * A caller-provided operation id is carried through the detached patch and the
 * encrypted per-note audit ledger. It is intentionally optional at this layer
 * so older callers remain compatible; the assistant tool normalizes one before
 * any durable mutation.
 */
export type AssistantStructuralPatchOperation = AssistantStructuralPatchOperationBody & { operationId?: string }

export type AssistantStructuralEffectLocator = {
  /** Reload-stable structural fallback. */
  path: number[]
  /** Stable identifiers are included whenever the native node carries one. */
  todoId?: string
  nodeUuid?: string
  /** Best-effort live-editor key; never the only locator persisted. */
  nodeKey?: string
}

export type AssistantStructuralOperationEffect = {
  operationId?: string
  type: AssistantStructuralPatchOperation['type']
  summary: string
  affected: AssistantStructuralEffectLocator[]
  beforeFragment?: string
  afterFragment?: string
  truncated?: boolean
  deleted?: boolean
}

export type AssistantSuperRevision = {
  contentHash: string
  updatedAt?: string
}

export type AssistantSuperPatchRequest = {
  base: AssistantSuperRevision
  operations: AssistantStructuralPatchOperation[]
}

export type AssistantStructureBlock = {
  locator: AssistantBlockLocator
  path: number[]
  type: string
  text: string
  headingLevel?: number
  checked?: boolean
  todoId?: string
  inline?: AssistantStructureInlineRun[]
  list?: {
    listType: string
    start?: number
    tag?: string
    value?: number
  }
  attrs?: Record<string, unknown>
}

export type AssistantStructureInlineRun = {
  text: string
  format: number
  marks: string[]
  style?: string
  link?: string
}

export type AssistantStructureOutlineEntry = {
  locator: AssistantBlockLocator
  path: number[]
  text: string
  level: number
}

export type AssistantStructureRead = {
  revision: AssistantSuperRevision
  outline: AssistantStructureOutlineEntry[]
  blocks?: AssistantStructureBlock[]
  truncated: boolean
  supportedSchema: typeof ASSISTANT_SUPER_SUPPORTED_SCHEMA
}

export const ASSISTANT_SUPER_SUPPORTED_SCHEMA = {
  locatorKinds: ['nodeKey', 'nodeUuid', 'todoId', 'path', 'heading'] as const,
  insertKinds: ['paragraph', 'heading', 'checklist-item', 'list-item', 'rich-fragment', 'markdown-fragment'] as const,
  richBlockTypes: ['paragraph', 'heading', 'quote', 'code', 'list'] as const,
  richListTypes: ['bullet', 'number', 'check'] as const,
  inlineMarks: ['bold', 'italic', 'underline', 'strikethrough', 'code'] as const,
  markdownFragment: {
    parser: 'canonical-lexical-markdown',
    createsNativeNodes: true,
    rawHtmlExecution: false,
  } as const,
}

export type AssistantSuperPatchResult =
  | {
      ok: true
      status: 'applied'
      text: string
      revision: AssistantSuperRevision
      appliedOperations: number
      operationEffects: AssistantStructuralOperationEffect[]
    }
  | {
      ok: false
      status: 'conflict'
      reason: string
      currentRevision: AssistantSuperRevision
      rebase: { outline: AssistantStructureOutlineEntry[] }
    }
  | {
      ok: false
      status: 'ambiguous' | 'refused'
      reason: string
      candidates?: AssistantStructureBlock[]
    }

type NodeRecord = {
  node: JsonObject
  parent?: JsonObject
  parentChildren?: JsonObject[]
  index: number
  path: number[]
}

class AmbiguousLocatorError extends Error {
  constructor(
    message: string,
    readonly candidates: NodeRecord[],
  ) {
    super(message)
    this.name = 'AmbiguousLocatorError'
  }
}

class RefusedPatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefusedPatchError'
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodeChildren(node: JsonObject): JsonObject[] | undefined {
  if (!Array.isArray(node.children) || !node.children.every(isObject)) {
    return undefined
  }
  return node.children
}

function boundedString(value: unknown, max = 8_192): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function assertBoundedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new RefusedPatchError(`${label} must be a string of at most 16,384 characters.`)
  }
}

function textContent(node: JsonObject): string {
  if (node.type === 'text') {
    return typeof node.text === 'string' ? node.text : ''
  }
  const children = nodeChildren(node)
  return children ? children.map(textContent).join('') : ''
}

function nodeState(node: JsonObject): JsonObject | undefined {
  return isObject(node.$) ? node.$ : undefined
}

function todoId(node: JsonObject): string | undefined {
  return boundedString(nodeState(node)?.srnChecklistTodoId, 96)
}

function nodeIdentifier(node: JsonObject, kind: 'key' | 'uuid'): string | undefined {
  const state = nodeState(node)
  const candidates =
    kind === 'key'
      ? [node.key, node.nodeKey, state?.nodeKey]
      : [node.uuid, node.id, node.nodeUuid, state?.uuid, state?.nodeUuid]
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
}

function headingLevel(node: JsonObject): number | undefined {
  if (node.type !== 'heading' && node.type !== 'heading-styled') {
    return undefined
  }
  const match = typeof node.tag === 'string' ? /^h([1-6])$/.exec(node.tag) : undefined
  return match ? Number(match[1]) : 1
}

function collectRecords(root: JsonObject): NodeRecord[] {
  const records: NodeRecord[] = []
  const walk = (node: JsonObject, path: number[], parent?: JsonObject, parentChildren?: JsonObject[], index = 0) => {
    records.push({ node, parent, parentChildren, index, path })
    const children = nodeChildren(node)
    children?.forEach((child, childIndex) => walk(child, [...path, childIndex], node, children, childIndex))
  }
  walk(root, [])
  return records
}

function recordAtPath(root: JsonObject, path: readonly number[]): NodeRecord | undefined {
  let node = root
  let parent: JsonObject | undefined
  let parentChildren: JsonObject[] | undefined
  let index = 0
  if (path.length === 0) {
    return { node, index, path: [] }
  }
  for (const segment of path) {
    const children = nodeChildren(node)
    if (!children || !Number.isSafeInteger(segment) || segment < 0 || segment >= children.length) {
      return undefined
    }
    parent = node
    parentChildren = children
    index = segment
    node = children[segment]
  }
  return { node, parent, parentChildren, index, path: [...path] }
}

function sameNormalizedText(left: string, right: string): boolean {
  return left.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === right.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function resolveLocator(root: JsonObject, locator: AssistantBlockLocator): NodeRecord {
  if ('path' in locator) {
    const direct = recordAtPath(root, locator.path)
    if (!direct) {
      throw new RefusedPatchError(`No block exists at path ${locator.path.join('.') || 'root'}.`)
    }
    return direct
  }

  const records = collectRecords(root)
  let matches: NodeRecord[] = []
  if ('nodeKey' in locator) {
    matches = records.filter((record) => nodeIdentifier(record.node, 'key') === locator.nodeKey)
  } else if ('nodeUuid' in locator) {
    matches = records.filter((record) => nodeIdentifier(record.node, 'uuid') === locator.nodeUuid)
  } else if ('todoId' in locator) {
    matches = records.filter((record) => todoId(record.node) === locator.todoId)
  } else {
    const headings = records.filter(
      (record) =>
        headingLevel(record.node) !== undefined && sameNormalizedText(textContent(record.node), locator.heading.text),
    )
    const occurrence = locator.heading.occurrence
    if (occurrence !== undefined) {
      if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > headings.length) {
        throw new RefusedPatchError(`Heading occurrence ${String(occurrence)} does not exist.`)
      }
      matches = [headings[occurrence - 1]]
    } else {
      matches = headings
    }
  }

  if (matches.length === 0) {
    throw new RefusedPatchError('The requested block locator no longer matches this note.')
  }
  if (matches.length > 1) {
    throw new AmbiguousLocatorError('The requested block locator is ambiguous; choose an exact candidate.', matches)
  }
  return matches[0]
}

function locatorFor(record: NodeRecord): AssistantBlockLocator {
  const id = todoId(record.node)
  if (id) {
    return { todoId: id }
  }
  const uuid = nodeIdentifier(record.node, 'uuid')
  if (uuid) {
    return { nodeUuid: uuid }
  }
  const key = nodeIdentifier(record.node, 'key')
  if (key) {
    return { nodeKey: key }
  }
  return { path: record.path }
}

const MAX_ASSISTANT_EFFECT_RECORDS = 16
const MAX_ASSISTANT_EFFECT_FRAGMENT_CHARS = 2_048

/**
 * Display fragments are defense-in-depth only; full undo snapshots remain E2E
 * encrypted. Redact before any truncation so a cut inside an unterminated secret
 * cannot turn a formerly recognizable value into a leaked prefix.
 */
export function redactAssistantEffectFragmentText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)/gi, '[redacted private material]')
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]*/gi, '[redacted data URL]')
    .replace(/\bBearer\s+[^\s"',;}\\]+/gi, 'Bearer [redacted]')
    .replace(
      /("(?:password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)"\s*:\s*")((?:\\(?:.|$)|[^"\\\r\n])*)(?:"|$)/gi,
      (match, prefix: string, secret: string) =>
        `${prefix}[redacted]${match.length > prefix.length + secret.length ? '"' : ''}`,
    )
    .replace(
      /(\\"(?:password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\\"\s*:\s*\\")((?:\\\\.|[^"\\\r\n])*)(?:\\"|$)/gi,
      '$1[redacted]',
    )
    .replace(
      /((?:password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\s*[=:]\s*)(?!["'])[^\s,};&]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi, '[redacted token]')
}

const ASSISTANT_SECRET_FIELD =
  /^(?:password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)$/i

function redactAssistantEffectValue(value: unknown, key?: string): unknown {
  if (key && ASSISTANT_SECRET_FIELD.test(key)) {
    return '[redacted]'
  }
  if (typeof value === 'string') {
    return redactAssistantEffectFragmentText(value)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactAssistantEffectValue(entry))
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactAssistantEffectValue(entryValue, entryKey),
      ]),
    )
  }
  return value
}

function effectLocatorFor(record: NodeRecord): AssistantStructuralEffectLocator {
  const id = todoId(record.node)
  const uuid = nodeIdentifier(record.node, 'uuid')
  const key = nodeIdentifier(record.node, 'key')
  return {
    path: [...record.path],
    ...(id ? { todoId: id } : {}),
    ...(uuid ? { nodeUuid: uuid } : {}),
    ...(key ? { nodeKey: key } : {}),
  }
}

function userMeaningfulEffectRecords(records: NodeRecord[]): NodeRecord[] {
  const blocks = records.filter(
    (record) => record.path.length > 0 && record.node.type !== 'text' && record.node.type !== 'linebreak',
  )
  return (blocks.length > 0 ? blocks : records.filter((record) => record.path.length > 0)).slice(
    0,
    MAX_ASSISTANT_EFFECT_RECORDS,
  )
}

function boundedEffectFragment(records: NodeRecord[]): { value?: string; truncated: boolean } {
  if (records.length === 0) {
    return { truncated: false }
  }
  const fragment = records.length === 1 ? records[0].node : records.map((record) => record.node)
  const redacted = JSON.stringify(redactAssistantEffectValue(fragment))
  if (redacted.length <= MAX_ASSISTANT_EFFECT_FRAGMENT_CHARS) {
    return { value: redacted, truncated: false }
  }
  return {
    value: `${redacted.slice(0, MAX_ASSISTANT_EFFECT_FRAGMENT_CHARS)}…`,
    truncated: true,
  }
}

function operationSummary(operation: AssistantStructuralPatchOperation): string {
  switch (operation.type) {
    case 'insert':
      return `Inserted ${operation.block.kind} content ${operation.position}.`
    case 'replace-text':
      return 'Replaced text in one structural block.'
    case 'toggle-checklist':
      return operation.checked ? 'Marked one checklist item complete.' : 'Marked one checklist item incomplete.'
    case 'move':
      return `Moved one structural block ${operation.destination.position}.`
    case 'delete':
      return 'Deleted one structural block.'
    case 'update-attrs':
      return 'Updated formatting or attributes on one structural block.'
  }
}

/** Capture one bounded, display-oriented effect while preserving atomic patch semantics. */
function applyOperationWithEffect(
  root: JsonObject,
  operation: AssistantStructuralPatchOperation,
  idFactory: () => string,
): AssistantStructuralOperationEffect {
  const beforeRecords = collectRecords(root)
  const beforeNodeSet = new Set(beforeRecords.map((record) => record.node))
  const beforeTarget = resolveLocator(root, operation.target)
  const targetNode = beforeTarget.node
  const beforeAffected = operation.type === 'insert' ? [] : userMeaningfulEffectRecords([beforeTarget])
  const beforeFragment = boundedEffectFragment(beforeAffected)

  applyOperation(root, operation, idFactory)

  const afterRecords = collectRecords(root)
  let afterAffected: NodeRecord[]
  if (operation.type === 'insert') {
    afterAffected = userMeaningfulEffectRecords(afterRecords.filter((record) => !beforeNodeSet.has(record.node)))
  } else if (operation.type === 'delete') {
    afterAffected = []
  } else {
    afterAffected = userMeaningfulEffectRecords(afterRecords.filter((record) => record.node === targetNode))
  }
  const afterFragment = boundedEffectFragment(afterAffected)
  const locatorRecords = operation.type === 'delete' ? beforeAffected : afterAffected

  return {
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    type: operation.type,
    summary: operationSummary(operation),
    affected: locatorRecords.map(effectLocatorFor),
    ...(beforeFragment.value ? { beforeFragment: beforeFragment.value } : {}),
    ...(afterFragment.value ? { afterFragment: afterFragment.value } : {}),
    ...(operation.type === 'delete' ? { deleted: true } : {}),
    ...(beforeFragment.truncated ||
    afterFragment.truncated ||
    (operation.type === 'insert' &&
      afterRecords.filter((record) => !beforeNodeSet.has(record.node)).length > MAX_ASSISTANT_EFFECT_RECORDS)
      ? { truncated: true }
      : {}),
  }
}

function safeBlock(record: NodeRecord): AssistantStructureBlock {
  const node = record.node
  const level = headingLevel(node)
  const id = todoId(node)
  const attrs: Record<string, unknown> = {}
  for (const key of ['format', 'style', 'indent', 'direction', 'tag'] as const) {
    if (typeof node[key] === 'string' || typeof node[key] === 'number' || node[key] === null) {
      attrs[key] = node[key]
    }
  }
  const listParent = record.parent?.type === 'list' ? record.parent : undefined
  return {
    locator: locatorFor(record),
    path: record.path,
    type: typeof node.type === 'string' ? node.type : 'unknown',
    text: textContent(node).slice(0, 4_096),
    ...(level ? { headingLevel: level } : {}),
    ...(typeof node.checked === 'boolean' ? { checked: node.checked } : {}),
    ...(id ? { todoId: id } : {}),
    ...(inlineRuns(record.node).length > 0 ? { inline: inlineRuns(record.node) } : {}),
    ...(listParent && typeof listParent.listType === 'string'
      ? {
          list: {
            listType: listParent.listType,
            ...(typeof listParent.start === 'number' ? { start: listParent.start } : {}),
            ...(typeof listParent.tag === 'string' ? { tag: listParent.tag } : {}),
            ...(typeof node.value === 'number' ? { value: node.value } : {}),
          },
        }
      : {}),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
  }
}

function inlineMarks(format: number): string[] {
  const marks: string[] = []
  if (format & 1) marks.push('bold')
  if (format & 2) marks.push('italic')
  if (format & 4) marks.push('strikethrough')
  if (format & 8) marks.push('underline')
  if (format & 16) marks.push('code')
  return marks
}

function inlineRuns(node: JsonObject): AssistantStructureInlineRun[] {
  const runs: AssistantStructureInlineRun[] = []
  const visit = (candidate: JsonObject, activeLink?: string) => {
    const link =
      candidate.type === 'link' && typeof candidate.url === 'string' ? candidate.url.slice(0, 2_048) : activeLink
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      const format =
        typeof candidate.format === 'number' && Number.isSafeInteger(candidate.format) ? candidate.format : 0
      runs.push({
        text: candidate.text.slice(0, 4_096),
        format,
        marks: inlineMarks(format),
        ...(typeof candidate.style === 'string' && candidate.style ? { style: candidate.style.slice(0, 2_048) } : {}),
        ...(link ? { link } : {}),
      })
      return
    }
    for (const child of nodeChildren(candidate) ?? []) {
      visit(child, link)
    }
  }
  visit(node)
  return runs.slice(0, 256)
}

function outlineFor(root: JsonObject): AssistantStructureOutlineEntry[] {
  return collectRecords(root)
    .filter((record) => headingLevel(record.node) !== undefined)
    .map((record) => ({
      locator: locatorFor(record),
      path: record.path,
      text: textContent(record.node).slice(0, 1_024),
      level: headingLevel(record.node) as number,
    }))
}

function parseSuperText(text: string): { document: JsonObject; root: JsonObject } {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw new RefusedPatchError('The Super note contains invalid serialized editor data.')
  }
  if (!isObject(document) || !isObject(document.root) || !nodeChildren(document.root)) {
    throw new RefusedPatchError('The Super note has an unsupported serialized editor shape.')
  }
  return { document, root: document.root }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashAssistantSuperNote(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return `sha256:${toHex(new Uint8Array(digest))}`
}

export async function assistantSuperRevision(text: string, updatedAt?: string): Promise<AssistantSuperRevision> {
  return { contentHash: await hashAssistantSuperNote(text), ...(updatedAt ? { updatedAt } : {}) }
}

function sectionTopLevelRange(
  root: JsonObject,
  heading: NodeRecord,
): { start: number; end: number; children: JsonObject[] } {
  const children = nodeChildren(root) as JsonObject[]
  if (heading.parent !== root || heading.path.length !== 1) {
    throw new RefusedPatchError('Section locators must resolve to a top-level heading.')
  }
  const level = headingLevel(heading.node)
  if (!level) {
    throw new RefusedPatchError('The inside-section target must be a heading.')
  }
  let end = children.length
  for (let index = heading.index + 1; index < children.length; index += 1) {
    const candidateLevel = headingLevel(children[index])
    if (candidateLevel && candidateLevel <= level) {
      end = index
      break
    }
  }
  return { start: heading.index + 1, end, children }
}

function textNode(text: string, marks = 0): JsonObject {
  if (!Number.isSafeInteger(marks) || marks < 0) {
    throw new RefusedPatchError('Text marks must be a non-negative integer.')
  }
  return { detail: 0, format: marks, mode: 'normal', style: '', text, type: 'text', version: 1 }
}

function checklistItem(text: string, checked: boolean, marks: number, idFactory: () => string): JsonObject {
  return {
    $: { srnChecklistTodoId: idFactory() },
    checked,
    children: [textNode(text, marks)],
    direction: null,
    format: '',
    indent: 0,
    type: 'listitem',
    value: 1,
    version: 1,
  }
}

function plainListItem(text: string, marks: number): JsonObject {
  return {
    children: [textNode(text, marks)],
    direction: null,
    format: '',
    indent: 0,
    type: 'listitem',
    value: 1,
    version: 1,
  }
}

function makeBlock(
  block: Exclude<AssistantInsertableBlock, { kind: 'rich-fragment' | 'markdown-fragment' }>,
  idFactory: () => string,
): JsonObject {
  assertBoundedText(block.text, 'Inserted block text')
  const marks = block.marks ?? 0
  if (block.kind === 'checklist-item') {
    return checklistItem(block.text, block.checked === true, marks, idFactory)
  }
  if (block.kind === 'list-item') {
    return plainListItem(block.text, marks)
  }
  if (block.kind === 'heading') {
    const level = block.level ?? 2
    if (!Number.isSafeInteger(level) || level < 1 || level > 6) {
      throw new RefusedPatchError('Heading level must be between 1 and 6.')
    }
    return {
      children: [textNode(block.text, marks)],
      direction: null,
      format: '',
      indent: 0,
      tag: `h${level}`,
      type: 'heading',
      version: 1,
    }
  }
  return {
    children: [textNode(block.text, marks)],
    direction: null,
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  }
}

function materializeBlocks(block: AssistantInsertableBlock, idFactory: () => string): JsonObject[] {
  if (block.kind === 'markdown-fragment') {
    return createAssistantMarkdownFragmentNodes(block.markdown, idFactory)
  }
  if (block.kind === 'rich-fragment') {
    return createAssistantRichFragmentNodes(block.blocks, idFactory)
  }
  return [makeBlock(block, idFactory)]
}

function makeList(kind: 'check' | 'bullet', item: JsonObject): JsonObject {
  return {
    children: [item],
    direction: null,
    format: '',
    indent: 0,
    listType: kind,
    start: 1,
    tag: 'ul',
    type: 'list',
    version: 1,
  }
}

function isListItemIn(record: NodeRecord, kind?: 'check' | 'bullet'): boolean {
  return (
    record.node.type === 'listitem' &&
    record.parent?.type === 'list' &&
    (kind === undefined || record.parent.listType === kind)
  )
}

function insertInsideSection(
  root: JsonObject,
  target: NodeRecord,
  block: AssistantInsertableBlock,
  idFactory: () => string,
): void {
  const section = sectionTopLevelRange(root, target)
  if (block.kind === 'markdown-fragment' || block.kind === 'rich-fragment') {
    section.children.splice(section.end, 0, ...materializeBlocks(block, idFactory))
    return
  }
  if (block.kind === 'checklist-item' || block.kind === 'list-item') {
    const listKind = block.kind === 'checklist-item' ? 'check' : 'bullet'
    for (let index = section.end - 1; index >= section.start; index -= 1) {
      const candidate = section.children[index]
      if (candidate.type === 'list' && candidate.listType === listKind) {
        const children = nodeChildren(candidate)
        if (!children) {
          throw new RefusedPatchError('The target list has invalid children.')
        }
        children.push(makeBlock(block, idFactory))
        return
      }
    }
    section.children.splice(section.end, 0, makeList(listKind, makeBlock(block, idFactory)))
    return
  }
  section.children.splice(section.end, 0, makeBlock(block, idFactory))
}

function insertRelative(
  target: NodeRecord,
  position: 'before' | 'after',
  block: AssistantInsertableBlock,
  idFactory: () => string,
) {
  if (!target.parentChildren) {
    throw new RefusedPatchError('The document root cannot be inserted beside.')
  }
  if (block.kind === 'markdown-fragment' || block.kind === 'rich-fragment') {
    const nodes = materializeBlocks(block, idFactory)
    if (isListItemIn(target)) {
      const list = nodes.length === 1 && nodes[0].type === 'list' ? nodes[0] : undefined
      const importedItems = list && list.listType === target.parent?.listType ? nodeChildren(list) : undefined
      if (!importedItems) {
        throw new RefusedPatchError(
          'A rich fragment inserted beside a list item must contain one compatible native list.',
        )
      }
      target.parentChildren.splice(target.index + (position === 'after' ? 1 : 0), 0, ...importedItems)
      return
    }
    target.parentChildren.splice(target.index + (position === 'after' ? 1 : 0), 0, ...nodes)
    return
  }
  if (isListItemIn(target)) {
    const expectedKind = target.parent?.listType === 'check' ? 'checklist-item' : 'list-item'
    if (block.kind !== expectedKind) {
      throw new RefusedPatchError(`Only a ${expectedKind} can be inserted beside this list item.`)
    }
  } else if (block.kind === 'checklist-item' || block.kind === 'list-item') {
    const listKind = block.kind === 'checklist-item' ? 'check' : 'bullet'
    target.parentChildren.splice(
      target.index + (position === 'after' ? 1 : 0),
      0,
      makeList(listKind, makeBlock(block, idFactory)),
    )
    return
  }
  target.parentChildren.splice(target.index + (position === 'after' ? 1 : 0), 0, makeBlock(block, idFactory))
}

function replaceText(record: NodeRecord, expectedText: string, replacement: string, marks?: number): void {
  assertBoundedText(expectedText, 'Expected text')
  assertBoundedText(replacement, 'Replacement text')
  if (!expectedText) {
    throw new RefusedPatchError('replace-text requires non-empty expectedText.')
  }
  const leaves = collectRecords(record.node).filter(
    (candidate) => candidate.node.type === 'text' && typeof candidate.node.text === 'string',
  )
  const candidates = leaves.filter((candidate) => {
    const value = candidate.node.text as string
    return value === expectedText || value.split(expectedText).length === 2
  })
  if (candidates.length !== 1) {
    throw new RefusedPatchError(
      candidates.length === 0
        ? 'Expected text was not found within one formatted text leaf; use a narrower locator.'
        : 'Expected text occurs in more than one formatted text leaf; use a narrower locator.',
    )
  }
  const leaf = candidates[0].node
  leaf.text = (leaf.text as string).replace(expectedText, replacement)
  if (marks !== undefined) {
    if (!Number.isSafeInteger(marks) || marks < 0) {
      throw new RefusedPatchError('Text marks must be a non-negative integer.')
    }
    leaf.format = marks
  }
}

function removeRecord(record: NodeRecord): JsonObject {
  if (!record.parentChildren) {
    throw new RefusedPatchError('The document root cannot be moved or deleted.')
  }
  return record.parentChildren.splice(record.index, 1)[0]
}

function insertExistingInsideSection(root: JsonObject, heading: NodeRecord, moved: JsonObject): void {
  const section = sectionTopLevelRange(root, heading)
  if (moved.type === 'listitem') {
    const sourceKind = typeof moved.checked === 'boolean' || todoId(moved) ? 'check' : 'bullet'
    for (let index = section.end - 1; index >= section.start; index -= 1) {
      const list = section.children[index]
      if (list.type === 'list' && list.listType === sourceKind) {
        nodeChildren(list)?.push(moved)
        return
      }
    }
    section.children.splice(section.end, 0, makeList(sourceKind, moved))
    return
  }
  section.children.splice(section.end, 0, moved)
}

function applyOperation(root: JsonObject, operation: AssistantStructuralPatchOperation, idFactory: () => string): void {
  if (operation.type === 'insert') {
    const target = resolveLocator(root, operation.target)
    if (operation.position === 'inside-section') {
      insertInsideSection(root, target, operation.block, idFactory)
    } else {
      insertRelative(target, operation.position, operation.block, idFactory)
    }
    return
  }
  if (operation.type === 'replace-text') {
    replaceText(resolveLocator(root, operation.target), operation.expectedText, operation.text, operation.marks)
    return
  }
  if (operation.type === 'toggle-checklist') {
    const target = resolveLocator(root, operation.target)
    if (!isListItemIn(target, 'check')) {
      throw new RefusedPatchError('toggle-checklist requires an exact checklist item locator.')
    }
    target.node.checked = operation.checked
    return
  }
  if (operation.type === 'update-attrs') {
    const target = resolveLocator(root, operation.target)
    const attrs = operation.attrs
    if (
      !isObject(attrs) ||
      Object.keys(attrs).some((key) => !['format', 'style', 'indent', 'direction', 'tag', 'checked'].includes(key))
    ) {
      throw new RefusedPatchError('update-attrs contains an unsupported attribute.')
    }
    if (attrs.style !== undefined && (typeof attrs.style !== 'string' || attrs.style.length > 2_048)) {
      throw new RefusedPatchError('Block style must be a bounded string.')
    }
    if (attrs.indent !== undefined && (!Number.isSafeInteger(attrs.indent) || attrs.indent < 0 || attrs.indent > 20)) {
      throw new RefusedPatchError('Block indent must be an integer between 0 and 20.')
    }
    if (attrs.checked !== undefined && !isListItemIn(target, 'check')) {
      throw new RefusedPatchError('checked can only be updated on a checklist item.')
    }
    Object.assign(target.node, attrs)
    return
  }
  if (operation.type === 'delete') {
    removeRecord(resolveLocator(root, operation.target))
    return
  }

  const source = resolveLocator(root, operation.target)
  const sourceNode = source.node
  const destinationLocator = operation.destination.target
  const destinationWasInsideSource =
    'path' in destinationLocator &&
    destinationLocator.path.length > source.path.length &&
    source.path.every((segment, index) => destinationLocator.path[index] === segment)
  if (destinationWasInsideSource) {
    throw new RefusedPatchError('A block cannot be moved inside itself.')
  }
  removeRecord(source)
  const destination = resolveLocator(root, operation.destination.target)
  if (operation.destination.position === 'inside-section') {
    insertExistingInsideSection(root, destination, sourceNode)
  } else {
    if (!destination.parentChildren) {
      throw new RefusedPatchError('The document root cannot be a move destination.')
    }
    if (sourceNode.type === 'listitem' && destination.node.type !== 'listitem') {
      throw new RefusedPatchError('A list item can only move beside another list item or inside a section.')
    }
    destination.parentChildren.splice(
      destination.index + (operation.destination.position === 'after' ? 1 : 0),
      0,
      sourceNode,
    )
  }
}

function candidateBlocks(records: NodeRecord[]): AssistantStructureBlock[] {
  return records.slice(0, 10).map(safeBlock)
}

export async function readAssistantSuperStructure(
  text: string,
  options: {
    view: 'outline' | 'section' | 'blocks'
    section?: AssistantBlockLocator
    limit?: number
    updatedAt?: string
  },
): Promise<AssistantStructureRead> {
  const { root } = parseSuperText(text)
  const revision = await assistantSuperRevision(text, options.updatedAt)
  const outline = outlineFor(root)
  if (options.view === 'outline') {
    return { revision, outline, truncated: false, supportedSchema: ASSISTANT_SUPER_SUPPORTED_SCHEMA }
  }
  const limit = Math.min(
    MAX_ASSISTANT_STRUCTURE_BLOCKS,
    Math.max(1, Number.isSafeInteger(options.limit) ? (options.limit as number) : 50),
  )
  let records: NodeRecord[]
  if (options.view === 'section') {
    if (!options.section) {
      throw new RefusedPatchError('A section locator is required for a section read.')
    }
    const heading = resolveLocator(root, options.section)
    const range = sectionTopLevelRange(root, heading)
    const allowedTopLevel = new Set(range.children.slice(heading.index, range.end))
    records = collectRecords(root).filter(
      (record) =>
        record.path.length > 0 && allowedTopLevel.has(recordAtPath(root, [record.path[0]])?.node as JsonObject),
    )
  } else {
    records = collectRecords(root).filter((record) => record.path.length > 0)
  }
  // Return user-meaningful blocks, not every text leaf, keeping reads bounded.
  records = records.filter(
    (record) =>
      record.node.type !== 'text' &&
      record.node.type !== 'linebreak' &&
      (record.node.type !== 'list' || nodeChildren(record.node)?.length === 0),
  )
  return {
    revision,
    outline,
    blocks: records.slice(0, limit).map(safeBlock),
    truncated: records.length > limit,
    supportedSchema: ASSISTANT_SUPER_SUPPORTED_SCHEMA,
  }
}

export async function applyAssistantSuperPatch(
  text: string,
  request: AssistantSuperPatchRequest,
  options: { updatedAt?: string; createTodoId?: () => string } = {},
): Promise<AssistantSuperPatchResult> {
  const currentRevision = await assistantSuperRevision(text, options.updatedAt)
  let parsed: { document: JsonObject; root: JsonObject }
  try {
    parsed = parseSuperText(text)
  } catch (error) {
    return { ok: false, status: 'refused', reason: (error as Error).message }
  }
  if (
    request.base.contentHash !== currentRevision.contentHash ||
    (request.base.updatedAt !== undefined && request.base.updatedAt !== currentRevision.updatedAt)
  ) {
    return {
      ok: false,
      status: 'conflict',
      reason:
        'The note changed after the assistant read its structure. Re-read the affected section and rebase the patch.',
      currentRevision,
      rebase: { outline: outlineFor(parsed.root) },
    }
  }
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    return { ok: false, status: 'refused', reason: 'At least one structural patch operation is required.' }
  }
  if (request.operations.length > MAX_ASSISTANT_SUPER_PATCH_OPERATIONS) {
    return {
      ok: false,
      status: 'refused',
      reason: `A structural patch may contain at most ${MAX_ASSISTANT_SUPER_PATCH_OPERATIONS} operations.`,
    }
  }
  if (new TextEncoder().encode(JSON.stringify(request.operations)).byteLength > MAX_ASSISTANT_SUPER_PATCH_BYTES) {
    return {
      ok: false,
      status: 'refused',
      reason: `A structural patch may contain at most ${MAX_ASSISTANT_SUPER_PATCH_BYTES} UTF-8 bytes.`,
    }
  }

  // Work on a detached JSON tree. Either every operation succeeds or the caller
  // receives a refusal/ambiguity and the original serialized note stays exact.
  const document = JSON.parse(JSON.stringify(parsed.document)) as JsonObject
  const root = document.root as JsonObject
  const idFactory = options.createTodoId ?? (() => createChecklistTodoId())
  const operationEffects: AssistantStructuralOperationEffect[] = []
  try {
    request.operations.forEach((operation) =>
      operationEffects.push(applyOperationWithEffect(root, operation, idFactory)),
    )
  } catch (error) {
    if (error instanceof AmbiguousLocatorError) {
      return {
        ok: false,
        status: 'ambiguous',
        reason: error.message,
        candidates: candidateBlocks(error.candidates),
      }
    }
    return {
      ok: false,
      status: 'refused',
      reason: error instanceof Error ? error.message : 'The structural patch was refused.',
    }
  }

  const patchedText = JSON.stringify(document)
  return {
    ok: true,
    status: 'applied',
    text: patchedText,
    revision: await assistantSuperRevision(patchedText, options.updatedAt),
    appliedOperations: request.operations.length,
    operationEffects,
  }
}
