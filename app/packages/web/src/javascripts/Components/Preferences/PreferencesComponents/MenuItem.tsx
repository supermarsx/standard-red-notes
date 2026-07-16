import Icon from '@/Components/Icon/Icon'
import { FunctionComponent } from 'react'
import { IconType, classNames } from '@standardnotes/snjs'
import { ErrorCircle } from '@/Components/UIElements/ErrorCircle'
import CountBubble from './CountBubble'

interface Props {
  iconType: IconType
  label: string
  /**
   * Optional secondary line shown beneath the label, used by Preferences search
   * to hint which matching section/keyword the user can jump to.
   */
  secondaryLabel?: string
  selected: boolean
  bubbleCount?: number
  hasErrorIndicator?: boolean
  onClick: () => void
}

const PreferencesMenuItem: FunctionComponent<Props> = ({
  iconType,
  label,
  secondaryLabel,
  selected,
  onClick,
  bubbleCount,
  hasErrorIndicator,
}) => (
  <div
    className={classNames(
      'preferences-menu-item hover:border-border hover:bg-default box-border flex h-auto w-auto min-w-42 cursor-pointer flex-row items-center justify-start rounded border border-solid text-sm select-none',
      // Larger, comfortably tappable rows on mobile; revert to the compact
      // desktop padding from md up so the sidebar appearance is unchanged.
      'px-3 py-3 md:px-4 md:py-2',
      selected ? 'selected border-info text-info font-bold' : 'border-transparent',
    )}
    onClick={(e) => {
      e.preventDefault()
      onClick()
    }}
  >
    <div className="relative mr-1">
      <Icon className={classNames('text-base', selected ? 'text-info' : 'text-neutral')} type={iconType} />
      <CountBubble position="left" count={bubbleCount} />
    </div>
    <div className="min-w-1" />
    <span className="flex flex-grow flex-col">
      <span>{label}</span>
      {secondaryLabel && <span className="text-passive-1 text-xs font-normal capitalize">{secondaryLabel}</span>}
    </span>
    {hasErrorIndicator && (
      <span className="ml-2">
        <ErrorCircle />
      </span>
    )}
    {/* Chevron hints the tap-to-drill-in interaction on mobile only. */}
    <Icon type="chevron-right" className="text-neutral ml-1 flex-shrink-0 md:hidden" />
  </div>
)

export default PreferencesMenuItem
