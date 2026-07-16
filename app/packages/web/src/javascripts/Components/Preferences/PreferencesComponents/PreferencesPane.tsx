import { FunctionComponent, ReactNode } from 'react'
import { classNames } from '@standardnotes/snjs'
import { useIsWidePane } from './WidePaneContext'

/**
 * Standard content column is 31.25rem (md:w-125). Panes flagged `wide` on their
 * PreferencesMenuItem (via WidePaneContext, e.g. Admin with its big tables) get a
 * doubled 62.5rem column, capped by max-w-full so it shrinks to the available
 * space on smaller viewports instead of forcing horizontal page scroll (inner
 * tables scroll themselves). The right-hand centering spacer is dropped for wide
 * panes to hand that room to the content.
 */
const PreferencesPane: FunctionComponent<{ children?: ReactNode }> = ({ children }) => {
  const isWide = useIsWidePane()

  return (
    <div className="text-foreground flex min-h-0 flex-grow flex-col overflow-y-auto md:flex-row">
      <div className={classNames('flex flex-grow flex-col items-center px-3 py-6', isWide ? 'md:px-6' : 'md:px-0')}>
        <div
          className={classNames(
            'flex max-w-full flex-col',
            isWide ? 'md:w-[62.5rem] md:max-w-full' : 'md:w-125 md:max-w-125',
          )}
        >
          {children != undefined && Array.isArray(children) ? children.filter((child) => child != undefined) : children}
        </div>
      </div>
      {!isWide && <div className="hidden flex-shrink basis-[13.75rem] md:block" />}
    </div>
  )
}

export default PreferencesPane
