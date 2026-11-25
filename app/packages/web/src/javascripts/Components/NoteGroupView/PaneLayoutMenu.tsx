import { useRef, useState } from 'react'
import Icon from '../Icon/Icon'
import Popover from '../Popover/Popover'
import Menu from '../Menu/Menu'
import MenuItem from '../Menu/MenuItem'
import MenuItemSeparator from '../Menu/MenuItemSeparator'
import MenuRadioButtonItem from '../Menu/MenuRadioButtonItem'
import { TileLayout } from './TileLayout'

export type PaneLayoutOptions = {
  layout: TileLayout
  tileCount: number
  onLayoutChange: (layout: TileLayout) => void
  onAddTile: () => void
  canAddTile: boolean
}
const layouts = [
  { value: TileLayout.Single, label: 'Tabs — one note at a time' },
  { value: TileLayout.Columns, label: 'Columns — side by side' },
  { value: TileLayout.Rows, label: 'Rows — stacked' },
  { value: TileLayout.Grid, label: 'Grid' },
]

export default function PaneLayoutMenu({
  layout,
  tileCount,
  onLayoutChange,
  onAddTile,
  canAddTile,
  canSplit,
}: PaneLayoutOptions & { canSplit: boolean }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    anchor.current?.focus()
  }
  return (
    <>
      <button
        type="button"
        ref={anchor}
        aria-label="Tab and tile layouts"
        title="Tab and tile layouts"
        aria-haspopup="menu"
        aria-expanded={open}
        className="border-border bg-contrast text-passive-0 hover:text-text flex h-9 w-7 flex-shrink-0 touch-manipulation items-center justify-center rounded border md:h-auto md:w-auto md:p-1"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Icon type="chevron-down" size="small" />
      </button>
      <Popover
        title="Tab and tile layouts"
        anchorElement={anchor}
        open={open}
        togglePopover={close}
        disableMobileFullscreenTakeover
        className="py-1"
        containerClassName="!w-64 !min-w-0"
      >
        <Menu a11yLabel="Tab and tile layouts" closeMenu={close}>
          <li className="text-passive-1 px-3 py-1 text-xs">
            {tileCount} {tileCount === 1 ? 'open note' : 'open notes'}
          </li>
          {layouts.map(({ value, label }) => (
            <MenuRadioButtonItem
              key={value}
              checked={layout === value}
              disabled={value !== TileLayout.Single && !canSplit}
              onClick={() => {
                close()
                onLayoutChange(value)
              }}
            >
              {label}
            </MenuRadioButtonItem>
          ))}
          <MenuItemSeparator />
          <MenuItem
            icon="add"
            disabled={!canAddTile || !canSplit}
            onClick={() => {
              close()
              onAddTile()
            }}
          >
            Open highlighted note in a tile
          </MenuItem>
        </Menu>
      </Popover>
    </>
  )
}
