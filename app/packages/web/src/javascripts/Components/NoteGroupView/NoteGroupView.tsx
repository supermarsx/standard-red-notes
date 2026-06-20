import { FileItem } from '@standardnotes/snjs'
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
import NoteTabBar from './NoteTabBar'
import { getTileGridStyle, TileLayout } from './TileLayout'
import { MediaQueryBreakpoints } from '@/Hooks/useMediaQuery'

type State = {
  showMultipleSelectedNotes: boolean
  showMultipleSelectedFiles: boolean
  controllers: (NoteViewController | FileViewController)[]
  activeControllerRuntimeId?: string
  selectedFile: FileItem | undefined
  selectedPane?: AppPaneId
  isInMobileView?: boolean
  tileLayout: TileLayout
  /**
   * True when the viewport is below the `lg` breakpoint. In this tablet-sized
   * range tiling is still allowed (it is only fully disabled below `md`, where
   * `isInMobileView` takes over), but side-by-side columns/grids become too
   * narrow to use, so we stack tiles into a single scrollable column instead.
   */
  isNarrowTilingViewport: boolean
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
      tileLayout: TileLayout.Columns,
      isNarrowTilingViewport: !lgMatches,
    }
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
    this.setState({ tileLayout: layout })
  }

  private setActiveController = (controller: NoteViewController | FileViewController) => {
    this.application.itemControllerGroup.setActiveItemController(controller)
  }

  private closeTile = (controller: NoteViewController | FileViewController) => {
    this.application.itemControllerGroup.closeItemController(controller)
  }

  /**
   * Opens a brand new note in its own tab/tile. Used by the "+" button. We create a
   * new note rather than re-opening the list-highlighted one because the highlighted
   * note is normally already the active tab, which would make `openNoteInNewTile` a
   * no-op (its `alreadyOpen` guard returns early).
   */
  private addTab = () => {
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

  override render() {
    const shouldNotShowMultipleSelectedItems =
      !this.state.showMultipleSelectedNotes && !this.state.showMultipleSelectedFiles

    const controllers = this.state.controllers
    const hasControllers = controllers.length > 0
    const isTiling = controllers.length > 1 && !this.state.isInMobileView

    return (
      <>
        {this.state.showMultipleSelectedNotes && <MultipleSelectedNotes application={this.application} />}
        {this.state.showMultipleSelectedFiles && (
          <MultipleSelectedFiles itemListController={this.application.itemListController} />
        )}
        {shouldNotShowMultipleSelectedItems && hasControllers && (
          <div className="flex h-full w-full flex-col">
            <NoteTabBar
              controllers={controllers}
              activeControllerRuntimeId={this.state.activeControllerRuntimeId}
              onSelect={this.setActiveController}
              onClose={this.closeTile}
              onAddTab={this.addTab}
              canAddTab={true}
              onToggleSplit={this.toggleSplit}
              isSplit={isTiling && this.state.tileLayout !== TileLayout.Single}
              canSplit={!this.state.isInMobileView}
            />

            {isTiling && (
              <TilesToolbar
                layout={this.state.tileLayout}
                onLayoutChange={this.setTileLayout}
                tileCount={controllers.length}
                onAddTile={this.addTile}
                canAddTile={!!this.application.itemListController.firstSelectedItem}
              />
            )}

            {isTiling ? (
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
            )}
          </div>
        )}
      </>
    )
  }
}

export default NoteGroupView
