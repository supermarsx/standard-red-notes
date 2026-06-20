import Icon from '@/Components/Icon/Icon'
import { FunctionComponent } from 'react'
import { IconType, classNames } from '@standardnotes/snjs'
import { ErrorCircle } from '@/Components/UIElements/ErrorCircle'
import CountBubble from './CountBubble'

interface Props {
  iconType: IconType
  label: string
  selected: boolean
  bubbleCount?: number
  hasErrorIndicator?: boolean
  onClick: () => void
}

const PreferencesMenuItem: FunctionComponent<Props> = ({
  iconType,
  label,
  selected,
  onClick,
  bubbleCount,
  hasErrorIndicator,
}) => (
  <div
    className={classNames(
      'preferences-menu-item box-border flex h-auto w-auto min-w-42 cursor-pointer select-none flex-row items-center justify-start rounded border border-solid text-sm hover:border-border hover:bg-default',
      // Larger, comfortably tappable rows on mobile; revert to the compact
      // desktop padding from md up so the sidebar appearance is unchanged.
      'px-3 py-3 md:px-4 md:py-2',
      selected ? 'selected border-info font-bold text-info' : 'border-transparent',
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
    <span className="flex-grow">{label}</span>
    {hasErrorIndicator && (
      <span className="ml-2">
        <ErrorCircle />
      </span>
    )}
    {/* Chevron hints the tap-to-drill-in interaction on mobile only. */}
    <Icon type="chevron-right" className="ml-1 flex-shrink-0 text-neutral md:hidden" />
  </div>
)

export default PreferencesMenuItem
