import { parseFileName } from '@standardnotes/utils'
import { Converter } from '../Converter'
import { ConversionResult } from '../ConversionResult'
import { csvToMarkdownTable } from './csvToMarkdownTable'
import { isValidCsvContent, parseCsvCapped } from './CSVConverterShared'

/** Import type id for "CSV -> Markdown table". */
export const CSVMarkdownImportType = 'csv-markdown'

/**
 * Imports a `.csv` file into a note containing a GitHub-flavoured Markdown
 * table (first row = header). When Super is available the markdown is converted
 * to a Super note via the existing markdown->super path, otherwise it is stored
 * as plain markdown text.
 */
export class CSVMarkdownConverter implements Converter {
  getImportType(): string {
    return CSVMarkdownImportType
  }

  getSupportedFileTypes(): string[] {
    return ['text/csv']
  }

  isContentValid(content: string): boolean {
    return isValidCsvContent(content)
  }

  convert: Converter['convert'] = async (file, { insertNote, convertMarkdownToSuper, readFileAsText }) => {
    const content = await readFileAsText(file)

    if (!isValidCsvContent(content)) {
      throw new Error('File does not appear to be valid CSV')
    }

    const { rows } = parseCsvCapped(content)
    const markdown = csvToMarkdownTable(rows)

    const { name } = parseFileName(file.name)

    const createdAtDate = file.lastModified ? new Date(file.lastModified) : new Date()
    const updatedAtDate = file.lastModified ? new Date(file.lastModified) : new Date()

    const note = await insertNote({
      createdAt: createdAtDate,
      updatedAt: updatedAtDate,
      title: name,
      text: convertMarkdownToSuper(markdown),
      useSuperIfPossible: true,
    })

    const result: ConversionResult = {
      successful: [note],
      errored: [],
    }

    return result
  }
}
