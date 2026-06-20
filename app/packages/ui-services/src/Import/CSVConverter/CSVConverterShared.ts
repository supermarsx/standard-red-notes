import { parseCsv } from './parseCsv'

/** Maximum number of CSV rows we will import. Keeps the UI responsive and the
 * resulting note within the importer's size threshold on very large files. */
export const MaxCsvRows = 5000

export function isValidCsvContent(content: string): boolean {
  if (content.trim().length === 0) {
    return false
  }
  try {
    const rows = parseCsv(content)
    // Need at least one non-empty cell to consider this a usable CSV.
    return rows.some((row) => row.some((cell) => cell.trim().length > 0))
  } catch {
    return false
  }
}

/**
 * Parses CSV content and caps it at `MaxCsvRows` rows so a multi-thousand-row
 * file doesn't hang the UI or blow the note size limit. Returns the (possibly
 * truncated) rows and whether truncation occurred.
 */
export function parseCsvCapped(content: string): { rows: string[][]; truncated: boolean } {
  const all = parseCsv(content)
  if (all.length > MaxCsvRows) {
    return { rows: all.slice(0, MaxCsvRows), truncated: true }
  }
  return { rows: all, truncated: false }
}
