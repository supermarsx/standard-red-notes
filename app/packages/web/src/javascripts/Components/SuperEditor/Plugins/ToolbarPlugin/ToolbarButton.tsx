import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ToolbarItem } from '@ariakit/react'
import { classNames } from '@standardnotes/snjs'
import { ComponentPropsWithoutRef, ForwardedRef, ReactNode, forwardRef } from 'react'

export interface ToolbarButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'name'> {
  name: NonNullable<ReactNode>
  active?: boolean
  iconName?: string
  children?: ReactNode
  onSelect: () => void
}

const ToolbarButton = forwardRef(
  (
    { name, active, iconName, children, onSelect, disabled, className, ...props }: ToolbarButtonProps,
    ref: ForwardedRef<HTMLButtonElement>,
  ) => {
    const [editor] = useLexicalComposerContext()

    const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
    const parentElement = editor.getRootElement()?.parentElement ?? document.body

    return (
      <StyledTooltip
        showOnMobile
        showOnHover
        label={name}
        side="top"
        portalElement={isMobile ? parentElement : undefined}
        documentElement={parentElement}
      >
        <ToolbarItem
          className={classNames(
            'flex items-center justify-center rounded-md p-0.5 transition-colors duration-75 select-none focus:shadow-none focus:outline-none md:border md:border-transparent',
            'hover:bg-passive-4 focus-visible:bg-passive-4 active:bg-passive-3 hover:md:border-border',
            // Disabled buttons keep aria-disabled (not the native attribute) so they
            // stay hoverable and their tooltip still explains them; override the
            // interactive styling back so they read as greyed and inert.
            'aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent aria-disabled:hover:md:border-transparent',
            className,
          )}
          onClick={() => {
            if (!disabled) {
              onSelect()
            }
          }}
          onMouseDown={(event) => {
            event.preventDefault()
          }}
          onContextMenu={(event) => {
            editor.focus()
            event.preventDefault()
          }}
          disabled={disabled}
          // Keep disabled buttons hoverable (aria-disabled, not the native disabled
          // attribute) so their StyledTooltip still explains what the greyed-out
          // button does instead of being inert.
          accessibleWhenDisabled
          ref={ref}
          {...props}
        >
          <div
            className={classNames(
              // Desktop padding is deliberately tighter than the touch target
              // kept for mobile (p-2.5): three rows of these make up most of the
              // ribbon's height, so each 2px here is 12px off the writing area.
              'flex items-center justify-center rounded-md p-2.5 transition-colors duration-75 md:p-1.5',
              active && 'bg-info text-info-contrast shadow-sm',
            )}
          >
            {children ? (
              children
            ) : iconName ? (
              <Icon
                type={iconName}
                size="custom"
                // Icon size is driven by the `.super-toolbar-icon` class, which
                // resolves `var(--super-toolbar-icon-size, 0.875rem)` (set on the
                // toolbar root from the SuperToolbarIconSize pref). The class's
                // fallback guarantees a concrete size even if the var is unset, so
                // every toolbar icon scales together and can never collapse.
                className="super-toolbar-icon !text-current [&>path]:!text-current"
              />
            ) : null}
          </div>
        </ToolbarItem>
      </StyledTooltip>
    )
  },
)

export default ToolbarButton
