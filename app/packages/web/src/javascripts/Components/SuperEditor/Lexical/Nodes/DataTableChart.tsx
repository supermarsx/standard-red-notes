import { ReactElement, useEffect, useRef, useState } from 'react'
import type { EChartsType } from 'echarts'
import { ColumnType, numericValue } from './DataTableCellTypes'

export type DataTableChartType = 'bar' | 'line' | 'pie'

export type DataTableChartConfig = {
  type: DataTableChartType
  xColumn: number
  yColumns: number[]
}

type Props = {
  columns: string[]
  rows: string[][]
  types: ColumnType[]
  config: DataTableChartConfig
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildOption = (columns: string[], rows: string[][], types: ColumnType[], config: DataTableChartConfig, textColor: string): any => {
  const { type, xColumn, yColumns } = config
  const baseText = { color: textColor }

  if (type === 'pie') {
    const valueCol = yColumns[0] ?? xColumn
    const data = rows
      .map((row) => ({
        name: row[xColumn] ?? '',
        value: numericValue(row[valueCol] ?? '', types[valueCol] ?? 'number'),
      }))
      .filter((d) => Number.isFinite(d.value))
    return {
      textStyle: baseText,
      tooltip: { trigger: 'item' },
      legend: { type: 'scroll', textStyle: baseText },
      series: [{ type: 'pie', radius: '65%', data, label: { color: textColor } }],
    }
  }

  const categories = rows.map((row) => row[xColumn] ?? '')
  const series = yColumns.map((col) => ({
    name: columns[col] ?? `Series ${col + 1}`,
    type,
    data: rows.map((row) => {
      const value = numericValue(row[col] ?? '', types[col] ?? 'number')
      return Number.isFinite(value) ? value : null
    }),
  }))

  return {
    textStyle: baseText,
    tooltip: { trigger: 'axis' },
    legend: { type: 'scroll', textStyle: baseText },
    grid: { left: 56, right: 20, top: 32, bottom: 44 },
    xAxis: { type: 'category', data: categories, axisLabel: { color: textColor } },
    yAxis: { type: 'value', axisLabel: { color: textColor } },
    series,
  }
}

/**
 * Renders a bar/line/pie chart from the data table's columns using ECharts,
 * which is dynamically imported so it stays out of the main bundle (matching the
 * editor's other heavy visualization blocks).
 */
export default function DataTableChart({ columns, rows, types, config }: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [lib, setLib] = useState<typeof import('echarts') | null>(null)
  const [failed, setFailed] = useState(false)

  // Only re-render the chart when the data/config actually changes (the parent
  // passes fresh array references every render).
  const signature = JSON.stringify({ columns, rows, types, config })

  useEffect(() => {
    let active = true
    import('echarts')
      .then((module) => {
        if (active) {
          setLib(module)
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true)
        }
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!lib || !container) {
      return
    }
    const textColor = getComputedStyle(container).color || '#000'
    const chart: EChartsType = lib.init(container, undefined, { renderer: 'svg' })
    chart.setOption(buildOption(columns, rows, types, config, textColor))
    const resizeObserver = new ResizeObserver(() => chart.resize())
    resizeObserver.observe(container)
    return () => {
      resizeObserver.disconnect()
      chart.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, signature])

  if (failed) {
    return <div className="p-3 text-sm text-passive-1">Could not load the charting library.</div>
  }

  return (
    <div className="relative w-full">
      {!lib && <div className="p-3 text-sm text-passive-1">Loading chart…</div>}
      <div ref={containerRef} className="h-80 w-full text-text" />
    </div>
  )
}
