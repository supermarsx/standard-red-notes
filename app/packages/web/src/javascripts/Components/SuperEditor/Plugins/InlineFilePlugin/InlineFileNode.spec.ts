/** @jest-environment jsdom */

import { createHeadlessEditor } from '@lexical/headless'
import { $isInlineFileNode, InlineFileNode } from './InlineFileNode'

jest.mock('./InlineFileComponent', () => ({ __esModule: true, default: () => null }))

const editor = createHeadlessEditor({
  namespace: 'InlineFileNodeDomImportTest',
  nodes: [InlineFileNode],
  onError: (error) => {
    throw error
  },
})

function importSourceMime(parentTag: 'audio' | 'video', explicitType?: string): string {
  const parent = document.createElement(parentTag)
  const source = document.createElement('source')
  if (explicitType) {
    source.type = explicitType
  }
  parent.appendChild(source)

  const conversion = InlineFileNode.importDOM()?.source?.(source as unknown as HTMLDivElement)?.conversion
  expect(conversion).toBeDefined()

  let mimeType = ''
  editor.update(
    () => {
      const node = conversion?.(source as unknown as HTMLDivElement)?.node
      expect($isInlineFileNode(node as InlineFileNode)).toBe(true)
      mimeType = (node as InlineFileNode).exportJSON().mimeType
    },
    { discrete: true },
  )
  return mimeType
}

describe('InlineFileNode media DOM import', () => {
  it('preserves an explicit source type instead of coercing it to video', () => {
    expect(importSourceMime('audio', 'audio/ogg')).toBe('audio/ogg')
  })

  it('uses a media-specific fallback only when source type is absent', () => {
    expect(importSourceMime('audio')).toBe('audio/mp3')
    expect(importSourceMime('video')).toBe('video/mp4')
  })
})
