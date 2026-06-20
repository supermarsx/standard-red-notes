import { sanitizeFileName } from '@standardnotes/utils'
import { gridToAOA, gridToStringRows, parseSpreadsheetGrids, SpreadsheetGrid } from './spreadsheetGrid'

/**
 * Export a Spreadsheet note (`NoteType.Spreadsheet`) to `.xlsx` (Excel) and
 * `.docx` (Word). The pure data-shaping lives in `spreadsheetGrid.ts`; this
 * module lazy-loads the heavy `xlsx` / `docx` libraries (so they are
 * code-split) and triggers the browser download.
 */

/** Trigger a browser download of a Blob via a temporary anchor. */
const downloadBlob = (blob: Blob, filename: string): void => {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

const filenameFromTitle = (title: string, extension: string): string => {
  const sanitized = sanitizeFileName(title || 'Spreadsheet').trim()
  return `${sanitized.length > 0 ? sanitized : 'Spreadsheet'}.${extension}`
}

/** Ensure we always have at least one (possibly empty) grid to export. */
const gridsOrEmpty = (noteText: string): SpreadsheetGrid[] => {
  const grids = parseSpreadsheetGrids(noteText)
  return grids.length > 0 ? grids : [{ name: 'Sheet1', rows: [] }]
}

/**
 * Build and download an `.xlsx` workbook from a spreadsheet note's text. Each
 * sheet becomes a worksheet; numeric/boolean cell values keep their type.
 * Empty sheets export as a valid workbook with empty worksheets.
 */
export const exportSpreadsheetNoteToXLSX = async (noteText: string, noteTitle: string): Promise<void> => {
  const XLSX = await import('xlsx')
  const grids = gridsOrEmpty(noteText)

  const workbook = XLSX.utils.book_new()
  const usedNames = new Set<string>()

  grids.forEach((grid, index) => {
    const aoa = gridToAOA(grid)
    const worksheet = XLSX.utils.aoa_to_sheet(aoa.length > 0 ? aoa : [[]])

    // Worksheet names are limited to 31 chars and must be unique within a book.
    let name = (grid.name || `Sheet${index + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${index + 1}`
    let suffix = 1
    while (usedNames.has(name.toLowerCase())) {
      const base = name.slice(0, 31 - String(suffix).length - 1)
      name = `${base}_${suffix}`
      suffix++
    }
    usedNames.add(name.toLowerCase())

    XLSX.utils.book_append_sheet(workbook, worksheet, name)
  })

  const arrayBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  downloadBlob(blob, filenameFromTitle(noteTitle, 'xlsx'))
}

/**
 * Build and download a `.docx` document from a spreadsheet note's text. Each
 * sheet is rendered as a bordered Word table. Empty sheets export a document
 * with a "(empty sheet)" note so the file is always valid.
 */
export const exportSpreadsheetNoteToDOCX = async (noteText: string, noteTitle: string): Promise<void> => {
  const docx = await import('docx')
  const { Document, Packer, Table, TableRow, TableCell, Paragraph, TextRun, HeadingLevel, WidthType, BorderStyle } = docx

  const grids = gridsOrEmpty(noteText)

  const singleBorder = { style: BorderStyle.SINGLE, size: 1, color: '999999' }
  const tableBorders = {
    top: singleBorder,
    bottom: singleBorder,
    left: singleBorder,
    right: singleBorder,
    insideHorizontal: singleBorder,
    insideVertical: singleBorder,
  }

  const docChildren: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = []

  grids.forEach((grid, index) => {
    if (grids.length > 1) {
      docChildren.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: grid.name || `Sheet${index + 1}` })],
        }),
      )
    }

    const stringRows = gridToStringRows(grid)

    if (stringRows.length === 0) {
      docChildren.push(new Paragraph({ children: [new TextRun({ text: '(empty sheet)', italics: true })] }))
      return
    }

    const width = stringRows.reduce((max, row) => Math.max(max, row.length), 0)

    const tableRows = stringRows.map(
      (row) =>
        new TableRow({
          children: Array.from({ length: width }, (_unused, colIndex) => {
            const text = row[colIndex] ?? ''
            return new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text })] })],
            })
          }),
        }),
    )

    docChildren.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: tableBorders,
        rows: tableRows,
      }),
    )
  })

  const doc = new Document({
    sections: [{ children: docChildren }],
  })

  const blob = await Packer.toBlob(doc)
  downloadBlob(blob, filenameFromTitle(noteTitle, 'docx'))
}
