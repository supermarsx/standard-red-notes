import { Component, createRef, MouseEvent as ReactMouseEvent, MouseEventHandler } from 'react'
import { debounce } from '@/Utils'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'

const DEFAULT_EXPAND_WIDTH = 250

/**
 * A panel at or below this width is COLLAPSED — a sliver, not a narrow column.
 *
 * `minWidth` is a different quantity: the narrowest width a DRAG may produce.
 * The notes list passes 200 and the navigation pane 48, both perfectly usable.
 * `isCollapsed()` used to be `lastWidth <= minWidth`, i.e. true at the narrowest
 * draggable width, so dragging the notes list to its 200px minimum put an
 * "Expand panel" chevron over a list that was not collapsed at all.
 *
 * `collapsedWidth` takes the MINIMUM of the two, so a resizer that passes no
 * `minWidth` keeps the historical 5px default as both its drag floor and its
 * collapsed threshold and nothing changes for that case.
 */
const COLLAPSED_PANEL_WIDTH = 8

/**
 * The width a panel should actually be rendered at, given a width read back out
 * of storage.
 *
 * Nothing re-validated a persisted width on READ. `resizeFinishCallback`
 * persists whatever `lastWidth` happens to be, and focus mode drives a pane's
 * grid column to a literal `0`, so a width below the pane's own minimum — or a
 * `0`/negative/NaN left by a corrupted or legacy preference — could be stored
 * and then restored verbatim on the next launch, handing the resizer a width its
 * own clamps are supposed to make unreachable.
 *
 * A width that is not a usable number falls back to the pane DEFAULT rather than
 * to the minimum: "never configured" and "the user dragged it as narrow as it
 * goes" are different facts and must not render identically.
 */
export function clampPanelWidth(width: number | undefined | null, minWidth: number, fallbackWidth: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return fallbackWidth
  }

  return Math.max(width, minWidth)
}

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
  /**
   * Whether the panel is in the explicitly-collapsed state.
   *
   * A drag can never reach it — drags floor at `minWidth` — so the only ways in
   * are the resizer's double-click collapse and the only ways out are the expand
   * affordances and starting a new drag. It exists because `setWidth` has to floor
   * at the SLIVER while collapsed and at `minWidth` otherwise: without a sticky
   * intent, `componentDidUpdate`'s `setWidth(this.props.width)` re-floors the
   * collapsed width straight back up to `minWidth` on the very next prop
   * round-trip and the collapse silently undoes itself.
   */
  private collapseIntent = false

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
    // Reading layout forces a flush. Before the page has fully loaded no user
    // interaction can have resized the panel, so lastWidth still tracks the
    // prop/grid-driven width exactly — skip the sync read until load to keep
    // boot free of forced layout flushes.
    if (document.readyState === 'complete') {
      this.lastWidth = this.panelWidth()
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

  /**
   * The app frame's rect, or `null` when `#app` is not in the document.
   *
   * This was `document.getElementById('app')?.getBoundingClientRect() as DOMRect`.
   * The cast asserted away exactly the case the optional chain exists for, so
   * `setWidth`'s `this.appFrame.width` was a TypeError waiting for any render in
   * which `#app` is absent — a portal/unit mount, or an unmount racing a debounced
   * window-resize. Returning `null` and skipping that one clamp is the safe
   * failure: the floor and parent-rect clamps around it still apply.
   */
  get appFrame(): DOMRect | null {
    return document.getElementById('app')?.getBoundingClientRect() ?? null
  }

  /**
   * The panel's own on-screen width.
   *
   * MUST NOT be `panel.scrollWidth`. scrollWidth is the panel's CONTENT extent,
   * so it counts any child that overflows the panel — and this component renders
   * exactly such a child INTO the panel: the collapsed "Expand panel" chevron is
   * absolutely positioned to straddle the panel edge (`right-0 translate-x-1/2`
   * on a 16px box), which adds ~8px. Measured in Chrome on the live notes
   * column: a 400px panel reports scrollWidth 399, and 407 with the chevron
   * mounted, while `getBoundingClientRect().width` reports 400 either way.
   *
   * Feeding scrollWidth into `isCollapsed()` therefore made the collapse
   * predicate a function of its own render output. Dragging the notes list to its
   * clamped 200px minimum put scrollWidth at 199 against a minWidth of 200:
   * collapsed flipped true, the chevron mounted, scrollWidth became 207, collapsed
   * flipped false, the chevron unmounted, scrollWidth returned to 199 — 50 nested
   * setStates inside componentDidUpdate, and React threw "Maximum update depth
   * exceeded" (minified #185). The Note list error boundary caught it and rendered
   * "List unavailable", which is the whole of the reported bug.
   *
   * The border-box width is immune to what the panel's children do, and is the
   * same quantity the clamps in `setWidth` are expressed in, so `lastWidth` now
   * agrees with `props.width` instead of trailing it by the 1px of border that
   * scrollWidth excludes.
   */
  private panelWidth(): number {
    return this.props.panel.getBoundingClientRect().width
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

  /** The width at which this panel counts as collapsed. See COLLAPSED_PANEL_WIDTH. */
  get collapsedWidth(): number {
    return Math.min(this.minWidth, COLLAPSED_PANEL_WIDTH)
  }

  /**
   * The narrowest width `setWidth` may produce right now: the sliver while the
   * panel is explicitly collapsed, the drag minimum otherwise.
   */
  private get widthFloor(): number {
    return this.collapseIntent ? this.collapsedWidth : this.minWidth
  }

  /**
   * Whether THIS RESIZER has collapsed the panel to a sliver, which is precisely
   * the condition its "Expand panel" affordance can undo.
   *
   * Deliberately not "the panel currently measures zero": focus mode drives these
   * panes' grid columns to a literal `0` and has its own way back out, so offering
   * a chevron there would be an affordance for a state this resizer does not own.
   * Requiring the intent also keeps the predicate independent of live layout in
   * every state the resizer did not ask for.
   */
  isCollapsed() {
    return this.collapseIntent && this.lastWidth <= this.collapsedWidth
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
    const floor = this.widthFloor

    if (width === 0) {
      width = this.computeMaxWidth()
    }
    if (width < floor) {
      width = floor
    }

    const parentRect = this.getParentRect()
    if (width > parentRect.width) {
      width = parentRect.width
    }

    const appFrame = this.appFrame
    if (appFrame) {
      const maxWidth = appFrame.width - this.props.panel.getBoundingClientRect().x
      if (width > maxWidth) {
        width = maxWidth
      }
    }

    // Re-apply the floor LAST. The two max clamps above are computed from live
    // layout and can land below it: on a viewport narrower than the fixed side
    // panes, `appFrame.width - panel.x` is smaller than the floor, and once those
    // columns overflow the app frame it goes NEGATIVE. A negative width is not a
    // width — it reaches the parent as an invalid `grid-template-columns` track,
    // which the browser drops wholesale, which moves the panel, which re-clamps.
    // Overflowing a pathologically narrow viewport is the better failure.
    if (width < floor) {
      width = floor
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
    // Leave the collapsed state FIRST so setWidth floors at the drag minimum
    // again rather than at the sliver.
    this.collapseIntent = false
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
      // Collapse to the SLIVER, not to the drag minimum. Collapsing to `minWidth`
      // is what made `isCollapsed()` true at a 200px notes list that was not
      // collapsed at all; the intent flag is what keeps the sliver from being
      // re-floored back up to `minWidth` on the next prop round-trip.
      this.collapseIntent = true
      this.setWidth(this.collapsedWidth)
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
    if (newWidth < this.widthFloor) {
      newWidth = this.widthFloor
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
    const startWidth = this.isAtMaxWidth() ? this.computeMaxWidth() : this.panelWidth()

    this.startWidth = startWidth
    this.lastWidth = startWidth

    this.handleWidthEvent()
    this.finishSettingWidth()
  }

  onMouseDown: MouseEventHandler = (event) => {
    this.addInvisibleOverlay()
    // Dragging the resizer is an instruction to SIZE the panel, so it leaves the
    // collapsed state and the drag floors at `minWidth` again.
    this.collapseIntent = false
    this.lastDownX = event.clientX
    this.startWidth = this.panelWidth()
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
            'z-panel-resizer absolute top-0 right-0',
            'hidden h-full w-[4px] cursor-col-resize border-y-0 bg-[color:var(--panel-resizer-background-color)] md:block',
            this.props.alwaysVisible || this.state.collapsed || this.state.pressed ? 'opacity-100' : 'opacity-0',
            this.props.hoverable && 'hover:opacity-100',
            isLeftSide && 'right-auto left-0',
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
              'z-panel-resizer absolute top-1/2 -translate-y-1/2',
              'hidden h-12 w-4 cursor-pointer items-center justify-center md:flex',
              'border-border bg-default text-text rounded-md border shadow-sm',
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
