/**
 * @jest-environment jsdom
 *
 * Mirrors QrCodeNodeSerialization.spec.ts:
 *   1. StockChartNode serialization round-trips (symbol + range).
 *   2. Old / missing / malformed data degrades gracefully to an empty, editable
 *      block (empty symbol, default range) rather than throwing.
 *   3. The srcdoc builder injects the sanitized symbol and the chosen range.
 */

import { createHeadlessEditor } from '@lexical/headless'

import {
  $createStockChartNode,
  buildStockChartSrcDoc,
  normalize,
  StockChartData,
  StockChartNode,
  STOCK_CHART_DEFAULT_RANGE,
  SerializedStockChartNode,
} from './StockChartNode'

const editor = createHeadlessEditor({
  namespace: 'StockChartNodeSerializationTest',
  nodes: [StockChartNode],
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

const sampleData: StockChartData = {
  version: 1,
  symbol: 'NYSE:TSLA',
  range: 'YTD',
}

describe('StockChartNode serialization round-trip', () => {
  it('round-trips symbol and range without loss', () => {
    const { first, second } = inEditor(() => {
      const first = $createStockChartNode(sampleData).exportJSON()
      const second = StockChartNode.importJSON(first).exportJSON()
      return { first, second }
    })
    expect(second.data).toEqual(first.data)
    expect(second.data.symbol).toBe('NYSE:TSLA')
    expect(second.data.range).toBe('YTD')
  })

  it('keeps type and version stable', () => {
    const json = inEditor(() => $createStockChartNode(sampleData).exportJSON())
    expect(json.type).toBe('stock-chart')
    expect(json.type).toBe(StockChartNode.getType())
    expect(json.version).toBe(1)
  })

  it('is a block node and exposes the symbol as text content', () => {
    const { inline, text } = inEditor(() => {
      const node = $createStockChartNode(sampleData)
      return { inline: node.isInline(), text: node.getTextContent() }
    })
    expect(inline).toBe(false)
    expect(text).toBe('NYSE:TSLA')
  })

  it('degrades gracefully when data is missing (old data)', () => {
    const legacy = { type: 'stock-chart', version: 1 } as unknown as SerializedStockChartNode
    const json = inEditor(() => StockChartNode.importJSON(legacy).exportJSON())
    expect(json.data.symbol).toBe('')
    expect(json.data.range).toBe(STOCK_CHART_DEFAULT_RANGE)
  })

  it('does not throw on a completely malformed data blob', () => {
    const garbage = { type: 'stock-chart', version: 1, data: 'oops' } as unknown as SerializedStockChartNode
    const json = inEditor(() => StockChartNode.importJSON(garbage).exportJSON())
    expect(json.data.symbol).toBe('')
    expect(json.data.range).toBe(STOCK_CHART_DEFAULT_RANGE)
  })
})

describe('normalize', () => {
  it('falls back to the default range for invalid values', () => {
    expect(normalize({ range: '7D' as never }).range).toBe(STOCK_CHART_DEFAULT_RANGE)
  })

  it('returns defaults for null/undefined', () => {
    expect(normalize(null).symbol).toBe('')
    expect(normalize(undefined).range).toBe(STOCK_CHART_DEFAULT_RANGE)
  })
})

describe('buildStockChartSrcDoc', () => {
  it('injects the symbol, range and symbol-overview script', () => {
    const doc = buildStockChartSrcDoc({ version: 1, symbol: 'NYSE:TSLA', range: 'YTD' }, false)
    expect(doc).toContain('NYSE:TSLA')
    expect(doc).toContain('"dateRange":"YTD"')
    expect(doc).toContain('embed-widget-symbol-overview.js')
  })

  it('honors the dark-theme flag', () => {
    const doc = buildStockChartSrcDoc({ version: 1, symbol: 'AAPL', range: '1M' }, true)
    expect(doc).toContain('"colorTheme":"dark"')
  })
})
