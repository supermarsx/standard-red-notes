import { FunctionComponent } from 'react'
import { classNames } from '@standardnotes/utils'
import Icon from '../Icon/Icon'
import { NoteViewController } from '../NoteView/Controller/NoteViewController'
import { FileViewController } from '../NoteView/Controller/FileViewController'

type Controller = NoteViewController | FileViewController

type Props = {
  controllers: Controller[]
  activeControllerRuntimeId?: string
  onSelect: (controller: Controller) => void
  onClose: (controller: Controller) => void
  onAddTab: () => void
  canAddTab: boolean
}

const titleForController = (controller: Controller): string => {
  const title = controller.item?.title?.trim()
  return title && title.length > 0 ? title : 'Untitled'
}

/**
 * Browser-style tab bar for the open note/file controllers. Operates on the SAME
 * `itemControllers` set as the tiled editor: clicking a tab marks it active, the ×
 * closes that controller, and "+" opens the list-highlighted note in a new tab.
 */
const NoteTabBar: FunctionComponent<Props> = ({
  controllers,
  activeControllerRuntimeId,
  onSelect,
  onClose,
  onAddTab,
  canAddTab,
}) => {
  return (
    <div
      className="note-tab-bar flex flex-shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-contrast px-2 py-1.5 md:py-1"
      style={{ WebkitOverflowScrolling: 'touch' }}
      role="tablist"
      aria-label="Open notes"
    >
      {controllers.map((controller) => {
        const isActive = controller.runtimeId === activeControllerRuntimeId
        const title = titleForController(controller)
        return (
          <div
            key={controller.runtimeId}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onSelect(controller)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(controller)
              }
            }}
            className={classNames(
              'flex min-h-[2.25rem] flex-shrink-0 cursor-pointer touch-manipulation items-center gap-1 rounded border px-2.5 py-1.5 text-sm md:min-h-0 md:py-1 md:text-xs',
              isActive
                ? 'border-info bg-default font-semibold text-text'
                : 'border-border bg-contrast text-passive-0 hover:text-text',
            )}
            title={title}
          >
            <span className="max-w-[8rem] truncate md:max-w-[10rem]">{title}</span>
            <button
              type="button"
              className="-mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-contrast md:h-auto md:w-auto md:p-0.5"
              onClick={(event) => {
                event.stopPropagation()
                onClose(controller)
              }}
              aria-label="Close note"
              title="Close note"
            >
              <Icon type="close" size="small" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className={classNames(
          'flex h-9 w-9 flex-shrink-0 touch-manipulation items-center justify-center rounded border border-border bg-contrast md:h-auto md:w-auto md:p-1',
          canAddTab ? 'text-passive-0 hover:text-text' : 'cursor-not-allowed text-passive-2',
        )}
        onClick={onAddTab}
        disabled={!canAddTab}
        aria-label="Open highlighted note in a new tab"
        title="Open highlighted note in a new tab"
      >
        <Icon type="add" size="small" />
      </button>
    </div>
  )
}

export default NoteTabBar
