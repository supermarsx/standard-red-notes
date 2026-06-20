import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { shapeSqlResult, SqlResultTable, SqlExecResult } from './sqlQueryResult'

/**
 * In-browser SQL query block.
 *
 * WHAT IT DOES / HONEST LIMITATION: the user pastes their OWN data (as a CSV/JSON
 * "setup" SQL — e.g. a CREATE TABLE + INSERTs, or any SQL DDL) and a query, and
 * we run it against a fresh in-memory WASM SQLite database (`sql.js`) created
 * locally in the browser. This is a LOCAL, sandboxed database over the block's
 * own embedded data ONLY. It does NOT connect to any external/real database, the
 * network, the filesystem, or other notes. Each run starts from an empty DB, so
 * results are fully reproducible from the text stored in the note.
 *
 * SECURITY: sql.js runs the SQL inside its own WASM sandbox; we never `eval`
 * user input as JavaScript. The engine has no filesystem/network access in the
 * browser. We surface SQL errors inline instead of throwing.
 *
 * sql.js (and its ~1.5MB WASM) is lazily loaded only when a query is actually
 * run, so it never bloats the initial editor bundle.
 */

export const SQL_QUERY_VERSION = 1

const DEFAULT_SETUP = `CREATE TABLE people (id INTEGER, name TEXT, age INTEGER);
INSERT INTO people VALUES (1, 'Ada', 36), (2, 'Linus', 54), (3, 'Grace', 85);`

const DEFAULT_QUERY = 'SELECT name, age FROM people WHERE age > 40 ORDER BY age DESC;'

export type SqlQueryData = {
  version: number
  /** DDL/DML that defines and populates the local tables (the "data"). */
  setup: string
  /** The query to run against the local database. */
  query: string
}

const DEFAULT_SQL_QUERY: SqlQueryData = {
  version: SQL_QUERY_VERSION,
  setup: DEFAULT_SETUP,
  query: DEFAULT_QUERY,
}

/**
 * Normalizes data from importJSON with backward-compatible defaults so old or
 * malformed data yields an editable block rather than throwing. Missing fields
 * fall back to empty strings (not the demo defaults) so we never silently
 * resurrect example data over a user's intentionally-cleared block. Never throws.
 */
export function normalize(data: Partial<SqlQueryData> | undefined | null): SqlQueryData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_SQL_QUERY }
  }
  return {
    version: SQL_QUERY_VERSION,
    setup: typeof data.setup === 'string' ? data.setup : '',
    query: typeof data.query === 'string' ? data.query : '',
  }
}

function clone(data: SqlQueryData): SqlQueryData {
  return { ...data }
}

// Lazily-loaded sql.js singleton so the WASM engine is code-split and only
// fetched when a query is actually run.
type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | null) => {
    exec: (sql: string) => SqlExecResult[]
    close: () => void
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = import('sql.js').then((mod) => {
      const initSqlJs = (mod.default ?? mod) as unknown as (config?: {
        locateFile?: (file: string) => string
      }) => Promise<SqlJsStatic>
      // The sql.js JS shim fetches its companion `sql-wasm.wasm` at runtime. We
      // resolve it from the matching jsDelivr CDN build. (sql.js ships no
      // network/filesystem access of its own; this only fetches the engine.)
      return initSqlJs({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/${file}`,
      })
    })
  }
  return sqlJsPromise
}

/**
 * Run the setup SQL then the query against a fresh in-memory database. Returns a
 * shaped result table, or throws a friendly Error for the UI to show. The DB is
 * always closed to free WASM memory.
 */
export async function runSqlQuery(setup: string, query: string): Promise<SqlResultTable> {
  const SQL = await loadSqlJs()
  const db = new SQL.Database()
  try {
    if (setup.trim()) {
      db.exec(setup)
    }
    if (!query.trim()) {
      return { columns: [], rows: [], rowCount: 0, empty: true }
    }
    const results = db.exec(query)
    return shapeSqlResult(results)
  } finally {
    db.close()
  }
}

function SqlQueryComponent({
  data,
  nodeKey,
}: {
  data: SqlQueryData
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [setupDraft, setSetupDraft] = useState(data.setup)
  const [queryDraft, setQueryDraft] = useState(data.query)
  const [result, setResult] = useState<SqlResultTable | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    setSetupDraft(data.setup)
  }, [data.setup])
  useEffect(() => {
    setQueryDraft(data.query)
  }, [data.query])

  const persist = useCallback(
    (setup: string, query: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isSqlQueryNode(node)) {
          node.setData({ version: SQL_QUERY_VERSION, setup, query })
        }
      })
    },
    [editor, nodeKey],
  )

  const run = useCallback(async () => {
    persist(setupDraft, queryDraft)
    setRunning(true)
    setError(null)
    try {
      const shaped = await runSqlQuery(setupDraft, queryDraft)
      if (mountedRef.current) {
        setResult(shaped)
        setError(null)
      }
    } catch (e) {
      if (mountedRef.current) {
        setResult(null)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (mountedRef.current) {
        setRunning(false)
      }
    }
  }, [persist, setupDraft, queryDraft])

  return (
    <div className="my-2 rounded border border-border bg-default" data-sql-query-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">SQL query (local, in-browser)</span>
        <button
          type="button"
          className="rounded bg-info px-2 py-0.5 text-info-contrast disabled:opacity-50"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? 'Running…' : 'Run query'}
        </button>
      </div>

      <div className="flex flex-col gap-2 p-2">
        <label className="flex flex-col gap-1 text-xs text-passive-1">
          Data (CREATE TABLE / INSERT, or any setup SQL)
          <textarea
            className="w-full resize-y rounded border border-border bg-default p-2 font-mono text-sm text-foreground outline-none focus:border-info"
            rows={Math.max(3, Math.min(10, setupDraft.split('\n').length + 1))}
            value={setupDraft}
            spellCheck={false}
            placeholder="CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 2);"
            onChange={(e) => setSetupDraft(e.target.value)}
            onBlur={(e) => persist(e.target.value, queryDraft)}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-passive-1">
          Query
          <textarea
            className="w-full resize-y rounded border border-border bg-default p-2 font-mono text-sm text-foreground outline-none focus:border-info"
            rows={Math.max(2, Math.min(8, queryDraft.split('\n').length + 1))}
            value={queryDraft}
            spellCheck={false}
            placeholder="SELECT * FROM t;"
            onChange={(e) => setQueryDraft(e.target.value)}
            onBlur={(e) => persist(setupDraft, e.target.value)}
          />
        </label>

        <p className="text-xs text-passive-1">
          Runs against a fresh in-memory SQLite database built only from the data above. It does not connect to any
          external or real database.
        </p>

        {error ? (
          <div className="rounded border border-danger bg-contrast p-2 font-mono text-xs text-danger">{error}</div>
        ) : null}

        {result && !error ? (
          result.empty ? (
            <div className="text-xs text-passive-1">
              Query executed successfully. No rows returned.
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {result.columns.map((col, i) => (
                      <th
                        key={i}
                        className="border border-border bg-contrast px-2 py-1 text-left font-semibold text-foreground"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="border border-border px-2 py-1 text-foreground">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1 text-xs text-passive-1">
                {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'}
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}

export type SerializedSqlQueryNode = Spread<{ data: SqlQueryData }, SerializedLexicalNode>

export class SqlQueryNode extends DecoratorNode<React.JSX.Element> {
  __data: SqlQueryData

  static getType(): string {
    return 'sql-query'
  }

  static clone(node: SqlQueryNode): SqlQueryNode {
    return new SqlQueryNode(node.__data, node.__key)
  }

  constructor(data: SqlQueryData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedSqlQueryNode): SqlQueryNode {
    return $createSqlQueryNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedSqlQueryNode {
    return { type: 'sql-query', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): SqlQueryData {
    return this.getLatest().__data
  }

  setData(data: SqlQueryData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return [this.__data.setup, this.__data.query].filter(Boolean).join('\n\n')
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <SqlQueryComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createSqlQueryNode(data: SqlQueryData = DEFAULT_SQL_QUERY): SqlQueryNode {
  return new SqlQueryNode(clone(data))
}

export function $isSqlQueryNode(node: LexicalNode | null | undefined): node is SqlQueryNode {
  return node instanceof SqlQueryNode
}
