/**
 * @jest-environment jsdom
 *
 * Mirrors QrCodeNodeSerialization.spec.ts:
 *   1. TradingViewNode serialization round-trips (exportJSON -> importJSON ->
 *      exportJSON) including symbol, interval and theme.
 *   2. Old / missing / malformed data degrades gracefully to an empty, editable
 *      block (empty symbol, default interval/theme) rather than throwing.
 *   3. The symbol sanitizer and srcdoc builder behave safely.
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createTradingViewNode,
  buildTradingViewSrcDoc,
  normalize,
  sanitizeSymbol,
  TradingViewData,
  TradingViewNode,
  TRADINGVIEW_DEFAULT_INTERVAL,
  TRADINGVIEW_DEFAULT_THEME,
  SerializedTradingViewNode,
} from './TradingViewNode'

const editor = createHeadlessEditor({
  namespace: 'TradingViewNodeSerializationTest',
  nodes: [TradingViewNode],
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

const sampleData: TradingViewData = {
  version: 1,
  symbol: 'NASDAQ:AAPL',
  interval: '60',
  theme: 'dark',
}

describe('TradingViewNode serialization round-trip', () => {
  it('round-trips symbol, interval and theme without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createTradingViewNode(sampleData).exportJSON()
      const second = TradingViewNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.symbol).toBe('NASDAQ:AAPL')
    expect(second.data.interval).toBe('60')
    expect(second.data.theme).toBe('dark')
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createTradingViewNode(sampleData).exportJSON())
    expect(json.type).toBe('tradingview')
    expect(json.type).toBe(TradingViewNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node and exposes the symbol as text content', () => {
    const { inline, text } = inEditor(() => {
      const node = $createTradingViewNode(sampleData)
      return { inline: node.isInline(), text: node.getTextContent() }
    })
    expect(inline).toBe(false)
    expect(text).toBe('NASDAQ:AAPL')
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'tradingview', version: 1 } as unknown as SerializedTradingViewNode
    const json = inEditor(() => TradingViewNode.importJSON(legacy).exportJSON())
    expect(json.data.symbol).toBe('')
    expect(json.data.interval).toBe(TRADINGVIEW_DEFAULT_INTERVAL)
    expect(json.data.theme).toBe(TRADINGVIEW_DEFAULT_THEME)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'tradingview', version: 1, data: 42 } as unknown as SerializedTradingViewNode
    const json = inEditor(() => TradingViewNode.importJSON(garbage).exportJSON())
    expect(json.data.symbol).toBe('')
    expect(json.data.interval).toBe(TRADINGVIEW_DEFAULT_INTERVAL)
    expect(json.data.theme).toBe(TRADINGVIEW_DEFAULT_THEME)
  })
})

describe('normalize', () => {
  it('falls back to defaults for invalid interval/theme', () => {
    expect(normalize({ interval: '999' as never }).interval).toBe(TRADINGVIEW_DEFAULT_INTERVAL)
    expect(normalize({ theme: 'neon' as never }).theme).toBe(TRADINGVIEW_DEFAULT_THEME)
  })

  it('returns defaults for null/undefined', () => {
    expect(normalize(null).symbol).toBe('')
    expect(normalize(undefined).interval).toBe(TRADINGVIEW_DEFAULT_INTERVAL)
  })
})

describe('sanitizeSymbol', () => {
  it('upper-cases and strips disallowed characters', () => {
    expect(sanitizeSymbol('  nasdaq:aapl  ')).toBe('NASDAQ:AAPL')
    expect(sanitizeSymbol('AA PL<script>')).toBe('AAPLSCRIPT')
    expect(sanitizeSymbol('BTC-USD.X')).toBe('BTC-USD.X')
  })

  it('returns empty string for non-strings', () => {
    expect(sanitizeSymbol(undefined)).toBe('')
    expect(sanitizeSymbol(123 as never)).toBe('')
  })
})

describe('buildTradingViewSrcDoc', () => {
  it('embeds the sanitized symbol and escapes closing script tags', () => {
    const doc = buildTradingViewSrcDoc({
      version: 1,
      symbol: 'NASDAQ:AAPL',
      interval: 'D',
      theme: 'light',
    })
    expect(doc).toContain('NASDAQ:AAPL')
    expect(doc).toContain('embed-widget-advanced-chart.js')
    // No raw closing-script sequence inside the injected JSON config.
    expect(doc).not.toContain('"</script')
  })
})
