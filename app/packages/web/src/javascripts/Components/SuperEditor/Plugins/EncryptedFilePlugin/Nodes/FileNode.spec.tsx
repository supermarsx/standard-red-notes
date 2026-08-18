/** @jest-environment jsdom */

import { createHeadlessEditor } from '@lexical/headless'
import { $createFileNode, $isFileNode } from './FileUtils'
import { FileNode } from './FileNode'

jest.mock('./FileComponent', () => ({ __esModule: true, default: () => null }))

const editor = createHeadlessEditor({
  namespace: 'EncryptedFileNodeSerializationTest',
  nodes: [FileNode],
  onError: (error) => {
    throw error
  },
})

describe('FileNode trusted serialization boundary', () => {
  it('never upgrades generic or attributed external DOM into an encrypted file node', () => {
    expect(FileNode.importDOM()).toBeNull()

    for (const tagName of ['div', 'span'] as const) {
      const element = document.createElement(tagName)
      element.setAttribute('data-lexical-file-uuid', 'forged-file-reference')
      expect(FileNode.importDOM()).toBeNull()
    }
  })

  it('exports inert human-readable DOM without a rehydration capability attribute', () => {
    editor.update(
      () => {
        const element = $createFileNode('file-1').exportDOM().element as HTMLElement
        expect(element.tagName).toBe('SPAN')
        expect(element.hasAttribute('data-lexical-file-uuid')).toBe(false)
        expect(element.textContent).toBe('[File: file-1]')
      },
      { discrete: true },
    )
  })

  it('preserves persisted and internal-clipboard state through trusted Lexical JSON', () => {
    editor.update(
      () => {
        const serialized = $createFileNode('file-1')
          .setZoomLevel(125)
          .setWidth(640)
          .setCaption('Diagram')
          .setFloat('left')
          .setCollapsed(true)
          .exportJSON()
        const imported = FileNode.importJSON(serialized)

        expect($isFileNode(imported)).toBe(true)
        expect(imported.exportJSON()).toEqual(serialized)
      },
      { discrete: true },
    )
  })
})
