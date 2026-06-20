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

/**
 * TradingView "Advanced Chart" embed block.
 *
 * REALISTIC DATA APPROACH / HONEST LIMITATIONS:
 * There is no CORS-friendly, key-free, browser-callable API for live market
 * data, so we do NOT fetch quotes ourselves. Instead we embed TradingView's
 * official, free, public embeddable widget (their `embed-widget-advanced-chart`
 * script). The chart, the data, and all rendering come straight from
 * tradingview.com. This is the same widget any blog embeds and is the realistic
 * working way to show a live, interactive chart in the browser with no server
 * proxy. The tradeoffs:
 *   - It loads third-party content directly from s3.tradingview.com /
 *     tradingview.com, so it is NOT end-to-end encrypted and exposes the request
 *     to TradingView (see the one-time data-exposure note below).
 *   - It requires network access; offline it shows nothing.
 *
 * SECURITY: the widget is rendered inside an iframe via `srcdoc` (an isolated,
 * about:srcdoc document) sandboxed WITHOUT `allow-same-origin`. The framed
 * document therefore runs in an opaque origin and cannot read this app's
 * cookies/storage/DOM. We only inject a sanitized symbol/interval/theme into the
 * TradingView config — never arbitrary user HTML/script.
 */

export const TRADINGVIEW_INTERVALS = ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'] as const
export type TradingViewInterval = (typeof TRADINGVIEW_INTERVALS)[number]

export const TRADINGVIEW_INTERVAL_LABELS: Record<TradingViewInterval, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '240': '4h',
  D: '1D',
  W: '1W',
  M: '1M',
}

export type TradingViewTheme = 'light' | 'dark'

export const TRADINGVIEW_DEFAULT_SYMBOL = 'NASDAQ:AAPL'
export const TRADINGVIEW_DEFAULT_INTERVAL: TradingViewInterval = 'D'
export const TRADINGVIEW_DEFAULT_THEME: TradingViewTheme = 'light'
export const TRADINGVIEW_VERSION = 1

export type TradingViewData = {
  version: number
  /** A TradingView symbol such as "NASDAQ:AAPL" or "AAPL". */
  symbol: string
  interval: TradingViewInterval
  theme: TradingViewTheme
}

const DEFAULT_TRADINGVIEW: TradingViewData = {
  version: TRADINGVIEW_VERSION,
  symbol: '',
  interval: TRADINGVIEW_DEFAULT_INTERVAL,
  theme: TRADINGVIEW_DEFAULT_THEME,
}

function isInterval(value: unknown): value is TradingViewInterval {
  return typeof value === 'string' && (TRADINGVIEW_INTERVALS as readonly string[]).includes(value)
}

function isTheme(value: unknown): value is TradingViewTheme {
  return value === 'light' || value === 'dark'
}

/**
 * Restrict a free-typed symbol to the characters TradingView actually uses
 * (letters, digits, ":", "_", "-", ".") and upper-case it. This keeps anything
 * exotic out of the config we inject into the widget. Returns '' for empty.
 */
export function sanitizeSymbol(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9:_.-]/g, '')
    .slice(0, 40)
}

/**
 * Normalizes data from importJSON with backward-compatible defaults so notes
 * serialized before this block existed (or with malformed/partial data) yield an
 * empty, editable block rather than throwing. Never throws.
 */
export function normalize(data: Partial<TradingViewData> | undefined | null): TradingViewData {
  if (data == null || typeof data !== 'object') {
    return { ...DEFAULT_TRADINGVIEW }
  }
  return {
    version: TRADINGVIEW_VERSION,
    symbol: sanitizeSymbol(data.symbol),
    interval: isInterval(data.interval) ? data.interval : TRADINGVIEW_DEFAULT_INTERVAL,
    theme: isTheme(data.theme) ? data.theme : TRADINGVIEW_DEFAULT_THEME,
  }
}

function clone(data: TradingViewData): TradingViewData {
  return { ...data }
}

/**
 * Build the sandboxed iframe srcdoc that loads TradingView's official
 * embed-widget-advanced-chart script with the given config. Everything injected
 * is a sanitized symbol or a value from a fixed allowlist, JSON-encoded, so no
 * untrusted markup reaches the document. We pin the script to TradingView's
 * canonical CDN host over https.
 */
export function buildTradingViewSrcDoc(data: TradingViewData): string {
  const config = {
    symbol: data.symbol,
    interval: data.interval,
    theme: data.theme,
    style: '1',
    locale: 'en',
    autosize: true,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    save_image: false,
  }
  // JSON.stringify keeps the injected value structured and quote-safe; we then
  // escape the closing-script sequence as defense-in-depth.
  const json = JSON.stringify(config).replace(/<\/script/gi, '<\\/script')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body,#c{margin:0;height:100%;width:100%}</style></head><body><div class="tradingview-widget-container" id="c"><div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>${json}</script></div></body></html>`
}

const NOTE_DISMISS_KEY = 'sn-super-tradingview-note-dismissed'

function noteDismissed(): boolean {
  try {
    return localStorage.getItem(NOTE_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function TradingViewComponent({
  data,
  nodeKey,
}: {
  data: TradingViewData
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [symbolDraft, setSymbolDraft] = useState(data.symbol)
  const [editing, setEditing] = useState(!data.symbol)
  const [showNote, setShowNote] = useState(!noteDismissed())

  useEffect(() => {
    setSymbolDraft(data.symbol)
  }, [data.symbol])

  const mutate = useCallback(
    (fn: (draft: TradingViewData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isTradingViewNode(node)) {
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

  const setInterval = (interval: TradingViewInterval) => mutate((d) => (d.interval = interval))
  const setTheme = (theme: TradingViewTheme) => mutate((d) => (d.theme = theme))

  const dismissNote = useCallback(() => {
    setShowNote(false)
    try {
      localStorage.setItem(NOTE_DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
  }, [])

  // Re-mount the iframe whenever the config changes so the embed script re-runs
  // with the new symbol/interval/theme.
  const srcDoc = useMemo(() => (data.symbol ? buildTradingViewSrcDoc(data) : ''), [data])
  const reloadKey = `${data.symbol}|${data.interval}|${data.theme}`

  return (
    <div className="my-2 rounded border border-border bg-default" data-tradingview-block="true">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="font-semibold">TradingView chart</span>
        <div className="flex items-center gap-1">
          {!editing && data.symbol ? (
            <>
              <select
                className="rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info"
                value={data.interval}
                aria-label="Interval"
                onChange={(e) => setInterval(e.target.value as TradingViewInterval)}
              >
                {TRADINGVIEW_INTERVALS.map((iv) => (
                  <option key={iv} value={iv}>
                    {TRADINGVIEW_INTERVAL_LABELS[iv]}
                  </option>
                ))}
              </select>
              <select
                className="rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info"
                value={data.theme}
                aria-label="Theme"
                onChange={(e) => setTheme(e.target.value as TradingViewTheme)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </>
          ) : null}
          <button
            type="button"
            className="rounded px-2 py-0.5 hover:bg-contrast"
            onClick={() => (editing ? commitSymbol(symbolDraft) : setEditing(true))}
          >
            {editing ? 'Load' : 'Edit'}
          </button>
        </div>
      </div>

      {showNote ? (
        <div className="flex items-start justify-between gap-2 border-b border-border bg-contrast px-2 py-1 text-xs text-passive-0">
          <span>
            This block loads a live chart directly from tradingview.com. The request is sent to TradingView and
            is not end-to-end encrypted.
          </span>
          <button type="button" className="flex-shrink-0 rounded px-2 py-0.5 hover:bg-default" onClick={dismissNote}>
            Got it
          </button>
        </div>
      ) : null}

      {editing ? (
        <div className="p-2">
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
            placeholder="Enter a symbol, e.g. NASDAQ:AAPL or BITSTAMP:BTCUSD"
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
            Use TradingView&apos;s EXCHANGE:TICKER format for best results (a bare ticker may resolve ambiguously).
          </p>
        </div>
      ) : srcDoc ? (
        <div className="h-96 w-full">
          {/* Sandboxed WITHOUT allow-same-origin: the TradingView document runs in
              an opaque origin and cannot touch this app's storage/cookies/DOM.
              allow-scripts is required for the widget; allow-popups lets the
              widget's "open on TradingView" links work. no-referrer avoids
              leaking the note URL. */}
          <iframe
            key={reloadKey}
            title={`TradingView chart for ${data.symbol}`}
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

export type SerializedTradingViewNode = Spread<{ data: TradingViewData }, SerializedLexicalNode>

export class TradingViewNode extends DecoratorNode<React.JSX.Element> {
  __data: TradingViewData

  static getType(): string {
    return 'tradingview'
  }

  static clone(node: TradingViewNode): TradingViewNode {
    return new TradingViewNode(node.__data, node.__key)
  }

  constructor(data: TradingViewData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedTradingViewNode): TradingViewNode {
    return $createTradingViewNode(normalize(serializedNode.data))
  }

  exportJSON(): SerializedTradingViewNode {
    return { type: 'tradingview', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): TradingViewData {
    return this.getLatest().__data
  }

  setData(data: TradingViewData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.symbol
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <TradingViewComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createTradingViewNode(data: TradingViewData = DEFAULT_TRADINGVIEW): TradingViewNode {
  return new TradingViewNode(clone(data))
}

export function $isTradingViewNode(node: LexicalNode | null | undefined): node is TradingViewNode {
  return node instanceof TradingViewNode
}
