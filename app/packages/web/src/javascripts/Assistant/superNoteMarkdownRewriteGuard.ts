/**
 * Whole-note Super edits round-trip through Markdown. Fail closed unless every
 * serialized node is in the small subset that our Markdown transformers can
 * reproduce without silently discarding structure or NodeState.
 */

export type SuperNoteMarkdownRewriteRejectionCode =
  | 'invalid-json'
  | 'invalid-document'
  | 'unsupported-node'
  | 'checklist-not-portable'
  | 'node-state-not-portable'
  | 'property-not-portable'
  | 'document-too-complex'

export type SuperNoteMarkdownRewriteValidation =
  { ok: true } | { ok: false; code: SuperNoteMarkdownRewriteRejectionCode; path: string; reason: string }

export type SuperNoteMarkdownRewriteRejection = Extract<SuperNoteMarkdownRewriteValidation, { ok: false }>

export class UnsafeSuperNoteMarkdownRewriteError extends Error {
  constructor(readonly rejection: SuperNoteMarkdownRewriteRejection) {
    super(rejection.reason)
    this.name = 'UnsafeSuperNoteMarkdownRewriteError'
  }
}

type JsonNode = Record<string, unknown>

const MAX_NODES = 50_000
const MAX_DEPTH = 128
const BASE = ['type', 'version', '$']
const ELEMENT = [...BASE, 'children', 'direction', 'format', 'indent', 'textFormat', 'textStyle', 'style']
const KEYS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    root: ELEMENT,
    paragraph: ELEMENT,
    'paragraph-styled': ELEMENT,
    heading: [...ELEMENT, 'tag'],
    'heading-styled': [...ELEMENT, 'tag'],
    quote: ELEMENT,
    'quote-styled': ELEMENT,
    list: [...ELEMENT, 'listType', 'start', 'tag'],
    listitem: [...ELEMENT, 'value', 'checked'],
    table: ELEMENT,
    tablerow: ELEMENT,
    tablecell: [...ELEMENT, 'colSpan', 'rowSpan', 'headerState', 'backgroundColor', 'width'],
    code: [...ELEMENT, 'language', 'theme'],
    link: [...ELEMENT, 'url', 'rel', 'target', 'title'],
    text: [...BASE, 'detail', 'format', 'mode', 'style', 'text'],
    'code-highlight': [...BASE, 'detail', 'format', 'highlightType', 'mode', 'style', 'text'],
    linebreak: BASE,
    'unencrypted-image': [...BASE, 'alt', 'float', 'format', 'src'],
    mermaid: [...BASE, 'code', 'theme', 'viewMode'],
  }).map(([type, keys]) => [type, new Set(keys)]),
)

const TEXT_FORMAT_MASK = 1 | 2 | 4 | 16 | 128

const reject = (
  code: SuperNoteMarkdownRewriteRejectionCode,
  path: string,
  reason: string,
): SuperNoteMarkdownRewriteRejection => ({ ok: false, code, path, reason })

const objectNode = (value: unknown): value is JsonNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validatePortableProperties(node: JsonNode, path: string): SuperNoteMarkdownRewriteRejection | undefined {
  const type = node.type as string
  const isTextNode = type === 'text' || type === 'code-highlight'
  const allowed = KEYS[type]
  if (!allowed) {
    return reject('unsupported-node', path, `The Super note contains a “${type}” block that Markdown cannot preserve.`)
  }
  const extra = Object.keys(node).find((key) => !allowed.has(key))
  if (extra) {
    return reject(
      'property-not-portable',
      `${path}.${extra}`,
      `The “${extra}” property on ${type} cannot be preserved by a Markdown rewrite.`,
    )
  }
  if (objectNode(node.$) && Object.keys(node.$).length > 0) {
    return reject(
      'node-state-not-portable',
      `${path}.$`,
      'This Super note contains editor metadata that Markdown cannot preserve.',
    )
  }
  if (node.$ !== undefined && !objectNode(node.$)) {
    return reject('node-state-not-portable', `${path}.$`, 'This Super note contains invalid editor metadata.')
  }
  if (type === 'list' && node.listType === 'check') {
    return reject(
      'checklist-not-portable',
      `${path}.listType`,
      'Checklist identities, due dates, and recurrence cannot yet be preserved by a whole-note Markdown rewrite.',
    )
  }
  if (
    node.version !== undefined &&
    (!Number.isInteger(node.version) ||
      (type === 'mermaid' ? node.version !== 1 && node.version !== 2 : node.version !== 1))
  ) {
    return reject('property-not-portable', `${path}.version`, `This ${type} node version is not supported safely.`)
  }
  if (
    ![undefined, null].includes(node.direction as undefined | null) ||
    (!isTextNode && ![undefined, '', 0].includes(node.format as undefined | string | number)) ||
    ![undefined, 0].includes(node.indent as undefined | number) ||
    ![undefined, 0].includes(node.textFormat as undefined | number) ||
    ![undefined, ''].includes(node.textStyle as undefined | string) ||
    ![undefined, ''].includes(node.style as undefined | string)
  ) {
    return reject('property-not-portable', path, `Formatting on ${type} is outside the safe Markdown subset.`)
  }
  if (isTextNode) {
    const format = typeof node.format === 'number' ? node.format : 0
    if ((format & ~TEXT_FORMAT_MASK) !== 0 || ((format & 16) !== 0 && format !== 16)) {
      return reject('property-not-portable', `${path}.format`, 'This inline formatting is not Markdown-portable.')
    }
    if (
      ![undefined, 0].includes(node.detail as undefined | number) ||
      ![undefined, 'normal'].includes(node.mode as undefined | string)
    ) {
      return reject('property-not-portable', path, 'This text node has non-portable presentation state.')
    }
  }
  if (type === 'link' && [node.rel, node.target, node.title].some((value) => value !== undefined && value !== null)) {
    return reject('property-not-portable', path, 'Link target, relationship, or title metadata would be lost.')
  }
  if (
    type === 'tablecell' &&
    (node.colSpan !== 1 ||
      node.rowSpan !== 1 ||
      ![undefined, 0].includes(node.headerState as undefined | number) ||
      ![undefined, null].includes(node.backgroundColor as undefined | null) ||
      node.width !== undefined)
  ) {
    return reject(
      'property-not-portable',
      path,
      'Merged, sized, styled, or header-state table cells are not Markdown-portable.',
    )
  }
  if (type === 'listitem' && node.checked !== undefined && node.checked !== null) {
    return reject('checklist-not-portable', `${path}.checked`, 'Checklist state cannot be preserved safely.')
  }
  if (type === 'unencrypted-image' && ![undefined, 'none'].includes(node.float as undefined | string)) {
    return reject('property-not-portable', `${path}.float`, 'Image layout would be lost in Markdown.')
  }
  if (type === 'mermaid' && ![undefined, null, 'default'].includes(node.theme as undefined | null | string)) {
    return reject('property-not-portable', `${path}.theme`, 'The Mermaid theme would be lost in Markdown.')
  }
  if (type === 'mermaid' && ![undefined, 'split'].includes(node.viewMode as undefined | string)) {
    return reject('property-not-portable', `${path}.viewMode`, 'The Mermaid view mode would be lost in Markdown.')
  }
  if (type === 'code' && ![undefined, null].includes(node.theme as undefined | null)) {
    return reject('property-not-portable', `${path}.theme`, 'The code theme would be lost in Markdown.')
  }
  return undefined
}

export function validateSuperNoteMarkdownRewrite(superNoteText: string): SuperNoteMarkdownRewriteValidation {
  let document: unknown
  try {
    document = JSON.parse(superNoteText)
  } catch {
    return reject('invalid-json', 'root', 'The Super note body is not valid Lexical JSON.')
  }
  if (!objectNode(document) || !objectNode(document.root) || document.root.type !== 'root') {
    return reject('invalid-document', 'root', 'The Super note does not contain a valid Lexical root.')
  }

  const stack: Array<{ node: unknown; path: string; depth: number }> = [{ node: document.root, path: 'root', depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    if (++count > MAX_NODES || current.depth > MAX_DEPTH) {
      return reject(
        'document-too-complex',
        current.path,
        'The Super note is too complex for a safe whole-note rewrite.',
      )
    }
    if (!objectNode(current.node) || typeof current.node.type !== 'string') {
      return reject('invalid-document', current.path, 'The Super note contains an invalid serialized node.')
    }
    const invalid = validatePortableProperties(current.node, current.path)
    if (invalid) {
      return invalid
    }
    if (current.node.children !== undefined) {
      if (!Array.isArray(current.node.children)) {
        return reject('invalid-document', `${current.path}.children`, 'Serialized node children must be an array.')
      }
      for (let index = current.node.children.length - 1; index >= 0; index--) {
        stack.push({
          node: current.node.children[index],
          path: `${current.path}.children[${index}]`,
          depth: current.depth + 1,
        })
      }
    }
  }
  return { ok: true }
}

export function assertSuperNoteMarkdownRewriteSafe(superNoteText: string): void {
  const result = validateSuperNoteMarkdownRewrite(superNoteText)
  if (!result.ok) {
    throw new UnsafeSuperNoteMarkdownRewriteError(result)
  }
}
