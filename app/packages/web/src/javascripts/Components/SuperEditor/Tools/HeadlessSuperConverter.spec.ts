/** @jest-environment jsdom */

const mockGeneratePDF = jest.fn<Promise<Blob>, unknown[]>()

jest.mock('../Lexical/Utils/PDFExport/PDFExport', () => ({
  $generatePDFFromNodes: (...args: unknown[]) => mockGeneratePDF(...args),
}))

import { HeadlessSuperConverter } from './HeadlessSuperConverter'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { $setChecklistDueAt } from '../Lexical/Nodes/ChecklistItemNode'
import { createHeadlessEditor } from '@lexical/headless'
import { SuperExportNodes } from '../Lexical/Nodes/AllNodes'
import BlocksEditorTheme from '../Lexical/Theme/Theme'
import { $createFileNode } from '../Plugins/EncryptedFilePlugin/Nodes/FileUtils'
import type { FileItem } from '@standardnotes/snjs'

function checklistDocument(): string {
  const editor = createEditor({ nodes: [ListNode, ListItemNode] })
  editor.update(
    () => {
      const item = $createListItemNode(false).append($createTextNode('Ship release'))
      $setChecklistDueAt(item, '2099-01-02T03:04:00.000Z')
      $getRoot().append($createListNode('check').append(item))
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

function embeddedDocument(secret: string, fileId: string): string {
  const editor = createHeadlessEditor({
    namespace: 'HeadlessSuperConverterConcurrencyFixture',
    theme: BlocksEditorTheme,
    editable: false,
    onError: (error: Error) => {
      throw error
    },
    nodes: SuperExportNodes,
  })
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(secret)), $createFileNode(fileId))
    },
    { discrete: true },
  )
  return JSON.stringify(editor.getEditorState().toJSON())
}

describe('HeadlessSuperConverter PDF Blob path', () => {
  beforeEach(() => {
    mockGeneratePDF.mockReset()
  })

  it('generates a real blank PDF for an empty note instead of returning an empty URL/string', async () => {
    const expected = new Blob(['%PDF-1.7\nblank page'], { type: 'application/pdf' })
    mockGeneratePDF.mockResolvedValue(expected)
    const converter = new HeadlessSuperConverter()

    const actual = await converter.convertSuperStringToPDFBlob('', { pdf: { pageSize: 'A4' } })

    expect(actual).toBe(expected)
    expect(actual.size).toBeGreaterThan(5)
    expect(mockGeneratePDF).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy string API CSP-safe without creating an object URL', async () => {
    const expected = new Blob(['%PDF-1.7\nbody'], { type: 'application/pdf' })
    mockGeneratePDF.mockResolvedValue(expected)
    const converter = new HeadlessSuperConverter()
    const createObjectURL = jest.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })

    const result = await converter.convertSuperStringToOtherFormat('', 'pdf', { pdf: { pageSize: 'LETTER' } })

    expect(result).toMatch(/^data:application\/pdf;base64,/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('HeadlessSuperConverter portable checklist exports', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it.each(['txt', 'md', 'html'] as const)('includes semantic checklist deadlines in %s output', async (format) => {
    jest.useFakeTimers().setSystemTime(new Date('2098-01-01T00:00:00.000Z'))
    const converter = new HeadlessSuperConverter()

    const output = await converter.convertSuperStringToOtherFormat(checklistDocument(), format)

    expect(output).toContain('Ship release')
    expect(output).toContain('Due ')
    expect(output).toContain('2099')
    expect(output.match(/Due /g)).toHaveLength(1)
  })

  it('leaves the lossless JSON contract unchanged', async () => {
    const input = checklistDocument()
    const converter = new HeadlessSuperConverter()

    await expect(converter.convertSuperStringToOtherFormat(input, 'json')).resolves.toBe(input)
  })
})

describe('HeadlessSuperConverter concurrent export isolation', () => {
  it('keeps distinct secrets in their owning export while the first export awaits file I/O', async () => {
    const converter = new HeadlessSuperConverter()
    const alphaSecret = 'ALPHA_EXPORT_PRIVATE_13a2b'
    const betaSecret = 'BETA_EXPORT_PRIVATE_97c4d'
    const alphaFileId = 'alpha-file-id'
    const betaFileId = 'beta-file-id'
    let releaseAlpha!: () => void
    let markAlphaStarted!: () => void
    const alphaRelease = new Promise<void>((resolve) => {
      releaseAlpha = resolve
    })
    const alphaStarted = new Promise<void>((resolve) => {
      markAlphaStarted = resolve
    })
    const fileItem = (id: string) =>
      ({ uuid: id, name: `${id}.txt`, title: `${id}.txt`, mimeType: 'text/plain' }) as unknown as FileItem

    const alphaExport = converter.convertSuperStringToOtherFormat(embeddedDocument(alphaSecret, alphaFileId), 'html', {
      embedBehavior: 'inline',
      getFileItem: fileItem,
      getFileBase64: async (id) => {
        expect(id).toBe(alphaFileId)
        markAlphaStarted()
        await alphaRelease
        return 'data:text/plain;base64,YWxwaGE='
      },
    })

    await alphaStarted

    const betaExport = await converter.convertSuperStringToOtherFormat(embeddedDocument(betaSecret, betaFileId), 'md', {
      embedBehavior: 'inline',
      getFileItem: fileItem,
      getFileBase64: async (id) => {
        expect(id).toBe(betaFileId)
        return 'data:text/plain;base64,YmV0YQ=='
      },
    })
    releaseAlpha()
    const resolvedAlphaExport = await alphaExport

    expect(resolvedAlphaExport).toContain(alphaSecret)
    expect(resolvedAlphaExport).not.toContain(betaSecret)
    expect(betaExport).toContain(betaSecret)
    expect(betaExport).not.toContain(alphaSecret)
  })
})
