/** @jest-environment jsdom */

import { createHeadlessEditor } from '@lexical/headless'
import { $createInlineFileNode, $isInlineFileNode, InlineFileNode } from './InlineFileNode'

jest.mock('./InlineFileComponent', () => ({ __esModule: true, default: () => null }))

const editor = createHeadlessEditor({
  namespace: 'InlineFileNodeSerializationTest',
  nodes: [InlineFileNode],
  onError: (error) => {
    throw error
  },
})

describe('InlineFileNode trusted serialization boundary', () => {
  it('never upgrades generic external media or forged metadata DOM', () => {
    expect(InlineFileNode.importDOM()).toBeNull()

    const candidates = [
      document.createElement('object'),
      document.createElement('img'),
      document.createElement('source'),
      document.createElement('span'),
    ]
    for (const element of candidates) {
      element.setAttribute('data-lexical-inline-file', 'true')
      element.setAttribute('data-file-source', 'https://example.invalid/tracker')
      element.setAttribute('data-mime-type', 'image/png')
      element.setAttribute('data-file-name', 'photo.png')
      expect(InlineFileNode.importDOM()).toBeNull()
    }
  })

  it('preserves persisted and internal-clipboard state through trusted Lexical JSON', () => {
    editor.update(
      () => {
        const serialized = $createInlineFileNode('blob:trusted-source', 'application/pdf', 'document.pdf')
          .setWidth(720)
          .setCaption('Reference')
          .setFloat('right')
          .exportJSON()
        const imported = InlineFileNode.importJSON(serialized)

        expect($isInlineFileNode(imported)).toBe(true)
        expect(imported.exportJSON()).toEqual(serialized)
      },
      { discrete: true },
    )
  })

  it.each([
    ['application/pdf', 'document.pdf'],
    ['text/plain', 'notes.txt'],
    ['application/octet-stream', 'photo.png'],
    ['image/svg+xml', 'drawing.svg'],
    ['image/png', 'document.pdf'],
  ])('exports %s as inert file metadata rather than image/active object DOM', (mimeType, fileName) => {
    const exported: HTMLElement[] = []
    let textContent = ''
    editor.update(
      () => {
        const node = $createInlineFileNode('blob:attachment', mimeType, fileName)
        exported.push(node.exportDOM().element as HTMLElement)
        textContent = node.getTextContent()
      },
      { discrete: true },
    )

    expect(exported[0].tagName).toBe('SPAN')
    expect(exported[0].hasAttribute('data-lexical-inline-file')).toBe(true)
    expect(textContent.startsWith('!')).toBe(false)
  })

  it('exports a trusted supported image as img DOM and image markdown', () => {
    const exported: HTMLElement[] = []
    let textContent = ''
    editor.update(
      () => {
        const node = $createInlineFileNode('data:image/png;base64,iVBORw0KGgo=', 'image/png', 'photo.png')
        exported.push(node.exportDOM().element as HTMLElement)
        textContent = node.getTextContent()
      },
      { discrete: true },
    )

    expect(exported[0].tagName).toBe('IMG')
    expect(textContent.startsWith('!')).toBe(true)
  })
})
