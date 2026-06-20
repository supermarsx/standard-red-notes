import { normalizeRows } from './parseCsv'

/**
 * Escapes a single Markdown table cell value: pipes are escaped so they don't
 * break the column layout, and embedded newlines are converted to <br> (a hard
 * newline would otherwise terminate the table row).
 */
function escapeCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/**
 * Converts parsed CSV rows into a GitHub-flavoured Markdown table. The first
 * row is treated as the header. Ragged rows are normalised to the header width.
 * Returns an empty string when there are no rows.
 */
export function csvToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) {
    return ''
  }

  // Column count is the widest row so no data is silently dropped.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (width === 0) {
    return ''
  }

  const normalized = normalizeRows(rows, width)

  const [header, ...body] = normalized

  const headerLine = `| ${header.map(escapeCell).join(' | ')} |`
  const separatorLine = `| ${new Array(width).fill('---').join(' | ')} |`
  const bodyLines = body.map((row) => `| ${row.map(escapeCell).join(' | ')} |`)

  return [headerLine, separatorLine, ...bodyLines].join('\n')
}
