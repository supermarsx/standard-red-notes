/**
 * A small, correct CSV parser (RFC 4180-ish).
 *
 * Handles:
 *  - quoted fields: `"a,b"` -> `a,b`
 *  - escaped quotes inside quoted fields: `"she said ""hi"""` -> `she said "hi"`
 *  - commas inside quoted fields
 *  - newlines (LF / CRLF) inside quoted fields
 *  - CRLF, CR and LF record separators
 *  - a trailing newline at the end of the file (does not produce an extra empty row)
 *  - ragged rows (rows are returned exactly as parsed; callers normalise width)
 *
 * Intentionally NOT a naive `split(',')`. Returns an array of rows, each a
 * string[] of field values.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = []

  if (input.length === 0) {
    return rows
  }

  // Strip a leading UTF-8 BOM if present.
  let text = input
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }

  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  const len = text.length

  const pushField = () => {
    row.push(field)
    field = ''
  }

  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < len) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote ("") is an escaped quote.
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        // Otherwise the quoted section ends here.
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }

    if (char === delimiter) {
      pushField()
      i += 1
      continue
    }

    if (char === '\r') {
      // Treat CRLF and a lone CR as a single record separator.
      pushRow()
      if (text[i + 1] === '\n') {
        i += 2
      } else {
        i += 1
      }
      continue
    }

    if (char === '\n') {
      pushRow()
      i += 1
      continue
    }

    field += char
    i += 1
  }

  // Flush the final field/row unless the input ended exactly on a record
  // separator (in which case there's no trailing record to emit).
  const endedOnSeparator = field === '' && row.length === 0 && rows.length > 0
  if (!endedOnSeparator) {
    pushRow()
  }

  return rows
}

/**
 * Normalises ragged rows so every row has exactly `width` columns. Rows that are
 * too short are padded with empty strings; rows that are too long are truncated.
 */
export function normalizeRows(rows: string[][], width: number): string[][] {
  return rows.map((row) => {
    if (row.length === width) {
      return row
    }
    if (row.length > width) {
      return row.slice(0, width)
    }
    return [...row, ...new Array(width - row.length).fill('')]
  })
}
