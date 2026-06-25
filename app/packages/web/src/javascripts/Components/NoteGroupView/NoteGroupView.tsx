import { FileItem, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { AbstractComponent } from '@/Components/Abstract/PureComponent'
import MultipleSelectedNotes from '@/Components/MultipleSelectedNotes/MultipleSelectedNotes'
import MultipleSelectedFiles from '../MultipleSelectedFiles/MultipleSelectedFiles'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import FileView from '../FileView/FileView'
import NoteView from '../NoteView/NoteView'
import { NoteViewController } from '../NoteView/Controller/NoteViewController'
import { FileViewController } from '../NoteView/Controller/FileViewController'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '../Icon/Icon'
import TilesToolbar from './TilesToolbar'
import NoteTabBar, { TabTarget } from './NoteTabBar'
import { getTileGridStyle, TileLayout } from './TileLayout'
import { decisionForConflictTab } from './conflictTabDecision'
import { MediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { ViewTab } from '@/Controllers/PaneController/ViewTab'
import HomeView from '../Home/HomeView'
import DashboardView from '../Dashboard/DashboardView'
import RemindersView from '../RemindersAggregate/RemindersView'
import TodoView from '../TodoAggregate/TodoView'
import ResearchView from '../Research/ResearchView'
import BookmarksView from '../Bookmarks/BookmarksView'
import TemplatesView from '../Templates/TemplatesView'
import ConstellationView from '../Constellation/ConstellationView'
import NoteConflictResolutionView from '../NoteView/NoteConflictResolutionModal/NoteConflictResolutionView'
import EmptyTabView from './EmptyTabView'
import { loadNewTabBehavior } from '@/Tabs/newTabSettings'
import { loadTabCustomNames, saveTabCustomNames, setTabCustomName, TabCustomNames } from '@/Tabs/tabCustomNames'

/**
 * Standard Red Notes: the editor tile layout defaults to Single (one note shown
 * at a time) and the user's chosen layout is remembered across sessions in
 * device-local storage, so reopening the app restores their preferred split
 * instead of forcing them back to a multi-column tiling each time.
 */
const TILE_LAYOUT_STORAGE_KEY = 'srn_editor_tile_layout'
const VALID_TILE_LAYOUTS = new Set<string>([
  TileLayout.Single,
  TileLayout.Columns,
  TileLayout.Rows,
  TileLayout.Grid,
])

const loadPersistedTileLayout = (): TileLayout => {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(TILE_LAYOUT_STORAGE_KEY) : null
    if (stored && VALID_TILE_LAYOUTS.has(stored)) {
      return stored as TileLayout
    }
  } catch {
    /* storage may be unavailable (private mode, etc.) — fall back to the default */
  }
  return TileLayout.Single
}

const persistTileLayout = (layout: TileLayout): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, layout)
    }
  } catch {
    /* ignore storage write failures */
  }
}

type State = {
  showMultipleSelectedNotes: boolean
  showMultipleSelectedFiles: boolean
  controllers: (NoteViewController | FileViewController)[]
  activeControllerRuntimeId?: string
  selectedFile: FileItem | undefined
  selectedPane?: AppPaneId
  isInMobileView?: boolean
  /**
   * Standard Red Notes: full-column pane views surfaced as tabs in the editor tab
   * bar. Mirrored from `application.paneController` so this (observer-less) class
   * component re-renders when the tabs change.
   */
  viewTabs: ViewTab[]
  activeViewTabId?: string
  tileLayout: TileLayout
  /**
   * True when the viewport is below the `lg` breakpoint. In this tablet-sized
   * range tiling is still allowed (it is only fully disabled below `md`, where
   * `isInMobileView` takes over), but side-by-side columns/grids become too
   * narrow to use, so we stack tiles into a single scrollable column instead.
   */
  isNarrowTilingViewport: boolean
  /**
   * Standard Red Notes: per-tab custom names, keyed by note/file `item.uuid` and
   * persisted device-locally in localStorage (see `tabCustomNames.ts`). An empty
   * custom name reverts a tab label to the note title.
   */
  tabCustomNames: TabCustomNames
}

type Props = {
  application: WebApplication
  className?: string
}

class NoteGroupView extends AbstractComponent<Props, State> {
  private removeChangeObserver!: () => void
  private narrowTilingMediaQuery?: MediaQueryList
  private narrowTilingMQHandler = (event: MediaQueryListEvent | MediaQueryList) => {
    // `lg` query matches when width >= 1024px; narrow tiling applies below that.
    this.setState({ isNarrowTilingViewport: !event.matches })
  }

  constructor(props: Props) {
    super(props, props.application)
    const lgMatches =
      typeof window !== 'undefined' ? window.matchMedia(MediaQueryBreakpoints.lg).matches : true
    this.state = {
      showMultipleSelectedNotes: false,
      showMultipleSelectedFiles: false,
      controllers: [],
      activeControllerRuntimeId: undefined,
      selectedFile: undefined,
      viewTabs: [],
      activeViewTabId: undefined,
      tileLayout: loadPersistedTileLayout(),
      isNarrowTilingViewport: !lgMatches,
      tabCustomNames: loadTabCustomNames(),
    }
  }

  /**
   * Standard Red Notes: renames a note/file tab's label. Persists the custom name
   * keyed by the controller's `item.uuid` (stable across sessions, unlike the
   * controller `runtimeId`). An empty/whitespace name reverts the tab to its note
   * title. No-ops for template/uninitialized controllers that have no item yet.
   */
  private renameTab = (controller: NoteViewController | FileViewController, name: string) => {
    const uuid = controller.item?.uuid
    if (!uuid) {
      return
    }
    const next = setTabCustomName(this.state.tabCustomNames, uuid, name)
    saveTabCustomNames(next)
    this.setState({ tabCustomNames: next })
  }

  override componentDidMount(): void {
    super.componentDidMount()

    const lgMediaQuery = window.matchMedia(MediaQueryBreakpoints.lg)
    this.narrowTilingMediaQuery = lgMediaQuery
    if (lgMediaQuery.addEventListener != undefined) {
      lgMediaQuery.addEventListener('change', this.narrowTilingMQHandler)
    } else {
      lgMediaQuery.addListener(this.narrowTilingMQHandler)
    }

    const controllerGroup = this.application.itemControllerGroup
    this.removeChangeObserver = this.application.itemControllerGroup.addActiveControllerChangeObserver(() => {
      const controllers = controllerGroup.itemControllers
      this.setState({
        controllers: controllers,
        activeControllerRuntimeId: controllerGroup.activeItemViewController?.runtimeId,
      })
    })

    this.autorun(() => {
      if (this.application.notesController) {
        this.setState({
          showMultipleSelectedNotes: this.application.notesController.selectedNotesCount > 1,
        })
      }

      if (this.application.itemListController) {
        this.setState({
          showMultipleSelectedFiles: this.application.itemListController.selectedFilesCount > 1,
        })
      }
    })

    this.autorun(() => {
      if (this.application.itemListController) {
        this.setState({
          selectedFile: this.application.itemListController.selectedFiles[0],
        })
      }
    })

    this.autorun(() => {
      if (this.application.paneController) {
        this.setState({
          selectedPane: this.application.paneController.currentPane,
          isInMobileView: this.application.paneController.isInMobileView,
        })
      }
    })

    this.autorun(() => {
      if (this.application.paneController) {
        this.setState({
          viewTabs: this.application.paneController.viewTabs.slice(),
          activeViewTabId: this.application.paneController.activeViewTabId,
        })
      }
    })
  }

  override deinit() {
    this.removeChangeObserver?.()
    ;(this.removeChangeObserver as unknown) = undefined

    if (this.narrowTilingMediaQuery) {
      if (this.narrowTilingMediaQuery.removeEventListener != undefined) {
        this.narrowTilingMediaQuery.removeEventListener('change', this.narrowTilingMQHandler)
      } else {
        this.narrowTilingMediaQuery.removeListener(this.narrowTilingMQHandler)
      }
      this.narrowTilingMediaQuery = undefined
    }

    super.deinit()
  }

  private setTileLayout = (layout: TileLayout) => {
    persistTileLayout(layout)
    this.setState({ tileLayout: layout })
  }

  private setActiveController = (controller: NoteViewController | FileViewController) => {
    // Selecting a note tab takes over the content area, so deactivate any view tab.
    this.application.paneController.setActiveViewTab(undefined)
    this.application.itemControllerGroup.setActiveItemController(controller)
  }

  private selectViewTab = (tab: ViewTab) => {
    this.application.paneController.setActiveViewTab(tab.id)
  }

  private closeViewTab = (tab: ViewTab) => {
    this.application.paneController.closeViewTab(tab.id)
  }

  private closeTile = (controller: NoteViewController | FileViewController) => {
    this.application.itemControllerGroup.closeItemController(controller)
  }

  /**
   * Standard Red Notes: the combined left-to-right tab order is `[...viewTabs,
   * ...controllers]`. The context-menu "close multiple" operations below operate
   * across BOTH lists. A target identifies the right-clicked tab as either a view
   * tab id or a note/file controller runtimeId.
   */
  private closeTab = (target: TabTarget) => {
    if (target.kind === 'view') {
      this.application.paneController.closeViewTab(target.id)
    } else {
      const controller = this.application.itemControllerGroup.itemControllers.find(
        (controller) => controller.runtimeId === target.runtimeId,
      )
      if (controller) {
        this.application.itemControllerGroup.closeItemController(controller)
      }
    }
  }

  /**
   * Closes every tab EXCEPT the right-clicked one (both view tabs and note/file
   * tabs). Arrays are snapshotted before closing because closing mutates the
   * underlying viewTabs / controller group.
   */
  private closeOtherTabs = (target: TabTarget) => {
    const viewTabs = this.application.paneController.viewTabs.slice()
    const controllers = this.application.itemControllerGroup.itemControllers.slice()

    viewTabs.forEach((tab) => {
      if (!(target.kind === 'view' && tab.id === target.id)) {
        this.application.paneController.closeViewTab(tab.id)
      }
    })
    controllers.forEach((controller) => {
      if (!(target.kind === 'controller' && controller.runtimeId === target.runtimeId)) {
        this.application.itemControllerGroup.closeItemController(controller)
      }
    })
  }

  /**
   * Closes all tabs AFTER the right-clicked one in the combined visual order
   * `[...viewTabs, ...controllers]`.
   */
  private closeTabsToRight = (target: TabTarget) => {
    const viewTabs = this.application.paneController.viewTabs.slice()
    const controllers = this.application.itemControllerGroup.itemControllers.slice()

    const combined: TabTarget[] = [
      ...viewTabs.map((tab): TabTarget => ({ kind: 'view', id: tab.id })),
      ...controllers.map((controller): TabTarget => ({ kind: 'controller', runtimeId: controller.runtimeId })),
    ]

    const targetIndex = combined.findIndex((entry) =>
      target.kind === 'view'
        ? entry.kind === 'view' && entry.id === target.id
        : entry.kind === 'controller' && entry.runtimeId === target.runtimeId,
    )
    if (targetIndex < 0) {
      return
    }

    combined.slice(targetIndex + 1).forEach((entry) => this.closeTab(entry))
  }

  /**
   * Closes every tab (all view tabs + all note/file tabs).
   */
  private closeAllTabs = () => {
    const viewTabs = this.application.paneController.viewTabs.slice()
    const controllers = this.application.itemControllerGroup.itemControllers.slice()

    viewTabs.forEach((tab) => this.application.paneController.closeViewTab(tab.id))
    controllers.forEach((controller) => this.application.itemControllerGroup.closeItemController(controller))
  }

  /**
   * Opens a brand new note in its own tab/tile. Used by the "+" button. We create a
   * new note rather than re-opening the list-highlighted one because the highlighted
   * note is normally already the active tab, which would make `openNoteInNewTile` a
   * no-op (its `alreadyOpen` guard returns early).
   */
  private addTab = () => {
    // Standard Red Notes: the "+" button is configurable. With the "empty" behavior
    // it opens a blank placeholder tab; otherwise (the default) it creates a brand
    // new note in its own tab.
    if (loadNewTabBehavior() === 'empty') {
      this.application.paneController.openEmptyTab()
      return
    }
    // Opening a new note tab takes over the content area, so deactivate any view tab.
    this.application.paneController.setActiveViewTab(undefined)
    void this.application.itemListController.openNewNoteInNewTile()
  }

  /**
   * Opens the currently list-highlighted note as an additional tile alongside the
   * open ones (no-op if it is already open). Used by the "Add tile" button which is
   * only shown while already tiling.
   */
  private addTile = () => {
    void this.application.itemListController.openNoteInNewTile()
  }

  /**
   * Tab-bar driven split toggle. Transitions the group between the single-visible
   * (tabbed) view and the side-by-side tiled view, reusing the same controller set
   * and TileLayout that the TilesToolbar drives.
   *
   * - When already split (tiling with a multi-column/row/grid layout), collapses
   *   back to a single visible tile via `TileLayout.Single` (the tab bar still
   *   switches between the open notes, i.e. behaves like tabs again).
   * - When showing a single note, opens a second tile so the group can tile: the
   *   list-highlighted note if available/not already open, otherwise a brand new
   *   note. Then forces a real split layout (Columns).
   * - When multiple notes are open but collapsed to `Single`, just expands to the
   *   Columns split layout.
   */
  private toggleSplit = () => {
    const controllers = this.state.controllers
    const isSplit = controllers.length > 1 && this.state.tileLayout !== TileLayout.Single

    if (isSplit) {
      this.setTileLayout(TileLayout.Single)
      return
    }

    if (controllers.length > 1) {
      // Already multiple tiles open, just collapsed to Single: expand into a split.
      this.setTileLayout(TileLayout.Columns)
      return
    }

    // Only one note open: open a second one so we have something to tile with.
    const itemListController = this.application.itemListController
    const beforeCount = this.application.itemControllerGroup.itemControllers.length

    void (async () => {
      // Prefer splitting with the list-highlighted note; this is a no-op if it is
      // already the open note, in which case fall back to creating a new note.
      await itemListController.openNoteInNewTile()

      if (this.application.itemControllerGroup.itemControllers.length === beforeCount) {
        await itemListController.openNewNoteInNewTile()
      }

      this.setTileLayout(TileLayout.Columns)
    })()
  }

  private renderController(controller: NoteViewController | FileViewController) {
    return controller instanceof NoteViewController ? (
      <NoteView key={controller.runtimeId} application={this.application} controller={controller} />
    ) : (
      <FileView key={controller.runtimeId} application={this.application} file={controller.item} />
    )
  }

  /**
   * Standard Red Notes: renders the active full-column "pane" view (Home,
   * Dashboard, Reminders, Todos, Research, Bookmarks) inside the editor content
   * slot, in place of the note/file content, when its tab is active.
   */
  private renderActiveViewTab(tab: ViewTab) {
    const viewClassName = 'flex-grow min-h-0'

    if (tab.kind === 'empty') {
      return <EmptyTabView application={this.application} tabId={tab.id} className={viewClassName} />
    }

    if (tab.kind === 'conflict') {
      const note = this.application.items.findItem<SNNote>(tab.noteUuid)
      if (decisionForConflictTab(note) === 'close') {
        this.application.paneController.closeViewTab(tab.id)
        return null
      }
      const conflicted = this.application.items.conflictsOf(tab.noteUuid) as SNNote[]
      return (
        <NoteConflictResolutionView
          currentNote={note as SNNote}
          conflictedNotes={conflicted}
          className="flex-grow min-h-0"
          onClose={() => this.application.paneController.closeViewTab(tab.id)}
        />
      )
    }

    switch (tab.paneId) {
      case AppPaneId.Home:
        return <HomeView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Dashboard:
        return <DashboardView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Reminders:
        return <RemindersView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Todos:
        return <TodoView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Research:
        return <ResearchView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Bookmarks:
        return <BookmarksView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Templates:
        return <TemplatesView application={this.application} className={viewClassName} id={tab.id} />
      case AppPaneId.Constellation:
        return <ConstellationView application={this.application} className={viewClassName} id={tab.id} />
      default:
        return null
    }
  }

  override render() {
    const shouldNotShowMultipleSelectedItems =
      !this.state.showMultipleSelectedNotes && !this.state.showMultipleSelectedFiles

    const controllers = this.state.controllers
    const hasControllers = controllers.length > 0
    const activeViewTab = this.state.viewTabs.find((tab) => tab.id === this.state.activeViewTabId)
    // While a view tab is active it takes over the content area, so no note tabs
    // tile and no note tab looks active.
    const isTiling = controllers.length > 1 && !this.state.isInMobileView && !activeViewTab

    return (
      <>
        {this.state.showMultipleSelectedNotes && <MultipleSelectedNotes application={this.application} />}
        {this.state.showMultipleSelectedFiles && (
          <MultipleSelectedFiles itemListController={this.application.itemListController} />
        )}
        {shouldNotShowMultipleSelectedItems && (hasControllers || this.state.viewTabs.length > 0) && (
          <div className="flex h-full w-full flex-col">
            <NoteTabBar
              controllers={controllers}
              activeControllerRuntimeId={activeViewTab ? undefined : this.state.activeControllerRuntimeId}
              onSelect={this.setActiveController}
              onClose={this.closeTile}
              onAddTab={this.addTab}
              canAddTab={true}
              onToggleSplit={this.toggleSplit}
              isSplit={isTiling && this.state.tileLayout !== TileLayout.Single}
              canSplit={!this.state.isInMobileView && !activeViewTab}
              viewTabs={this.state.viewTabs}
              activeViewTabId={this.state.activeViewTabId}
              onSelectViewTab={this.selectViewTab}
              onCloseViewTab={this.closeViewTab}
              onCloseTab={this.closeTab}
              onCloseOtherTabs={this.closeOtherTabs}
              onCloseTabsToRight={this.closeTabsToRight}
              onCloseAllTabs={this.closeAllTabs}
              customNames={this.state.tabCustomNames}
              onRenameTab={this.renameTab}
            />

            {activeViewTab && this.renderActiveViewTab(activeViewTab)}

            {!activeViewTab && isTiling && (
              <TilesToolbar
                layout={this.state.tileLayout}
                onLayoutChange={this.setTileLayout}
                tileCount={controllers.length}
                onAddTile={this.addTile}
                canAddTile={!!this.application.itemListController.firstSelectedItem}
              />
            )}

            {!activeViewTab &&
              (isTiling ? (
              (() => {
                /**
                 * On tablet-sized viewports (below `lg`) side-by-side tiles are
                 * too narrow to use, so stack them into a single scrollable
                 * column. `Single` layout still shows just the active tile.
                 * Desktop (`lg`+) keeps the user-selected layout untouched.
                 */
                const effectiveLayout =
                  this.state.isNarrowTilingViewport && this.state.tileLayout !== TileLayout.Single
                    ? TileLayout.Rows
                    : this.state.tileLayout
                const stackVertically = this.state.isNarrowTilingViewport && effectiveLayout === TileLayout.Rows
                return (
                  <div
                    className={classNames(
                      'grid w-full flex-grow gap-1 bg-border',
                      stackVertically ? 'min-h-0 overflow-y-auto' : 'min-h-0',
                    )}
                    style={
                      stackVertically
                        ? { gridTemplateColumns: '1fr', gridAutoRows: 'minmax(60vh, 1fr)' }
                        : getTileGridStyle(effectiveLayout, controllers.length)
                    }
                  >
                {controllers.map((controller) => {
                  const isActive = controller.runtimeId === this.state.activeControllerRuntimeId
                  const isHidden = effectiveLayout === TileLayout.Single && !isActive
                  return (
                    <div
                      key={controller.runtimeId}
                      onMouseDownCapture={() => this.setActiveController(controller)}
                      className={classNames(
                        'relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-default',
                        isHidden && 'hidden',
                        isActive ? 'ring-2 ring-inset ring-info' : 'ring-1 ring-inset ring-transparent',
                      )}
                    >
                      <button
                        type="button"
                        title="Close tile"
                        onClick={(event) => {
                          event.stopPropagation()
                          this.closeTile(controller)
                        }}
                        className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded bg-default text-text opacity-70 shadow-sm hover:opacity-100"
                      >
                        <Icon type="close" size="small" />
                      </button>
                      <div className="min-h-0 flex-grow overflow-auto">{this.renderController(controller)}</div>
                    </div>
                  )
                })}
                  </div>
                )
              })()
            ) : (
              /**
               * Non-tiling branch: only one tile is shown (single open note, or mobile
               * where the tile grid is gated off). Render just the active tab's controller
               * so the tab bar behaves like true browser tabs (switching the visible note).
               */
              controllers
                .filter((controller) =>
                  this.state.activeControllerRuntimeId
                    ? controller.runtimeId === this.state.activeControllerRuntimeId
                    : controller === controllers[0],
                )
                .map((controller) => this.renderController(controller))
            ))}
          </div>
        )}
      </>
    )
  }
}

export default NoteGroupView
