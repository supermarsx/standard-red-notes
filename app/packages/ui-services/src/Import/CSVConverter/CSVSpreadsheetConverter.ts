import { parseFileName } from '@standardnotes/utils'
import { Converter } from '../Converter'
import { ConversionResult } from '../ConversionResult'
import { csvToDataTableSuperString } from './csvToDataTableSuperString'
import { isValidCsvContent, parseCsvCapped } from './CSVConverterShared'

/** Import type id for "CSV -> Super spreadsheet (data table)". */
export const CSVSpreadsheetImportType = 'csv-spreadsheet'

/**
 * Imports a `.csv` file into a Super note containing a single `datatable`
 * (spreadsheet / data-table) block. Requires the Super editor since the
 * data-table block only exists there; otherwise the conversion throws so the
 * UI can surface a clear error.
 */
export class CSVSpreadsheetConverter implements Converter {
  getImportType(): string {
    return CSVSpreadsheetImportType
  }

  getSupportedFileTypes(): string[] {
    return ['text/csv']
  }

  isContentValid(content: string): boolean {
    return isValidCsvContent(content)
  }

  convert: Converter['convert'] = async (file, { insertNote, canUseSuper, readFileAsText }) => {
    if (!canUseSuper) {
      throw new Error('Importing a CSV as a spreadsheet requires the Super editor')
    }

    const content = await readFileAsText(file)

    if (!isValidCsvContent(content)) {
      throw new Error('File does not appear to be valid CSV')
    }

    const { rows } = parseCsvCapped(content)
    const superString = csvToDataTableSuperString(rows)

    const { name } = parseFileName(file.name)

    const createdAtDate = file.lastModified ? new Date(file.lastModified) : new Date()
    const updatedAtDate = file.lastModified ? new Date(file.lastModified) : new Date()

    const note = await insertNote({
      createdAt: createdAtDate,
      updatedAt: updatedAtDate,
      title: name,
      text: superString,
      useSuperIfPossible: true,
    })

    const result: ConversionResult = {
      successful: [note],
      errored: [],
    }

    return result
  }
}
