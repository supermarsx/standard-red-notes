/**
 * @jest-environment jsdom
 *
 * `RemoteImageNode.importDOM` is the ONLY `img:` DOM conversion registered in
 * the Super editor, so every `<img>` in pasted or imported HTML goes through
 * it. Word, Outlook and Windows Explorer all place
 * `<img src="file:///C:/…/clip_image001.png">` in the `text/html` clipboard
 * flavour; a node built around one renders an unloadable image forever after
 * ("Security Error: Content at https://… may not load or link to file:///…").
 *
 * Construction of a node assigns it a key (a write), so node work runs inside
 * `editor.update()` on a headless editor — same pattern as
 * ImageNodeSerialization.spec.ts.
 */

jest.mock('./RemoteImageComponent', () => ({ __esModule: true, default: () => null }))

import { createHeadlessEditor } from '@lexical/headless'
import { DOMConversionOutput, LexicalNode } from 'lexical'

import { RemoteImageNode, $isRemoteImageNode } from './RemoteImageNode'

const editor = createHeadlessEditor({
  namespace: 'RemoteImageNodeImportDOMTest',
  nodes: [RemoteImageNode],
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

function convert(src: string): DOMConversionOutput | null {
  const element = document.createElement('img')
  element.setAttribute('src', src)
  element.setAttribute('alt', 'Pasted image')

  const map = RemoteImageNode.importDOM()
  const matcher = map?.img
  if (!matcher) {
    throw new Error('RemoteImageNode no longer registers an img conversion')
  }
  const match = matcher(element as unknown as HTMLDivElement)
  if (!match) {
    throw new Error('RemoteImageNode refused to match an <img> element')
  }

  return inEditor(() => match.conversion(element as unknown as HTMLDivElement))
}

function importedImageSource(output: DOMConversionOutput | null): string {
  const node: LexicalNode | LexicalNode[] | null | undefined = output?.node
  if (node === null || node === undefined || Array.isArray(node)) {
    throw new Error('expected exactly one imported node')
  }
  if (!$isRemoteImageNode(node)) {
    throw new Error(`expected a RemoteImageNode, got ${node.getType()}`)
  }
  return node.__src
}

describe('RemoteImageNode.importDOM', () => {
  it('still imports an https image, keeping its source', () => {
    const output = convert('https://images.example.test/photo.png')

    expect(output).not.toBeNull()
    expect(importedImageSource(output)).toBe('https://images.example.test/photo.png')
  })

  it('still imports a data: image', () => {
    const source =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const output = convert(source)

    expect(importedImageSource(output)).toBe(source)
  })

  it.each([
    'file:///C:/Users/me/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png',
    'file://server/share/photo.png',
    'javascript:alert(1)',
    'about:blank',
  ])('drops a pasted <img> whose source is %s instead of persisting an unloadable node', (src) => {
    expect(convert(src)).toBeNull()
  })
})
