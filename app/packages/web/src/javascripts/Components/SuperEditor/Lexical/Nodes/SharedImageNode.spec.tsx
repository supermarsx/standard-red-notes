/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { createHeadlessEditor } from '@lexical/headless'
import type { LexicalEditor } from 'lexical'

import { BlockEditorNodes } from './AllNodes'
import {
  isRenderableSharedImageSource,
  SharedImageNode,
  SHARED_IMAGE_NODE_TYPE,
  SerializedSharedImageNode,
} from './SharedImageNode'

/**
 * The two properties this node exists for, each tested as a property rather
 * than as a snapshot:
 *
 *  1. It renders with NO `<ApplicationProvider>`. Every pre-existing
 *     image-capable node (`snfile`, `inline-file`, `unencrypted-image`) calls
 *     `useApplication()`, which throws on the public share page by design, so
 *     an image routed through any of them reaches the reader as "this block
 *     could not be displayed". A render here that needed a provider would
 *     reintroduce exactly that. Nothing in this file mounts a provider.
 *
 *  2. A source that is not provably the image it claims degrades to the
 *     VISIBLE placeholder instead of reaching `<img>`. The check is re-run at
 *     render because the node is rebuilt from an envelope the page just
 *     decrypted; the build-time check ran on different bytes, on a different
 *     machine, possibly months earlier.
 */

/** A real, decodable 1x1 PNG. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])
const PNG_DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`
/** A real PDF, mislabelled as a PNG. */
const PDF_AS_PNG = `data:image/png;base64,${btoa('%PDF-1.4\n%abc')}`

type NodeProps = ConstructorParameters<typeof SharedImageNode>[0]

let container: HTMLDivElement
let root: Root
let editor: LexicalEditor

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Lexical nodes may only be constructed inside an editor context, so the
  // spec owns one. It is headless: it proves nothing about rendering, and the
  // React render below deliberately happens outside it.
  editor = createHeadlessEditor({
    namespace: 'shared-image-spec',
    nodes: BlockEditorNodes,
    onError: (error) => {
      throw error
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Build a node inside the editor and hand the result back out. */
function withNode<T>(props: NodeProps, read: (node: SharedImageNode) => T): T {
  let out: { value: T } | undefined
  editor.update(
    () => {
      out = { value: read(new SharedImageNode(props)) }
    },
    { discrete: true },
  )
  if (out === undefined) {
    throw new Error('editor.update did not run synchronously')
  }
  return out.value
}

function renderNode(props: NodeProps): void {
  const element = withNode(props, (node) => node.decorate(editor, null as never)) as JSX.Element
  act(() => {
    root.render(element)
  })
}

describe('SharedImageNode rendering', () => {
  it('renders an <img> with the data URL and no application context at all', () => {
    renderNode({ src: PNG_DATA_URL, mimeType: 'image/png', fileName: 'embedded.png', caption: 'A caption' })

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toBe(PNG_DATA_URL)
    expect(container.querySelector('[data-share-asset]')?.getAttribute('data-share-asset')).toBe('image')
    expect(container.querySelector('figcaption')?.textContent).toBe('A caption')
  })

  it('shows the named placeholder, and no <img>, when the attachment was left out', () => {
    renderNode({
      fileName: 'holiday.png',
      reason: 'too-large',
      message: '[“holiday.png” (8.58 MB) is too large to embed in a share link, so it is not included here.]',
    })

    expect(container.querySelector('img')).toBeNull()
    const placeholder = container.querySelector('[data-share-asset]')
    expect(placeholder?.getAttribute('data-share-asset')).toBe('too-large')
    expect(placeholder?.textContent).toContain('holiday.png')
    expect(placeholder?.textContent).toContain('too large')
  })

  it('refuses a source whose bytes are not the image it claims, at RENDER time', () => {
    renderNode({ src: PDF_AS_PNG, mimeType: 'image/png', fileName: 'invoice.png' })

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-share-asset]')?.getAttribute('data-share-asset')).toBe('unsafe-source')
  })

  it.each([
    ['an http URL', 'https://example.com/tracker.png'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a file URL', 'file:///etc/passwd'],
    ['an SVG data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
  ])('never puts %s in an <img>', (_label, source) => {
    renderNode({ src: source, mimeType: 'image/png', fileName: 'x.png' })

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[data-share-asset]')).not.toBeNull()
  })

  it('refuses a data URL whose declared type disagrees with the node’s mime type', () => {
    renderNode({ src: PNG_DATA_URL, mimeType: 'image/jpeg', fileName: 'x.jpg' })

    expect(container.querySelector('img')).toBeNull()
  })

  it('still says something when a placeholder carries no authored sentence', () => {
    renderNode({ fileName: 'mystery.bin', reason: 'not-found' })

    const placeholder = container.querySelector('[data-share-asset]')
    expect(placeholder?.textContent).toContain('mystery.bin')
    expect(placeholder?.textContent).not.toContain('undefined')
  })
})

describe('isRenderableSharedImageSource', () => {
  it('accepts a matching, signature-verified data URL', () => {
    expect(isRenderableSharedImageSource(PNG_DATA_URL, 'image/png', 'a.png')).toBe(true)
  })

  it('refuses an absent source', () => {
    expect(isRenderableSharedImageSource(undefined, 'image/png', 'a.png')).toBe(false)
    expect(isRenderableSharedImageSource('', 'image/png', 'a.png')).toBe(false)
  })

  it('refuses a source with no mime type to check against', () => {
    expect(isRenderableSharedImageSource(PNG_DATA_URL, undefined, 'a.png')).toBe(false)
  })
})

describe('SharedImageNode serialization', () => {
  it('round-trips through exportJSON/importJSON', () => {
    const serialized = withNode(
      { src: PNG_DATA_URL, mimeType: 'image/png', fileName: 'a.png', width: 240, caption: 'c', float: 'left' },
      (node) => node.exportJSON(),
    )

    expect(serialized.type).toBe(SHARED_IMAGE_NODE_TYPE)
    let restored: SerializedSharedImageNode | undefined
    editor.update(
      () => {
        restored = SharedImageNode.importJSON(serialized).exportJSON()
      },
      { discrete: true },
    )
    expect(restored).toEqual(serialized)
  })

  it('never accepts a node built from pasted HTML', () => {
    expect(SharedImageNode.importDOM()).toBeNull()
  })

  it('exports an <img> for an image and a sentence for a placeholder', () => {
    const image = withNode({ src: PNG_DATA_URL, mimeType: 'image/png', fileName: 'a.png' }, (node) => node.exportDOM())
      .element as HTMLElement
    expect(image.tagName).toBe('IMG')

    const placeholder = withNode({ fileName: 'a.pdf', reason: 'not-an-image', message: '[left out]' }, (node) =>
      node.exportDOM(),
    ).element as HTMLElement
    expect(placeholder.tagName).toBe('P')
    expect(placeholder.textContent).toBe('[left out]')
  })

  it('gives a placeholder the SAME text a reader sees, so extraction cannot disagree', () => {
    expect(
      withNode({ fileName: 'a.pdf', reason: 'not-an-image', message: '[left out]' }, (node) => node.getTextContent()),
    ).toBe('[left out]')
  })

  /**
   * The registry check. Lexical refuses to parse an unregistered node type, so
   * a `shared-image` missing from `AllNodes` would make the WHOLE shared note
   * fail to load — not just the image. This proves the registration is live.
   */
  it('is registered in the node set the shared viewer parses with', () => {
    const serialized: SerializedSharedImageNode = {
      type: SHARED_IMAGE_NODE_TYPE,
      version: 1,
      src: PNG_DATA_URL,
      mimeType: 'image/png',
      fileName: 'a.png',
      float: 'none',
    }

    const state = editor.parseEditorState({
      root: { children: [serialized], direction: null, format: '', indent: 0, type: 'root', version: 1 },
    } as never)
    editor.setEditorState(state)

    const roundTripped = (editor.getEditorState().toJSON() as { root: { children: { type: string }[] } }).root
      .children[0]
    expect(roundTripped.type).toBe(SHARED_IMAGE_NODE_TYPE)
  })
})
