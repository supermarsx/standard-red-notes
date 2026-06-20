import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { sanitizeSymbol } from './TradingViewNode'

/**
 * Stock-chart block with selectable date ranges (1D / 1M / YTD / 1Y / 5Y / All).
 *
 * HONEST LIMITATION — there is NO official, free, embeddable Yahoo Finance
 * widget, and Yahoo's quote/chart JSON API (query1.finance.yahoo.com) is
 * CORS-blocked from browsers, so it CANNOT be called directly from this web app
 * without a server-side proxy (which this web-only block does not have). We
 * therefore do NOT fetch Yahoo data. Instead we render the chart via
 * TradingView's official, free **symbol-overview** embeddable widget, which
 * natively supports date ranges and keys to the entered symbol. The data and
 * rendering come entirely from tradingview.com — this is real, working live data
 * over an embeddable widget, NOT faked, but it is TradingView's data, not
 * Yahoo's, and it loads third-party content directly from tradingview.com.
 *
 * SECURITY: same hardening as the TradingView block — the widget runs inside an
 * iframe via `srcdoc` sandboxed WITHOUT `allow-same-origin` (opaque origin), and
 * only a sanitized symbol + an allowlisted range are injected into the config.
 */

export const STOCK_CHART_RANGES = ['1D', '1M', 'YTD', '12M', '60M', 'ALL'] as const
export type StockChartRange = (typeof STOCK_CHART_RANGES)[number]

export const STOCK_CHART_RANGE_LABELS: Record<StockChartRange, string> = {
  '1D': '1D',
  '1M': '1M',
  YTD: 'YTD',
  '12M': '1Y',
  '60M': '5Y',
  ALL: 'All',
}

export const STOCK_CHART_DEFAULT_RANGE: StockChartRange = '12M'
export const STOCK_CHART_VERSION = 1

export type StockChartData = {
  version: number
  symbol: string
  range: StockChartRange
}

const DEFAULT_STOCK_CHART: StockChartData = {
  version: STOCK_CHART_VERSION,
  symbol: '',
  range: STOCK_CHART_DEFAULT_RANGE,
}

function isRange(value: unknown): value is StockChartRange {
  return typeof value === 'string' && (STOCK_CHART_RANGES as readonly string[]).includes(value)
}

/**
 * Normalizes data from importJSON with backward-compatible defaults so old or
 * malformed data yields an empty, editable block rather than throwing. Never
 * throws.
 */
export function normalize(data: Partial<StockChartData> | undefined | null): StockChartData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_STOCK_CHART }
  }
  return {
    version: STOCK_CHART_VERSION,
    symbol: sanitizeSymbol(data.symbol),
    range: isRange(data.range) ? data.range : STOCK_CHART_DEFAULT_RANGE,
  }
}

function clone(data: StockChartData): StockChartData {
  return { ...data }
}

function prefersDark(): boolean {
  try {
    const bg = getComputedStyle(document.body).backgroundColor
    const match = bg.match(/\d+/g)
    if (match && match.length >= 3) {
      const [r, g, b] = match.map(Number)
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
    }
  } catch {
    /* ignore */
  }
  return false
}

/**
 * Build the sandboxed iframe srcdoc loading TradingView's official
 * embed-widget-symbol-overview script (which supports `dateRange`). Only the
 * sanitized symbol and an allowlisted range reach the JSON-encoded config.
 */
export function buildStockChartSrcDoc(data: StockChartData, dark: boolean): string {
  const config = {
    symbols: [[data.symbol]],
    chartOnly: false,
    width: '100%',
    height: '100%',
    locale: 'en',
    colorTheme: dark ? 'dark' : 'light',
    autosize: true,
    showVolume: false,
    dateRanges: undefined,
    // symbol-overview uses a single active range; expose the user's choice.
    dateRange: data.range,
    isTransparent: true,
  }
  const json = JSON.stringify(config).replace(/<\/script/gi, '<\\/script')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body,#c{margin:0;height:100%;width:100%}</style></head><body><div class="tradingview-widget-container" id="c"><div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js" async>${json}</script></div></body></html>`
}

function StockChartComponent({
  data,
  nodeKey,
}: {
  data: StockChartData
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [symbolDraft, setSymbolDraft] = useState(data.symbol)
  const [editing, setEditing] = useState(!data.symbol)

  useEffect(() => {
    setSymbolDraft(data.symbol)
  }, [data.symbol])

  const mutate = useCallback(
    (fn: (draft: StockChartData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isStockChartNode(node)) {
          const next = clone(node.getData())
          fn(next)
          node.setData(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const commitSymbol = useCallback(
    (raw: string) => {
      const symbol = sanitizeSymbol(raw)
      mutate((d) => (d.symbol = symbol))
      if (symbol) {
        setEditing(false)
      }
    },
    [mutate],
  )

  const setRange = (range: StockChartRange) => mutate((d) => (d.range = range))

  const dark = prefersDark()
  const srcDoc = useMemo(
    () => (data.symbol ? buildStockChartSrcDoc(data, dark) : ''),
    [data, dark],
  )
  const reloadKey = `${data.symbol}|${data.range}|${dark}`

  return (
    <div className="my-2 rounded border border-border bg-default" data-stock-chart-block="true">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">Stock chart</span>
        <div className="flex flex-wrap items-center gap-1">
          {!editing && data.symbol
            ? STOCK_CHART_RANGES.map((range) => (
                <button
                  key={range}
                  type="button"
                  className="rounded px-2 py-0.5 hover:bg-contrast aria-pressed:bg-contrast aria-pressed:text-text"
                  aria-pressed={data.range === range}
                  onClick={() => setRange(range)}
                >
                  {STOCK_CHART_RANGE_LABELS[range]}
                </button>
              ))
            : null}
          <button
            type="button"
            className="rounded px-2 py-0.5 hover:bg-contrast"
            onClick={() => (editing ? commitSymbol(symbolDraft) : setEditing(true))}
          >
            {editing ? 'Load' : 'Edit'}
          </button>
        </div>
      </div>

      {editing ? (
        <div className="p-2">
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
            placeholder="Enter a symbol, e.g. NASDAQ:AAPL or AAPL"
            value={symbolDraft}
            onChange={(e) => setSymbolDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitSymbol(symbolDraft)
              }
            }}
            autoFocus
          />
          <p className="mt-1 text-xs text-passive-1">
            Charts render via TradingView&apos;s embeddable widget. Yahoo Finance has no free embeddable widget and
            its API is CORS-blocked from the browser, so this shows TradingView data, not Yahoo data.
          </p>
        </div>
      ) : srcDoc ? (
        <div className="h-80 w-full">
          {/* Sandboxed WITHOUT allow-same-origin (opaque origin). allow-scripts is
              required for the widget; allow-popups for its "open on TradingView"
              links. no-referrer avoids leaking the note URL. */}
          <iframe
            key={reloadKey}
            title={`Stock chart for ${data.symbol}`}
            srcDoc={srcDoc}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        </div>
      ) : (
        <div className="p-2 text-sm text-danger">Enter a symbol to load a chart.</div>
      )}
    </div>
  )
}

export type SerializedStockChartNode = Spread<{ data: StockChartData }, SerializedLexicalNode>

export class StockChartNode extends DecoratorNode<React.JSX.Element> {
  __data: StockChartData

  static getType(): string {
    return 'stock-chart'
  }

  static clone(node: StockChartNode): StockChartNode {
    return new StockChartNode(node.__data, node.__key)
  }

  constructor(data: StockChartData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedStockChartNode): StockChartNode {
    return $createStockChartNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedStockChartNode {
    return { type: 'stock-chart', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): StockChartData {
    return this.getLatest().__data
  }

  setData(data: StockChartData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.symbol
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <StockChartComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createStockChartNode(data: StockChartData = DEFAULT_STOCK_CHART): StockChartNode {
  return new StockChartNode(clone(data))
}

export function $isStockChartNode(node: LexicalNode | null | undefined): node is StockChartNode {
  return node instanceof StockChartNode
}
