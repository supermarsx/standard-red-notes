/**
 * Layout modes for the tiled multi-note editor.
 *
 * - Single: only the active tile is shown full-size (other open tiles stay open but hidden).
 * - Columns: tiles placed side by side in a single row.
 * - Rows: tiles stacked vertically in a single column.
 * - Grid: an "auto" square-ish grid: ceil(sqrt(N)) columns.
 * - A specific column count (1-4) can also be requested via ColumnCount.
 */
export enum TileLayout {
  Single = 'single',
  Columns = 'columns',
  Rows = 'rows',
  Grid = 'grid',
}

/**
 * Computes the inline grid style for a given layout and tile count.
 * Returns CSS grid-template-columns / grid-template-rows values.
 */
export function getTileGridStyle(layout: TileLayout, tileCount: number): React.CSSProperties {
  const count = Math.max(tileCount, 1)

  switch (layout) {
    case TileLayout.Single:
      return {
        gridTemplateColumns: '1fr',
        gridTemplateRows: '1fr',
      }
    case TileLayout.Columns:
      return {
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        gridTemplateRows: '1fr',
      }
    case TileLayout.Rows:
      return {
        gridTemplateColumns: '1fr',
        gridTemplateRows: `repeat(${count}, minmax(0, 1fr))`,
      }
    case TileLayout.Grid:
    default: {
      const columns = Math.ceil(Math.sqrt(count))
      const rows = Math.ceil(count / columns)
      return {
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }
    }
  }
}
