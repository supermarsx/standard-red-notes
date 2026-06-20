/**
 * @jest-environment jsdom
 *
 * Covers the SQL query block WITHOUT loading the heavy WASM sql.js engine:
 *   1. SqlQueryNode serialization round-trips (setup + query).
 *   2. Old / missing / malformed data degrades gracefully (empty strings, never
 *      throws). Missing fields fall back to '' rather than resurrecting demo
 *      data.
 *   3. The pure shapeSqlResult / formatCell helpers handle empty, multi-result,
 *      null/blob and malformed inputs.
 *
 * The result-shaping helpers live in sqlQueryResult.ts precisely so they can be
 * tested here without sql.js.
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createSqlQueryNode,
  normalize,
  SqlQueryData,
  SqlQueryNode,
  SerializedSqlQueryNode,
} from './SqlQueryNode'
import { formatCell, shapeSqlResult } from './sqlQueryResult'

const editor = createHeadlessEditor({
  namespace: 'SqlQueryNodeSerializationTest',
  nodes: [SqlQueryNode],
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

const sampleData: SqlQueryData = {
  version: 1,
  setup: 'CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 2);',
  query: 'SELECT * FROM t;',
}

describe('SqlQueryNode serialization round-trip', () => {
  it('round-trips setup and query without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createSqlQueryNode(sampleData).exportJSON()
      const second = SqlQueryNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.setup).toBe(sampleData.setup)
    expect(second.data.query).toBe(sampleData.query)
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createSqlQueryNode(sampleData).exportJSON())
    expect(json.type).toBe('sql-query')
    expect(json.type).toBe(SqlQueryNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node and exposes setup+query as text content', () => {
    const { inline, text } = inEditor(() => {
      const node = $createSqlQueryNode(sampleData)
      return { inline: node.isInline(), text: node.getTextContent() }
    })
    expect(inline).toBe(false)
    expect(text).toContain('CREATE TABLE')
    expect(text).toContain('SELECT * FROM t')
  })

  it('degrades gracefully when data is entirely missing (old data)', () => {
    // No `data` key at all (undefined) is unrecoverable, so we fall back to the
    // editable demo defaults rather than throwing.
    const legacy = { type: 'sql-query', version: 1 } as unknown as SerializedSqlQueryNode
    const json = inEditor(() => SqlQueryNode.importJSON(legacy).exportJSON())
    expect(json.data.setup).toContain('CREATE TABLE')
    expect(json.data.query).toContain('SELECT')
  })

  it('does not throw on a completely malformed (non-object) data blob', () => {
    // A non-object blob is unrecoverable, so we fall back to the editable demo
    // defaults rather than throwing (mirrors the QrCode/decorator pattern).
    const garbage = { type: 'sql-query', version: 1, data: 7 } as unknown as SerializedSqlQueryNode
    const json = inEditor(() => SqlQueryNode.importJSON(garbage).exportJSON())
    expect(json.data.setup).toContain('CREATE TABLE')
    expect(json.data.query).toContain('SELECT')
  })

  it('does not resurrect demo data for partially-missing fields', () => {
    const partial = { type: 'sql-query', version: 1, data: { setup: 'SELECT 1' } } as unknown as SerializedSqlQueryNode
    const json = inEditor(() => SqlQueryNode.importJSON(partial).exportJSON())
    expect(json.data.setup).toBe('SELECT 1')
    expect(json.data.query).toBe('')
  })
})

describe('normalize', () => {
  it('falls back to demo defaults only for null/undefined', () => {
    expect(normalize(null).setup).toContain('CREATE TABLE')
    expect(normalize(undefined).query).toContain('SELECT')
  })

  it('coerces non-string fields to empty strings', () => {
    expect(normalize({ setup: 5 as never, query: {} as never })).toEqual({
      version: 1,
      setup: '',
      query: '',
    })
  })
})

describe('formatCell', () => {
  it('renders null/undefined as NULL', () => {
    expect(formatCell(null)).toBe('NULL')
    expect(formatCell(undefined)).toBe('NULL')
  })

  it('renders numbers and strings as-is', () => {
    expect(formatCell(42)).toBe('42')
    expect(formatCell('hi')).toBe('hi')
  })

  it('summarizes blobs', () => {
    expect(formatCell(new Uint8Array([1, 2, 3]))).toBe('[blob 3 bytes]')
  })
})

describe('shapeSqlResult', () => {
  it('reports empty for null/empty results', () => {
    expect(shapeSqlResult(null)).toEqual({ columns: [], rows: [], rowCount: 0, empty: true })
    expect(shapeSqlResult([]).empty).toBe(true)
  })

  it('shapes a single result set into columns + stringified rows', () => {
    const shaped = shapeSqlResult([
      { columns: ['name', 'age'], values: [['Ada', 36], ['Grace', null]] },
    ])
    expect(shaped.columns).toEqual(['name', 'age'])
    expect(shaped.rows).toEqual([
      ['Ada', '36'],
      ['Grace', 'NULL'],
    ])
    expect(shaped.rowCount).toBe(2)
    expect(shaped.empty).toBe(false)
  })

  it('picks the last result set that has columns', () => {
    const shaped = shapeSqlResult([
      { columns: ['x'], values: [[1]] },
      { columns: ['y'], values: [[9]] },
    ])
    expect(shaped.columns).toEqual(['y'])
    expect(shaped.rows).toEqual([['9']])
  })

  it('treats a result set with columns but no rows as empty', () => {
    const shaped = shapeSqlResult([{ columns: ['a'], values: [] }])
    expect(shaped.empty).toBe(true)
    expect(shaped.rowCount).toBe(0)
  })
})
