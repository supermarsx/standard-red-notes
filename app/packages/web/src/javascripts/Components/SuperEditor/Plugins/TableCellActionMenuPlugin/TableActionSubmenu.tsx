/**
 * Standard Red Notes — an in-place submenu for the table action menu.
 *
 * WHY IN-PLACE AND NOT A FLOATING SUBMENU. The menu's keyboard navigation
 * (`useListKeyboardNavigation`) collects its items with
 * `containerElement.querySelectorAll('button, div[role="button"]')` and re-collects
 * them from a `subtree: true` MutationObserver. So items revealed INSIDE the same
 * `<menu>` join Up/Down navigation for free the moment they appear, while items
 * rendered into a portaled popover would sit outside that container and be
 * unreachable by keyboard. That settles the shape empirically rather than by
 * preference: a floating submenu here would have been a keyboard regression.
 *
 * It is a plain disclosure, so Enter and Space toggle it as a native button, and
 * ArrowRight / ArrowLeft open and close it per the usual menu convention.
 */
import { KeyboardEvent, ReactNode, useCallback, useId, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import { FOCUSABLE_BUT_NOT_TABBABLE } from '@/Constants/Constants'
import { classNames } from '@standardnotes/utils'
import MenuListItem from '@/Components/Menu/MenuListItem'

export function TableActionSubmenu({
  label,
  children,
  defaultOpen = false,
}: {
  label: string
  children: ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const contentId = useId()

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight') {
      event.stopPropagation()
      setOpen(true)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.stopPropagation()
      setOpen(false)
    }
  }, [])

  const onContentKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft') {
      return
    }
    event.stopPropagation()
    setOpen(false)
    toggleRef.current?.focus()
  }, [])

  return (
    <>
      <MenuListItem>
        <button
          ref={toggleRef}
          type="button"
          role="menuitem"
          aria-expanded={open}
          aria-controls={contentId}
          tabIndex={FOCUSABLE_BUT_NOT_TABBABLE}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={onKeyDown}
          className={classNames(
            'flex w-full cursor-pointer items-center border-0 bg-transparent px-3 py-2.5 text-left select-none md:py-1.5',
            'text-mobile-menu-item text-text enabled:hover:bg-passive-3 enabled:hover:text-foreground',
            'focus:bg-info-backdrop md:text-tablet-menu-item lg:text-menu-item focus:shadow-none',
          )}
        >
          <Icon
            type={open ? 'chevron-down' : 'chevron-right'}
            className="text-neutral mr-2 h-5 w-5 flex-shrink-0"
            size="small"
          />
          {label}
        </button>
      </MenuListItem>
      {/* Rendered inside the same <menu>, so the list keyboard navigation picks
          these up as soon as they appear. Unmounted when collapsed, so it skips
          them again. */}
      <div id={contentId} hidden={!open} onKeyDown={onContentKeyDown} className="pl-4">
        {open ? children : null}
      </div>
    </>
  )
}
