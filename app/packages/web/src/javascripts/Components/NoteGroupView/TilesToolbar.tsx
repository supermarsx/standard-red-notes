import { FunctionComponent } from 'react'
import { classNames } from '@standardnotes/utils'
import Icon from '../Icon/Icon'
import { TileLayout } from './TileLayout'

type Props = {
  layout: TileLayout
  onLayoutChange: (layout: TileLayout) => void
  tileCount: number
  onAddTile: () => void
  canAddTile: boolean
}

const layoutOptions: { layout: TileLayout; label: string }[] = [
  { layout: TileLayout.Single, label: 'Single' },
  { layout: TileLayout.Columns, label: 'Columns' },
  { layout: TileLayout.Rows, label: 'Rows' },
  { layout: TileLayout.Grid, label: 'Grid' },
]

const TilesToolbar: FunctionComponent<Props> = ({ layout, onLayoutChange, tileCount, onAddTile, canAddTile }) => {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 overflow-x-auto border-b border-border bg-default px-3 py-1.5">
      <span className="text-xs font-semibold text-passive-1">
        {tileCount} {tileCount === 1 ? 'tile' : 'tiles'}
      </span>

      <div className="flex items-center overflow-hidden rounded border border-border">
        {layoutOptions.map((option) => {
          const isActive = option.layout === layout
          return (
            <button
              key={option.layout}
              type="button"
              title={`Layout: ${option.label}`}
              onClick={() => onLayoutChange(option.layout)}
              className={classNames(
                'touch-manipulation px-3 py-1.5 text-xs lg:px-2 lg:py-1',
                isActive ? 'bg-info text-info-contrast' : 'bg-default text-text hover:bg-contrast',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        title="Open highlighted note in a new tile"
        onClick={onAddTile}
        disabled={!canAddTile}
        className={classNames(
          'flex touch-manipulation items-center gap-1 rounded border border-border px-3 py-1.5 text-xs lg:px-2 lg:py-1',
          canAddTile ? 'text-text hover:bg-contrast' : 'cursor-not-allowed text-passive-2',
        )}
      >
        <Icon type="add" size="small" />
        Add tile
      </button>
    </div>
  )
}

export default TilesToolbar
