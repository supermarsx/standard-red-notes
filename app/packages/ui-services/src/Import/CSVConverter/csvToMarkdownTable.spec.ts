import { csvToMarkdownTable } from './csvToMarkdownTable'
import { parseCsv } from './parseCsv'

describe('csvToMarkdownTable', () => {
  it('returns an empty string for no rows', () => {
    expect(csvToMarkdownTable([])).toBe('')
  })

  it('builds a GitHub-style table with the first row as header', () => {
    const rows = [
      ['Name', 'Age'],
      ['Ada', '36'],
      ['Linus', '54'],
    ]
    expect(csvToMarkdownTable(rows)).toBe(
      ['| Name | Age |', '| --- | --- |', '| Ada | 36 |', '| Linus | 54 |'].join('\n'),
    )
  })

  it('escapes pipe characters in cells', () => {
    const rows = [
      ['a|b', 'c'],
      ['d', 'e|f'],
    ]
    expect(csvToMarkdownTable(rows)).toBe(['| a\\|b | c |', '| --- | --- |', '| d | e\\|f |'].join('\n'))
  })

  it('converts embedded newlines to <br>', () => {
    const rows = [
      ['col'],
      ['line1\nline2'],
    ]
    expect(csvToMarkdownTable(rows)).toBe(['| col |', '| --- |', '| line1<br>line2 |'].join('\n'))
  })

  it('pads ragged rows to the widest row width', () => {
    const rows = [['h1', 'h2', 'h3'], ['only-one'], ['a', 'b']]
    expect(csvToMarkdownTable(rows)).toBe(
      ['| h1 | h2 | h3 |', '| --- | --- | --- |', '| only-one |  |  |', '| a | b |  |'].join('\n'),
    )
  })

  it('round-trips parsed CSV with quoted commas into one table cell', () => {
    const rows = parseCsv('name,note\n"Smith, John",hi')
    expect(csvToMarkdownTable(rows)).toBe(['| name | note |', '| --- | --- |', '| Smith, John | hi |'].join('\n'))
  })
})
