/**
 * TEST-ONLY helpers shared by the DOCX/ODT import + round-trip specs. Do NOT
 * import from product code.
 *
 * Provides: a File-like wrapper around a generated Blob (the converters only use
 * `file.arrayBuffer()`/`name`/`lastModified`), a full `Converter.convert`
 * dependency object whose `insertNote` captures the produced Super string, and a
 * handful of Super/Lexical JSON tree assertions (find-by-type, text collection,
 * formatted-run + image-node checks).
 */
import type { Converter } from '@standardnotes/ui-services'

/** Lexical TextNode format bitmask. */
export const FORMAT = {
  BOLD: 1,
  ITALIC: 2,
  UNDERLINE: 4,
  STRIKETHROUGH: 8,
  CODE: 16,
  SUBSCRIPT: 32,
  SUPERSCRIPT: 64,
} as const

/**
 * Super node `type` names produced by this repo's HTML→Super import. The t40
 * styled-block overrides rename the standard Lexical block nodes (heading →
 * `heading-styled`, quote → `quote-styled`), so specs must assert on these — a
 * plain `'heading'`/`'quote'` never appears in the imported tree.
 */
export const SUPER_TYPE = {
  heading: 'heading-styled',
  quote: 'quote-styled',
  list: 'list',
  table: 'table',
  link: 'link',
} as const

type ConvertDeps = Parameters<Converter['convert']>[1]

type InsertedNoteArgs = Parameters<ConvertDeps['insertNote']>[0]

/**
 * Build a full `convert` dependency object. `insertNote` records its arguments so
 * the spec can read back the produced Super string via `getInserted()`.
 */
export const makeConvertDeps = (
  convertHTMLToSuper: ConvertDeps['convertHTMLToSuper'],
): { deps: ConvertDeps; getInserted: () => InsertedNoteArgs } => {
  let inserted: InsertedNoteArgs | undefined
  const deps: ConvertDeps = {
    insertNote: async (args) => {
      inserted = args
      return { uuid: 'test-note', content_type: 'Note' } as unknown as Awaited<ReturnType<ConvertDeps['insertNote']>>
    },
    insertTag: async () => ({}) as unknown as Awaited<ReturnType<ConvertDeps['insertTag']>>,
    canUploadFiles: false,
    uploadFile: async () => undefined,
    canUseSuper: true,
    convertHTMLToSuper,
    convertMarkdownToSuper: (markdown: string) => markdown,
    readFileAsText: async () => '',
    linkItems: async () => {},
    cleanupItems: async () => {},
  }
  return {
    deps,
    getInserted: () => {
      if (!inserted) {
        throw new Error('insertNote was never called')
      }
      return inserted
    },
  }
}

/** Wrap a generated Blob as the minimal File surface the converters consume. */
export const fileFromBlob = async (blob: Blob, name: string, type: string): Promise<File> => {
  // The test env installs Node's `Blob`, whose `arrayBuffer()` returns an
  // ArrayBuffer from Node's realm — it fails a strict `instanceof ArrayBuffer`
  // check (mammoth's jszip does exactly that and would reject it). A real
  // browser `File.arrayBuffer()` returns a same-realm ArrayBuffer, so we copy the
  // bytes into a fresh one here to mirror the real File surface the app sees.
  const sourceBytes = new Uint8Array(await blob.arrayBuffer())
  const arrayBuffer = new ArrayBuffer(sourceBytes.byteLength)
  new Uint8Array(arrayBuffer).set(sourceBytes)
  return {
    name,
    type,
    lastModified: Date.now(),
    size: arrayBuffer.byteLength,
    arrayBuffer: async () => arrayBuffer,
  } as unknown as File
}

type AnyNode = Record<string, unknown>

const rootOf = (tree: AnyNode): AnyNode => (tree.root && typeof tree.root === 'object' ? (tree.root as AnyNode) : tree)

function* iterNodes(node: unknown): Generator<AnyNode> {
  if (!node || typeof node !== 'object') {
    return
  }
  const n = node as AnyNode
  if (typeof n.type === 'string') {
    yield n
  }
  const children = n.children
  if (Array.isArray(children)) {
    for (const child of children) {
      yield* iterNodes(child)
    }
  }
}

/** All nodes of a given Lexical `type` anywhere in the tree. */
export const collectByType = (tree: AnyNode, type: string): AnyNode[] => {
  const out: AnyNode[] = []
  for (const node of iterNodes(rootOf(tree))) {
    if (node.type === type) {
      out.push(node)
    }
  }
  return out
}

/** Concatenated text content of every text node in the tree. */
export const allText = (tree: AnyNode): string => {
  let text = ''
  for (const node of iterNodes(rootOf(tree))) {
    if (typeof node.text === 'string') {
      text += node.text
    }
  }
  return text
}

/** True if some text node has exactly `text` and the given format bit set. */
export const textNodeWithFormat = (tree: AnyNode, text: string, formatBit: number): boolean => {
  for (const node of iterNodes(rootOf(tree))) {
    if (node.type === 'text' && node.text === text && typeof node.format === 'number' && (node.format & formatBit) !== 0) {
      return true
    }
  }
  return false
}

const IMAGE_NODE_TYPES = new Set(['inline-file', 'snfile', 'unencrypted-image', 'image', 'remote-image'])

/** True if the tree contains any image-ish node (imported from `<img>`). */
export const hasImageNode = (tree: AnyNode): boolean => {
  for (const node of iterNodes(rootOf(tree))) {
    const type = node.type
    if (typeof type === 'string' && (IMAGE_NODE_TYPES.has(type) || /image/i.test(type))) {
      return true
    }
  }
  return false
}
