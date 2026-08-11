/** @jest-environment jsdom */

const mockGeneratePDF = jest.fn<Promise<Blob>, unknown[]>()

jest.mock('../Lexical/Utils/PDFExport/PDFExport', () => ({
  $generatePDFFromNodes: (...args: unknown[]) => mockGeneratePDF(...args),
}))

import { HeadlessSuperConverter } from './HeadlessSuperConverter'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot, createEditor } from 'lexical'
import { $setChecklistDueAt } from '../Lexical/Nodes/ChecklistItemNode'

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
