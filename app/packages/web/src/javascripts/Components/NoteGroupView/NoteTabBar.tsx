import { FunctionComponent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, useRef, useState } from 'react'
import { classNames } from '@standardnotes/utils'
import Icon from '../Icon/Icon'
import { NoteViewController } from '../NoteView/Controller/NoteViewController'
import { FileViewController } from '../NoteView/Controller/FileViewController'
import { ViewTab } from '@/Controllers/PaneController/ViewTab'
import Popover from '../Popover/Popover'
import Menu from '../Menu/Menu'
import MenuItem from '../Menu/MenuItem'
import MenuItemSeparator from '../Menu/MenuItemSeparator'
import { resolveTabLabel, TabCustomNames } from '@/Tabs/tabCustomNames'

type Controller = NoteViewController | FileViewController

/**
 * Standard Red Notes: identifies a right-clicked tab for the "close multiple"
 * context-menu operations. A discriminated union so the same target can address
 * either a full-column view tab (by its pane id) or a note/file tab (by its
 * controller runtimeId).
 */
export type TabTarget = { kind: 'view'; id: string } | { kind: 'controller'; runtimeId: string }

type Props = {
  controllers: Controller[]
  activeControllerRuntimeId?: string
  onSelect: (controller: Controller) => void
  onClose: (controller: Controller) => void
  onAddTab: () => void
  canAddTab: boolean
  /**
   * Standard Red Notes: full-column "pane" views (Home, Dashboard, Reminders,
   * Todos, Research) surfaced as tabs to the LEFT of the note tabs. Selecting one
   * shows its view in the editor content area instead of a note; closing removes
   * the tab.
   */
  viewTabs: ViewTab[]
  activeViewTabId?: string
  onSelectViewTab: (tab: ViewTab) => void
  onCloseViewTab: (tab: ViewTab) => void
  /**
   * Toggles between the single-visible (tabbed) view and the side-by-side tiled
   * view for the open notes. Driven from the tab bar so users can split without
   * first having to discover the tiles toolbar.
   */
  onToggleSplit: () => void
  /**
   * Whether the open notes are currently shown side by side (tiled). Controls the
   * split button's pressed state and label.
   */
  isSplit: boolean
  /**
   * When false the split button is disabled (e.g. nothing to split with, or on
   * mobile where tiling collapses to a single column).
   */
  canSplit: boolean
  /**
   * Standard Red Notes: right-click context-menu operations. They span BOTH the
   * view tabs and the note/file controllers, keyed off a {@link TabTarget}.
   */
  onCloseTab: (target: TabTarget) => void
  onCloseOtherTabs: (target: TabTarget) => void
  onCloseTabsToRight: (target: TabTarget) => void
  onCloseAllTabs: () => void
  /**
   * Standard Red Notes: per-tab custom names, keyed by the note/file `item.uuid`.
   * When a controller's item has a non-empty entry here its tab label shows the
   * custom name instead of the note title. Optional so existing call sites that
   * don't rename keep working unchanged.
   */
  customNames?: TabCustomNames
  /**
   * Standard Red Notes: persists a renamed tab label for `controller`. An empty
   * `name` reverts the tab to its note-title fallback. When omitted, the rename
   * affordances (double-click-to-edit and the "Rename" menu item) are hidden.
   */
  onRenameTab?: (controller: Controller, name: string) => void
}

const titleForController = (controller: Controller): string => {
  const title = controller.item?.title?.trim()
  return title && title.length > 0 ? title : 'Untitled'
}

const targetsEqual = (a: TabTarget, b: TabTarget): boolean =>
  a.kind === 'view' && b.kind === 'view'
    ? a.id === b.id
    : a.kind === 'controller' && b.kind === 'controller'
      ? a.runtimeId === b.runtimeId
      : false

/**
 * Browser-style tab bar for the open note/file controllers. Operates on the SAME
 * `itemControllers` set as the tiled editor: clicking a tab marks it active, the ×
 * closes that controller, and "+" opens a brand new note in its own tab.
 *
 * Right-clicking any tab (view or note/file) opens a context menu (anchored at the
 * cursor via Popover's `anchorPoint`, mirroring `TagContextMenu`) with close /
 * close-others / close-to-the-right / close-all actions and, for note tabs, a
 * split toggle.
 */
const NoteTabBar: FunctionComponent<Props> = ({
  controllers,
  activeControllerRuntimeId,
  onSelect,
  onClose,
  onAddTab,
  canAddTab,
  onToggleSplit,
  isSplit,
  canSplit,
  viewTabs,
  activeViewTabId,
  onSelectViewTab,
  onCloseViewTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  customNames,
  onRenameTab,
}) => {
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const contextMenuTarget = useRef<TabTarget | null>(null)
  // Standard Red Notes: runtimeId of the tab currently being renamed inline (null
  // = no edit in progress) and the in-progress draft text.
  const [renamingRuntimeId, setRenamingRuntimeId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const labelForController = (controller: Controller): string =>
    resolveTabLabel(customNames ?? {}, controller.item?.uuid, titleForController(controller))

  const beginRename = (controller: Controller) => {
    if (!onRenameTab) {
      return
    }
    setRenamingRuntimeId(controller.runtimeId)
    // Seed with the current custom name (not the title) so an empty box clearly
    // means "revert to title" and a populated box means "edit the custom name".
    setRenameDraft(controller.item?.uuid ? customNames?.[controller.item.uuid] ?? '' : '')
  }

  const commitRename = (controller: Controller) => {
    onRenameTab?.(controller, renameDraft)
    setRenamingRuntimeId(null)
    setRenameDraft('')
  }

  const cancelRename = () => {
    setRenamingRuntimeId(null)
    setRenameDraft('')
  }

  const totalTabs = viewTabs.length + controllers.length
  // Combined visual order = view tabs first, then note/file tabs.
  const combinedTargets: TabTarget[] = [
    ...viewTabs.map((tab): TabTarget => ({ kind: 'view', id: tab.id })),
    ...controllers.map((controller): TabTarget => ({ kind: 'controller', runtimeId: controller.runtimeId })),
  ]

  const openContextMenu = (event: MouseEvent, target: TabTarget) => {
    event.preventDefault()
    contextMenuTarget.current = target
    setContextMenuPosition({ x: event.clientX, y: event.clientY })
    setContextMenuOpen(true)
  }

  const closeContextMenu = () => setContextMenuOpen(false)

  const target = contextMenuTarget.current
  const targetIndex = target ? combinedTargets.findIndex((entry) => targetsEqual(entry, target)) : -1
  const hasTabsToRight = targetIndex >= 0 && targetIndex < combinedTargets.length - 1
  const hasOtherTabs = totalTabs > 1
  // The split toggle only applies to note/file tabs and only when there is more
  // than one note/file controller open to split with.
  const showSplitItem = target?.kind === 'controller' && controllers.length > 1

  // Rename only applies to note/file tabs and only when a rename handler is wired.
  const renameTargetController =
    onRenameTab && target?.kind === 'controller'
      ? controllers.find((controller) => controller.runtimeId === target.runtimeId)
      : undefined

  const runAndClose = (action: () => void) => {
    action()
    closeContextMenu()
  }

  return (
    <div
      className="note-tab-bar flex flex-shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-border bg-contrast px-2 py-1.5 md:py-1"
      style={{ WebkitOverflowScrolling: 'touch' }}
      role="tablist"
      aria-label="Open notes"
    >
      {viewTabs.map((tab) => {
        const isActive = tab.id === activeViewTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onSelectViewTab(tab)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onCloseViewTab(tab)
              }
            }}
            onMouseDown={(event) => {
              // Suppress the middle-click autoscroll affordance on the tab.
              if (event.button === 1) {
                event.preventDefault()
              }
            }}
            onContextMenu={(event) => openContextMenu(event, { kind: 'view', id: tab.id })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelectViewTab(tab)
              }
            }}
            className={classNames(
              'flex min-h-[2.25rem] flex-shrink-0 cursor-pointer touch-manipulation items-center gap-1 rounded border px-2.5 py-1.5 text-sm md:min-h-0 md:py-1 md:text-xs',
              isActive
                ? 'border-info bg-default font-semibold text-text'
                : 'border-border bg-contrast text-passive-0 hover:text-text',
            )}
            title={tab.title}
          >
            <Icon type={tab.icon} size="small" className="flex-shrink-0" />
            <span className="max-w-[8rem] truncate md:max-w-[10rem]">{tab.title}</span>
            <button
              type="button"
              className="-mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-contrast md:h-auto md:w-auto md:p-0.5"
              onClick={(event) => {
                event.stopPropagation()
                onCloseViewTab(tab)
              }}
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
            >
              <Icon type="close" size="small" />
            </button>
          </div>
        )
      })}
      {controllers.map((controller) => {
        const isActive = controller.runtimeId === activeControllerRuntimeId
        const title = labelForController(controller)
        const isRenaming = renamingRuntimeId === controller.runtimeId
        return (
          <div
            key={controller.runtimeId}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => {
              if (!isRenaming) {
                onSelect(controller)
              }
            }}
            onDoubleClick={() => beginRename(controller)}
            onAuxClick={(event) => {
              if (event.button === 1 && !isRenaming) {
                event.preventDefault()
                onClose(controller)
              }
            }}
            onMouseDown={(event) => {
              // Suppress the middle-click autoscroll affordance on the tab.
              if (event.button === 1) {
                event.preventDefault()
              }
            }}
            onContextMenu={(event) => openContextMenu(event, { kind: 'controller', runtimeId: controller.runtimeId })}
            onKeyDown={(event) => {
              if (isRenaming) {
                return
              }
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
            {isRenaming ? (
              <input
                type="text"
                autoFocus
                className="max-w-[8rem] flex-shrink rounded border border-info bg-default px-1 text-sm text-text md:max-w-[10rem] md:text-xs"
                aria-label="Rename tab"
                value={renameDraft}
                placeholder={titleForController(controller)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => commitRename(controller)}
                onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRename(controller)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelRename()
                  }
                }}
              />
            ) : (
              <span className="max-w-[8rem] truncate md:max-w-[10rem]">{title}</span>
            )}
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
        aria-label="New note tab"
        title="New note tab"
      >
        <Icon type="add" size="small" />
      </button>
      <button
        type="button"
        className={classNames(
          'flex h-9 w-9 flex-shrink-0 touch-manipulation items-center justify-center rounded border md:h-auto md:w-auto md:p-1',
          isSplit
            ? 'border-info bg-info text-info-contrast'
            : 'border-border bg-contrast',
          canSplit && !isSplit ? 'text-passive-0 hover:text-text' : '',
          !canSplit ? 'cursor-not-allowed text-passive-2' : '',
        )}
        onClick={onToggleSplit}
        disabled={!canSplit}
        aria-label={isSplit ? 'Return to single note view' : 'Split: show notes side by side'}
        aria-pressed={isSplit}
        title={isSplit ? 'Return to single note view' : 'Split: show notes side by side'}
      >
        <Icon type="open-in" size="small" />
      </button>

      <Popover
        title="Tab options"
        open={contextMenuOpen}
        anchorPoint={contextMenuPosition}
        togglePopover={() => setContextMenuOpen((open) => !open)}
        className="py-1"
        // The default popover is 320px wide (min-w-80); this is a short action
        // menu, so on desktop let it size to its longest item instead. Mobile
        // keeps the full-width takeover.
        containerClassName="md:!w-auto md:!min-w-0"
      >
        <Menu a11yLabel="Tab context menu">
          {renameTargetController && (
            <>
              <MenuItem
                icon="pencil-filled"
                onClick={() => {
                  runAndClose(() => beginRename(renameTargetController))
                }}
              >
                Rename
              </MenuItem>
              <MenuItemSeparator />
            </>
          )}
          <MenuItem
            icon="close"
            onClick={() => {
              if (target) {
                runAndClose(() => onCloseTab(target))
              }
            }}
          >
            Close
          </MenuItem>
          <MenuItem
            icon="close"
            disabled={!hasOtherTabs}
            onClick={() => {
              if (target) {
                runAndClose(() => onCloseOtherTabs(target))
              }
            }}
          >
            Close others
          </MenuItem>
          <MenuItem
            icon="close"
            disabled={!hasTabsToRight}
            onClick={() => {
              if (target) {
                runAndClose(() => onCloseTabsToRight(target))
              }
            }}
          >
            Close to the right
          </MenuItem>
          {showSplitItem && (
            <MenuItem
              icon="open-in"
              onClick={() => {
                runAndClose(onToggleSplit)
              }}
            >
              {isSplit ? 'Unsplit' : 'Split'}
            </MenuItem>
          )}
          <MenuItemSeparator />
          <MenuItem
            icon="trash"
            className="text-danger"
            onClick={() => {
              runAndClose(onCloseAllTabs)
            }}
          >
            Close all
          </MenuItem>
        </Menu>
      </Popover>
    </div>
  )
}

export default NoteTabBar
