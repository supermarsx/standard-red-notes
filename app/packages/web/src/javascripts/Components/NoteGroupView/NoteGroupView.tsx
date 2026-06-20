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

type State = {
  showMultipleSelectedNotes: boolean
  showMultipleSelectedFiles: boolean
  controllers: (NoteViewController | FileViewController)[]
  activeControllerRuntimeId?: string
  selectedFile: FileItem | undefined
  selectedPane?: AppPaneId
  isInMobileView?: boolean
  tileLayout: TileLayout
}

type Props = {
  application: WebApplication
  className?: string
}

class NoteGroupView extends AbstractComponent<Props, State> {
  private removeChangeObserver!: () => void

  constructor(props: Props) {
    super(props, props.application)
    this.state = {
      showMultipleSelectedNotes: false,
      showMultipleSelectedFiles: false,
      controllers: [],
      activeControllerRuntimeId: undefined,
      selectedFile: undefined,
      tileLayout: TileLayout.Columns,
    }
  }

  override componentDidMount(): void {
    super.componentDidMount()

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

  private addTile = () => {
    void this.application.itemListController.openNoteInNewTile()
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
              onAddTab={this.addTile}
              canAddTab={!!this.application.itemListController.firstSelectedItem}
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
              <div
                className="grid min-h-0 w-full flex-grow gap-1 bg-border"
                style={getTileGridStyle(this.state.tileLayout, controllers.length)}
              >
                {controllers.map((controller) => {
                  const isActive = controller.runtimeId === this.state.activeControllerRuntimeId
                  const isHidden = this.state.tileLayout === TileLayout.Single && !isActive
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
