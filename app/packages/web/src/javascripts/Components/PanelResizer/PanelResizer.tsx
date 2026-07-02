import { Component, createRef, MouseEvent as ReactMouseEvent, MouseEventHandler } from 'react'
import { debounce } from '@/Utils'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'

const DEFAULT_EXPAND_WIDTH = 250

export type ResizeFinishCallback = (
  lastWidth: number,
  lastLeft: number,
  isMaxWidth: boolean,
  isCollapsed: boolean,
) => void

export enum PanelSide {
  Right = 'right',
  Left = 'left',
}

export enum PanelResizeType {
  WidthOnly = 'WidthOnly',
  OffsetAndWidth = 'OffsetAndWidth',
}

type Props = {
  width: number
  left: number
  alwaysVisible?: boolean
  collapsable?: boolean
  defaultWidth?: number
  hoverable?: boolean
  minWidth?: number
  panel: HTMLDivElement
  side: PanelSide
  type: PanelResizeType
  resizeFinishCallback?: ResizeFinishCallback
  widthEventCallback?: (width: number) => void
  modifyElementWidth: boolean
}

type State = {
  collapsed: boolean
  pressed: boolean
}

class PanelResizer extends Component<Props, State> {
  private overlay?: HTMLDivElement
  private resizerElementRef = createRef<HTMLDivElement>()
  private debouncedResizeHandler: () => void
  private startLeft: number
  private startWidth: number
  private lastDownX: number
  private lastLeft: number
  private lastWidth: number
  private widthBeforeLastDblClick: number
  private minWidth: number

  constructor(props: Props) {
    super(props)
    this.state = {
      collapsed: false,
      pressed: false,
    }

    this.minWidth = props.minWidth || 5
    // Do NOT read panel.offsetLeft/scrollWidth here. This constructor runs
    // during the app's very first desktop render — typically before the page
    // has fully loaded — and those reads force a synchronous layout flush
    // (Firefox: "Layout was forced before the page was fully loaded"). The
    // values are dead at this point anyway: lastLeft/lastWidth are immediately
    // overwritten by setLeft/setWidth below, and startLeft/startWidth are
    // re-seeded from the live panel on every interaction start (onMouseDown /
    // handleResize) before they are ever used.
    this.startLeft = props.left
    this.startWidth = props.width
    this.lastDownX = 0
    this.lastLeft = props.left
    this.lastWidth = props.width
    this.widthBeforeLastDblClick = 0

    this.setLeft(this.props.left)

    // setWidth clamps the requested width against the parent/app rects, which
    // reads getBoundingClientRect and therefore forces layout. Run it now only
    // if the page has already fully loaded (every later mount, e.g. toggling
    // panes); during boot defer the initial clamp to the window load event so
    // startup never forces a pre-load layout flush. Until then lastWidth
    // tracks props.width — the exact width the parent grid renders the panel
    // at — so behavior is unchanged.
    if (document.readyState === 'complete') {
      this.setWidth(this.props.width)
    } else {
      window.addEventListener('load', this.clampInitialWidthOnLoad, { once: true })
    }

    document.addEventListener('mouseup', this.onMouseUp)
    document.addEventListener('mousemove', this.onMouseMove)
    this.debouncedResizeHandler = debounce(this.handleResize, 250)
    if (this.props.type === PanelResizeType.OffsetAndWidth) {
      window.addEventListener('resize', this.debouncedResizeHandler)
    }
  }

  override componentDidMount() {
    this.resizerElementRef.current?.addEventListener('dblclick', this.onDblClick)
  }

  /**
   * Deferred initial clamp (see constructor): applies the same setWidth the
   * constructor would have run, once the page has fully loaded and reading
   * layout no longer risks a pre-load forced reflow / FOUC.
   */
  clampInitialWidthOnLoad = () => {
    this.setWidth(this.props.width)
    this.finishSettingWidth()
  }

  override componentDidUpdate(prevProps: Props) {
    // Reading scrollWidth forces layout. Before the page has fully loaded no
    // user interaction can have resized the panel, so lastWidth still tracks
    // the prop/grid-driven width exactly — skip the sync read until load to
    // keep boot free of forced layout flushes.
    if (document.readyState === 'complete') {
      this.lastWidth = this.props.panel.scrollWidth
    }

    if (this.props.width != prevProps.width) {
      this.setWidth(this.props.width)
    }

    if (this.props.left !== prevProps.left) {
      this.setLeft(this.props.left)
      this.setWidth(this.props.width)
    }

    const isCollapsed = this.isCollapsed()
    if (isCollapsed !== this.state.collapsed) {
      this.setState({ collapsed: isCollapsed })
    }
  }

  override componentWillUnmount() {
    this.resizerElementRef.current?.removeEventListener('dblclick', this.onDblClick)
    document.removeEventListener('mouseup', this.onMouseUp)
    document.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('resize', this.debouncedResizeHandler)
    window.removeEventListener('load', this.clampInitialWidthOnLoad)
  }

  get appFrame() {
    return document.getElementById('app')?.getBoundingClientRect() as DOMRect
  }

  getParentRect() {
    if (!this.props.panel.parentNode) {
      return new DOMRect()
    }

    return (this.props.panel.parentNode as HTMLElement).getBoundingClientRect()
  }

  isAtMaxWidth = () => {
    const marginOfError = 5
    const difference = Math.abs(Math.round(this.lastWidth + this.lastLeft) - Math.round(this.getParentRect().width))
    return difference < marginOfError
  }

  isCollapsed() {
    return this.lastWidth <= this.minWidth
  }

  finishSettingWidth = () => {
    if (!this.props.collapsable) {
      return
    }

    this.setState({
      collapsed: this.isCollapsed(),
    })
  }

  setWidth = (width: number, finish = false): number => {
    if (width === 0) {
      width = this.computeMaxWidth()
    }
    if (width < this.minWidth) {
      width = this.minWidth
    }

    const parentRect = this.getParentRect()
    if (width > parentRect.width) {
      width = parentRect.width
    }

    const maxWidth = this.appFrame.width - this.props.panel.getBoundingClientRect().x
    if (width > maxWidth) {
      width = maxWidth
    }

    const isFullWidth = Math.round(width + this.lastLeft) === Math.round(parentRect.width)
    if (this.props.modifyElementWidth) {
      if (isFullWidth) {
        if (this.props.type === PanelResizeType.WidthOnly) {
          this.props.panel.style.removeProperty('width')
        } else {
          this.props.panel.style.width = `calc(100% - ${this.lastLeft}px)`
        }
      } else {
        this.props.panel.style.width = width + 'px'
      }
    }

    this.lastWidth = width

    if (finish) {
      this.finishSettingWidth()

      if (this.props.resizeFinishCallback) {
        this.props.resizeFinishCallback(this.lastWidth, this.lastLeft, this.isAtMaxWidth(), this.isCollapsed())
      }
    }

    if (this.props.widthEventCallback) {
      this.props.widthEventCallback(width)
    }

    return width
  }

  setLeft = (left: number) => {
    this.props.panel.style.left = left + 'px'
    this.lastLeft = left
  }

  expandPanel = () => {
    this.setWidth(this.widthBeforeLastDblClick || this.props.defaultWidth || DEFAULT_EXPAND_WIDTH)
    this.finishSettingWidth()

    this.props.resizeFinishCallback?.(this.lastWidth, this.lastLeft, this.isAtMaxWidth(), this.isCollapsed())
  }

  onExpandButtonClick = (event: ReactMouseEvent) => {
    event.stopPropagation()
    this.expandPanel()
  }

  onExpandButtonMouseDown = (event: ReactMouseEvent) => {
    event.stopPropagation()
  }

  onDblClick = () => {
    const collapsed = this.isCollapsed()
    if (collapsed) {
      this.expandPanel()
    } else {
      this.widthBeforeLastDblClick = this.lastWidth
      this.setWidth(this.minWidth)
      this.finishSettingWidth()

      this.props.resizeFinishCallback?.(this.lastWidth, this.lastLeft, this.isAtMaxWidth(), this.isCollapsed())
    }
  }

  handleWidthEvent(event?: MouseEvent) {
    let x
    if (event) {
      x = event.clientX
    } else {
      /** Coming from resize event */
      x = 0
      this.lastDownX = 0
    }
    const deltaX = x - this.lastDownX
    const newWidth = this.startWidth + deltaX
    const adjustedWidth = this.setWidth(newWidth, false)

    if (this.props.widthEventCallback) {
      this.props.widthEventCallback(adjustedWidth)
    }
  }

  handleLeftEvent(event: MouseEvent) {
    const panelRect = this.props.panel.getBoundingClientRect()
    const x = event.clientX || panelRect.x
    let deltaX = x - this.lastDownX
    let newLeft = this.startLeft + deltaX
    if (newLeft < 0) {
      newLeft = 0
      deltaX = -this.startLeft
    }
    const parentRect = this.getParentRect()
    let newWidth = this.startWidth - deltaX
    if (newWidth < this.minWidth) {
      newWidth = this.minWidth
    }
    if (newWidth > parentRect.width) {
      newWidth = parentRect.width
    }
    if (newLeft + newWidth > parentRect.width) {
      newLeft = parentRect.width - newWidth
    }
    this.setLeft(newLeft)
    this.setWidth(newWidth, false)
  }

  computeMaxWidth(): number {
    const parentRect = this.getParentRect()
    let width = parentRect.width - this.props.left
    if (width < this.minWidth) {
      width = this.minWidth
    }
    return width
  }

  handleResize = () => {
    const startWidth = this.isAtMaxWidth() ? this.computeMaxWidth() : this.props.panel.scrollWidth

    this.startWidth = startWidth
    this.lastWidth = startWidth

    this.handleWidthEvent()
    this.finishSettingWidth()
  }

  onMouseDown: MouseEventHandler = (event) => {
    this.addInvisibleOverlay()
    this.lastDownX = event.clientX
    this.startWidth = this.props.panel.scrollWidth
    this.startLeft = this.props.panel.offsetLeft
    this.setState({
      pressed: true,
    })
  }

  onMouseUp = () => {
    this.removeInvisibleOverlay()
    if (!this.state.pressed) {
      return
    }
    this.setState({ pressed: false })
    const isMaxWidth = this.isAtMaxWidth()
    if (this.props.resizeFinishCallback) {
      this.props.resizeFinishCallback(this.lastWidth, this.lastLeft, isMaxWidth, this.isCollapsed())
    }
    this.finishSettingWidth()
  }

  onMouseMove = (event: MouseEvent) => {
    if (!this.state.pressed) {
      return
    }
    event.preventDefault()
    if (this.props.side === PanelSide.Left) {
      this.handleLeftEvent(event)
    } else {
      this.handleWidthEvent(event)
    }
  }

  /**
   * If an iframe is displayed adjacent to our panel, and the mouse exits over the iframe,
   * document[onmouseup] is not triggered because the document is no longer the same over
   * the iframe. We add an invisible overlay while resizing so that the mouse context
   * remains in our main document.
   */
  addInvisibleOverlay = () => {
    if (this.overlay) {
      return
    }
    const overlayElement = document.createElement('div')
    overlayElement.id = 'resizer-overlay'
    this.overlay = overlayElement
    document.body.prepend(this.overlay)
  }

  removeInvisibleOverlay = () => {
    if (this.overlay) {
      this.overlay.remove()
      this.overlay = undefined
    }
  }

  override render() {
    const isLeftSide = this.props.side === PanelSide.Left
    const showExpandButton = this.props.collapsable && this.state.collapsed

    return (
      <>
        <div
          className={classNames(
            'panel-resizer',
            'absolute right-0 top-0 z-panel-resizer',
            'hidden h-full w-[4px] cursor-col-resize border-y-0 bg-[color:var(--panel-resizer-background-color)] md:block',
            this.props.alwaysVisible || this.state.collapsed || this.state.pressed ? 'opacity-100' : 'opacity-0',
            this.props.hoverable && 'hover:opacity-100',
            isLeftSide && 'left-0 right-auto',
          )}
          onMouseDown={this.onMouseDown}
          ref={this.resizerElementRef}
        />
        {showExpandButton && (
          <button
            type="button"
            aria-label="Expand panel"
            title="Expand panel"
            className={classNames(
              'absolute top-1/2 z-panel-resizer -translate-y-1/2',
              'hidden h-12 w-4 cursor-pointer items-center justify-center md:flex',
              'rounded-md border border-border bg-default text-text shadow-sm',
              'hover:bg-contrast focus:outline-none',
              // Straddle the panel edge (half outside) so the handle stays
              // visible and clickable even when the panel is collapsed to a
              // ~5px sliver. The chevron points the direction the panel opens:
              // a right-edge resizer (PanelSide.Right) grows the panel
              // rightward; a left-edge one (PanelSide.Left) grows it leftward.
              isLeftSide ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2',
            )}
            onClick={this.onExpandButtonClick}
            onMouseDown={this.onExpandButtonMouseDown}
          >
            <Icon type={isLeftSide ? 'chevron-left' : 'chevron-right'} size="small" />
          </button>
        )}
      </>
    )
  }
}

export default PanelResizer
