/**
 * @jest-environment jsdom
 *
 * Round-trips the serialization of the Word-style image attributes added to the
 * three Super (Lexical) image node types:
 *   - FileNode (`snfile`)            — primary persistent uploaded image
 *   - RemoteImageNode (`unencrypted-image`)
 *   - InlineFileNode (`inline-file`)
 *
 * For each node we assert:
 *   - the new attributes (width / caption / float) survive exportJSON -> importJSON -> exportJSON
 *   - the pre-existing attributes (format, fileUuid/src/etc., zoomLevel) are unaffected
 *   - importing OLD json that lacks the new attributes yields safe defaults
 *     (width undefined, caption undefined, float 'none') so existing notes with
 *     images do not break.
 *
 * The node modules pull in their React decorator components at import time; we
 * mock those component modules so this stays a pure serialization unit test
 * (and so jsdom doesn't try to mount the app shell). Construction of a node
 * assigns it a key (a write), so all node work runs inside editor.update() on a
 * headless editor — same pattern as EditorBlockSerialization.spec.ts.
 */

jest.mock('../EncryptedFilePlugin/Nodes/FileComponent', () => ({ __esModule: true, default: () => null }))
jest.mock('../RemoteImagePlugin/RemoteImageComponent', () => ({ __esModule: true, default: () => null }))
jest.mock('../InlineFilePlugin/InlineFileComponent', () => ({ __esModule: true, default: () => null }))

import { createHeadlessEditor } from '@lexical/headless'

import { FileNode } from '../EncryptedFilePlugin/Nodes/FileNode'
import { $createFileNode } from '../EncryptedFilePlugin/Nodes/FileUtils'
import { RemoteImageNode, $createRemoteImageNode } from '../RemoteImagePlugin/RemoteImageNode'
import { InlineFileNode, $createInlineFileNode } from '../InlineFilePlugin/InlineFileNode'

const editor = createHeadlessEditor({
  namespace: 'ImageNodeSerializationTest',
  nodes: [FileNode, RemoteImageNode, InlineFileNode],
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

describe('Super image node serialization (Word-style attributes)', () => {
  describe('FileNode', () => {
    it('round-trips width / caption / float along with existing attrs', () => {
      const { first, second } = inEditor(() => {
        const node = $createFileNode('file-uuid-1')
          .setZoomLevel(80)
          .setFormat('center')
          .setWidth(320)
          .setCaption('A nice picture')
          .setFloat('right')
        const first = node.exportJSON()
        const second = FileNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(first.fileUuid).toBe('file-uuid-1')
      expect(first.zoomLevel).toBe(80)
      expect(first.format).toBe('center')
      expect(first.width).toBe(320)
      expect(first.caption).toBe('A nice picture')
      expect(first.float).toBe('right')
      expect(second).toEqual(first)
    })

    it('imports OLD json (no width/caption/float) with safe defaults', () => {
      const imported = inEditor(() => {
        const legacy = { type: 'snfile', version: 1, format: '', fileUuid: 'old-uuid', zoomLevel: 100 } as never
        return FileNode.importJSON(legacy).exportJSON()
      })
      expect(imported.fileUuid).toBe('old-uuid')
      expect(imported.zoomLevel).toBe(100)
      expect(imported.width).toBeUndefined()
      expect(imported.caption).toBeUndefined()
      expect(imported.float).toBe('none')
    })

    it('round-trips the collapsed fold state (both true and false)', () => {
      const collapsed = inEditor(() => {
        const node = $createFileNode('file-uuid-collapsed').setCollapsed(true)
        const first = node.exportJSON()
        const second = FileNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(collapsed.first.collapsed).toBe(true)
      expect(collapsed.second).toEqual(collapsed.first)

      const expanded = inEditor(() => {
        const node = $createFileNode('file-uuid-expanded').setCollapsed(false)
        const first = node.exportJSON()
        const second = FileNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(expanded.first.collapsed).toBe(false)
      expect(expanded.second).toEqual(expanded.first)
    })

    it('imports OLD json (no collapsed) leaving collapsed undefined so the per-type default applies', () => {
      const imported = inEditor(() => {
        const legacy = { type: 'snfile', version: 1, format: '', fileUuid: 'old-uuid', zoomLevel: 100 } as never
        return FileNode.importJSON(legacy).exportJSON()
      })
      expect(imported.collapsed).toBeUndefined()
    })
  })

  describe('RemoteImageNode', () => {
    it('round-trips width / caption / float along with src/alt/format', () => {
      const { first, second } = inEditor(() => {
        const node = $createRemoteImageNode('https://example.com/a.png', 'alt text')
          .setFormat('left')
          .setWidth(200)
          .setCaption('remote caption')
          .setFloat('left')
        const first = node.exportJSON()
        const second = RemoteImageNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(first.src).toBe('https://example.com/a.png')
      expect(first.alt).toBe('alt text')
      expect(first.format).toBe('left')
      expect(first.width).toBe(200)
      expect(first.caption).toBe('remote caption')
      expect(first.float).toBe('left')
      expect(second).toEqual(first)
    })

    it('imports OLD json with safe defaults', () => {
      const imported = inEditor(() => {
        const legacy = {
          type: 'unencrypted-image',
          version: 1,
          format: '',
          src: 'https://example.com/old.png',
          alt: undefined,
        } as never
        return RemoteImageNode.importJSON(legacy).exportJSON()
      })
      expect(imported.src).toBe('https://example.com/old.png')
      expect(imported.width).toBeUndefined()
      expect(imported.caption).toBeUndefined()
      expect(imported.float).toBe('none')
    })
  })

  describe('InlineFileNode', () => {
    it('round-trips width / caption / float along with src/mimeType/fileName/format', () => {
      const { first, second } = inEditor(() => {
        const node = $createInlineFileNode('data:image/png;base64,AAAA', 'image/png', 'inline.png')
          .setFormat('right')
          .setWidth(150)
          .setCaption('inline caption')
          .setFloat('right')
        const first = node.exportJSON()
        const second = InlineFileNode.importJSON(first).exportJSON()
        return { first, second }
      })
      expect(first.src).toBe('data:image/png;base64,AAAA')
      expect(first.mimeType).toBe('image/png')
      expect(first.fileName).toBe('inline.png')
      expect(first.format).toBe('right')
      expect(first.width).toBe(150)
      expect(first.caption).toBe('inline caption')
      expect(first.float).toBe('right')
      expect(second).toEqual(first)
    })

    it('imports OLD json with safe defaults', () => {
      const imported = inEditor(() => {
        const legacy = {
          type: 'inline-file',
          version: 1,
          format: '',
          src: 'data:image/png;base64,OLD',
          mimeType: 'image/png',
          fileName: 'old.png',
        } as never
        return InlineFileNode.importJSON(legacy).exportJSON()
      })
      expect(imported.src).toBe('data:image/png;base64,OLD')
      expect(imported.width).toBeUndefined()
      expect(imported.caption).toBeUndefined()
      expect(imported.float).toBe('none')
    })
  })
})
