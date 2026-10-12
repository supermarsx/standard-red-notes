/**
 * Standard Red Notes — the collapsed Super toolbar, as in Word.
 *
 * With the setting on, the docked ribbon collapses to its row of tabs and the
 * command panel under it — the groups of the active tab — is put away, so the
 * note gets the space. The panel comes back, drawn over the note, when the user
 * reaches for it. This module owns the one question that matters — "should the
 * panel be showing right now?" — and nothing else: what the panel LOOKS like in
 * each state is decided where it is rendered, in `ToolbarPlugin.tsx`, off the
 * attribute written here.
 *
 *
 * WHAT OPENS THE PANEL, AND WHAT KEEPS IT
 *
 * It OPENS when:
 *
 *  1. the pointer rests on a tab (and that tab becomes the one shown);
 *  2. a tab is clicked, tapped or activated from the keyboard — it then stays
 *     until the user goes back to the note, or activates the open tab again;
 *  3. keyboard focus is inside it;
 *  4. the keyboard shortcut asks for it.
 *
 * Once open it STAYS while any of those holds, and also while:
 *
 *  5. the pointer is anywhere over the bar — the tab row or the panel;
 *  6. something the panel opened is still open (see below).
 *
 * It closes a short moment after the last of them stops. (5) and (6) keep an
 * open panel open but never open a closed one: pointing at the Undo button in
 * the tab row is not reaching for the commands.
 *
 *
 * (6) IS THE ONE THAT IS EASY TO GET WRONG
 *
 * Every dropdown the panel opens is rendered OUTSIDE its DOM subtree: some are
 * portalled to the editor or the document, the rest are siblings of the bar. So
 * the moment the pointer travels from a button into the menu that button just
 * opened, the bar gets a `pointerleave`. Closing on that would pull the anchor
 * out from under an open menu — and every dropdown is now opened from a panel
 * that is only there because the pointer was.
 *
 * The toolbar itself cannot OR its "is open" flags together to prevent it,
 * because it does not hold them all — the AI selection tools and the block-style
 * gallery overflow each keep their own. What every one of them shares is the
 * `Popover` component, and `Popover` already publishes exactly the fact needed:
 * it stamps `aria-expanded="true"` on its anchor for as long as it is open, and
 * takes it off when it closes. "An element inside the panel is expanded" is
 * therefore true precisely when something is anchored to the panel — whichever
 * component owns it and wherever it is portalled — and that is the signal
 * observed here. A dropdown added to the ribbon tomorrow is covered without
 * anyone remembering this file exists.
 *
 * Dialogs have no anchor to observe, so the toolbar passes those in through
 * `hasOpenDialog`.
 *
 *
 * WHY THIS IS NOT REACT STATE
 *
 * The obvious implementation keeps each reason in `useState` and lets the
 * panel's className follow. It was built that way first, and measured: every
 * state change re-rendered the toolbar that hosts the hook — a 5000-line
 * component — so resting the pointer took 490–1040ms to reveal anything in a
 * development build instead of 120ms, and leaving took over a second to hide
 * it. A toolbar that answers the pointer a second late is not auto-hide, it is
 * a toolbar that is broken in a new way.
 *
 * So nothing here causes a render. The reasons live in a plain object, and the
 * verdict is written straight onto the panel as attributes that React never
 * sets and therefore never overwrites:
 *
 *  - the state attribute, which the panel's classes key their visibility off;
 *  - `inert` while it is hidden, which takes its invisible controls out of the
 *    tab order and away from the pointer.
 *
 * The hook around the controller only creates and disposes it, in a LAYOUT
 * effect so the panel is marked hidden before the browser paints it. The one
 * thing that does render is switching tabs on hover, because that changes what
 * the panel contains; it goes through the tab's own click handler.
 *
 *
 * TIMING
 *
 * The panel follows the reasons through ONE hide timer, so there is a single
 * place a flicker could come from. Moving between a tab, the panel and a menu
 * always passes through an instant where nothing is holding it; the hide delay
 * is longer than any such instant — and than a diagonal move from a tab to a
 * button — so the panel never blinks on the way.
 */
import { RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'

/**
 * How long the pointer must rest on a tab before the panel opens (or switches
 * to that tab). Long enough that sweeping across the tab row on the way to
 * somewhere else does not flash a panel over the text; short enough to feel
 * immediate.
 */
export const TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS = 120

/** How long the panel stays once nothing is keeping it. */
export const TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS = 400

/**
 * How long a keyboard request for the panel is honoured while focus is still on
 * its way in, so a slow machine cannot close the panel before focus arrives.
 */
export const TOOLBAR_AUTO_HIDE_FOCUS_GRACE_MS = 1500

/**
 * The attribute on the panel that says which state it is in. The panel's classes
 * in `ToolbarPlugin.tsx` are keyed on this name and on `revealed`, so the two
 * must be changed together; `ToolbarPlugin.autoHide.spec.tsx` compares them.
 */
export const TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE = 'data-super-toolbar-autohide'
export const TOOLBAR_AUTO_HIDE_REVEALED = 'revealed'
export const TOOLBAR_AUTO_HIDE_HIDDEN = 'hidden'

/** What marks an element the panel has something open against. */
const EXPANDED_ANCHOR_SELECTOR = '[aria-expanded="true"]'
const TAB_SELECTOR = '[role="tab"]'
const TAB_STRIP_SELECTOR = '[role="tablist"]'
/** The first control in the panel that can take keyboard focus. */
const FIRST_CONTROL_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]'

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

/**
 * Whether a pointer arriving on a tab or the bar is someone reaching for it.
 *
 * A touch is not: it has no hover, and opens the panel by tapping a tab
 * instead. Nor is a pointer that arrives with a button already down — that is a
 * drag passing over, most often a text selection being extended up to the top
 * of the note, and dropping a panel onto the lines being selected is exactly
 * the kind of getting in the way this feature exists to stop.
 */
const isHover = (event: Event): boolean => {
  const { pointerType, buttons } = event as PointerEvent
  return pointerType !== 'touch' && !buttons
}

type ToolbarAutoHideCallbacks = {
  /** The note's own contenteditable, so going back to typing lets the panel go. */
  getEditorRootElement: () => HTMLElement | null
  /** Give keyboard focus back to the note. */
  focusEditor: () => void
}

export type ToolbarAutoHideOptions = ToolbarAutoHideCallbacks & {
  /**
   * Whether the toolbar is collapsed (see `isSuperToolbarAutoHideActive`).
   * While false nothing is listened to, no timer runs, and no attribute is
   * written to either element.
   */
  active: boolean
  /** The whole bar: the tab row and the panel. */
  toolbarRef: RefObject<HTMLElement | null>
  /** The command panel: the part that is put away. */
  panelRef: RefObject<HTMLElement | null>
  /** A dialog the toolbar launched is open. */
  hasOpenDialog: boolean
}

export type ToolbarAutoHide = {
  /** Open the panel now and move keyboard focus into it. */
  revealAndFocus: () => void
  /** Whether keyboard focus is inside the panel. */
  containsFocus: () => boolean
  /** Stop keeping the panel open on the user's behalf. */
  release: () => void
}

type ToolbarAutoHideController = ToolbarAutoHide & {
  setHasOpenDialog: (open: boolean) => void
  dispose: () => void
}

/**
 * One toolbar's collapsed state, for as long as it is collapsed. Everything is
 * local to the two elements passed in, so any number of toolbars can be mounted
 * at once without sharing state.
 */
function createToolbarAutoHideController(
  toolbar: HTMLElement,
  panel: HTMLElement,
  callbacks: RefObject<ToolbarAutoHideCallbacks>,
): ToolbarAutoHideController {
  /** Any of these opens the panel. */
  const opening = { pointerOnTab: false, focusWithin: false, held: false, awaitingFocus: false }
  /** These keep an open panel open, but do not open a closed one. */
  const keeping = { pointerOverBar: false, expandedAnchor: false, openDialog: false }

  let isRevealed = false
  let restTimer: number | undefined
  let hideTimer: number | undefined
  let focusGraceTimer: number | undefined
  /** What the pointer is resting on, or about to count as resting on. */
  let pointedAt: Element | null = null
  /** True only while this controller is the one clicking a tab, to switch to it on hover. */
  let isSwitchingTab = false

  const isInsideBar = (node: EventTarget | null): boolean => node instanceof Node && toolbar.contains(node)
  const isInsidePanel = (node: EventTarget | null): boolean => node instanceof Node && panel.contains(node)
  const ownsOpenSurface = () => keeping.expandedAnchor || keeping.openDialog

  const write = () => {
    panel.setAttribute(
      TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE,
      isRevealed ? TOOLBAR_AUTO_HIDE_REVEALED : TOOLBAR_AUTO_HIDE_HIDDEN,
    )
    panel.toggleAttribute('inert', !isRevealed)
  }

  const cancelHide = () => {
    window.clearTimeout(hideTimer)
    hideTimer = undefined
  }

  /** Bring the panel in line with the reasons. Called after every change to them. */
  const update = () => {
    const opens = Object.values(opening).some(Boolean)
    const keeps = opens || Object.values(keeping).some(Boolean)
    if (opens || (isRevealed && keeps)) {
      cancelHide()
      if (!isRevealed) {
        isRevealed = true
        write()
      }
      return
    }
    if (isRevealed && hideTimer === undefined) {
      hideTimer = window.setTimeout(() => {
        hideTimer = undefined
        isRevealed = false
        write()
      }, TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    }
  }

  const open = (reason: keyof typeof opening, value: boolean) => {
    if (opening[reason] !== value) {
      opening[reason] = value
      update()
    }
  }
  const keep = (reason: keyof typeof keeping, value: boolean) => {
    if (keeping[reason] !== value) {
      keeping[reason] = value
      update()
    }
  }

  const stopAwaitingFocus = () => {
    window.clearTimeout(focusGraceTimer)
    focusGraceTimer = undefined
    open('awaitingFocus', false)
  }

  /**
   * The thing in the tab row that opens the panel when pointed at: a tab. A
   * toolbar customised down to one tab has no tab strip at all, and there the
   * row itself is the only thing left to point at.
   */
  const triggerOf = (target: EventTarget | null): Element | null => {
    if (!(target instanceof Element) || !toolbar.contains(target) || panel.contains(target)) {
      return null
    }
    const hasTabStrip = Array.from(toolbar.querySelectorAll(TAB_STRIP_SELECTOR)).some((strip) => !panel.contains(strip))
    return hasTabStrip ? target.closest(TAB_SELECTOR) : toolbar
  }

  /** Show the commands of the tab being pointed at, through that tab's own click handler. */
  const switchTo = (trigger: Element) => {
    if (!trigger.matches(TAB_SELECTOR) || trigger.getAttribute('aria-selected') === 'true') {
      return
    }
    isSwitchingTab = true
    try {
      ;(trigger as HTMLElement).click()
    } finally {
      isSwitchingTab = false
    }
  }

  // Reasons 1 and 5: the pointer.
  const handlePointerOver = (event: Event) => {
    if (!isHover(event)) {
      return
    }
    const trigger = triggerOf(event.target)
    if (trigger === pointedAt) {
      return
    }
    window.clearTimeout(restTimer)
    pointedAt = trigger
    if (!trigger) {
      // Off the tabs and onto the rest of the bar: reason 5 takes over.
      open('pointerOnTab', false)
      return
    }
    restTimer = window.setTimeout(() => {
      switchTo(trigger)
      open('pointerOnTab', true)
    }, TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS)
  }
  const handlePointerEnterBar = (event: Event) => {
    if (isHover(event)) {
      keep('pointerOverBar', true)
    }
  }
  const handlePointerLeaveBar = () => {
    window.clearTimeout(restTimer)
    pointedAt = null
    keeping.pointerOverBar = false
    open('pointerOnTab', false)
    update()
  }

  // Reason 2: a tab was activated. Activating the tab that is already open, while
  // it is being held open, lets it go again — the same toggle Word's ribbon has.
  const handleClick = (event: Event) => {
    if (isSwitchingTab || !(event.target instanceof Element)) {
      return
    }
    const tab = event.target.closest(TAB_SELECTOR)
    if (!tab || !toolbar.contains(tab) || panel.contains(tab)) {
      return
    }
    const isTheOpenTab = isRevealed && tab.getAttribute('aria-selected') === 'true'
    open('held', !(opening.held && isTheOpenTab))
  }

  // Reason 3: keyboard focus.
  const handleFocusIn = () => {
    // In this order, so there is no instant between the two in which nothing
    // is keeping the panel.
    open('focusWithin', true)
    stopAwaitingFocus()
  }
  const handleFocusOut = (event: FocusEvent) => {
    // Switching to another window blurs the focused control without focus going
    // anywhere in this document. That is not the user leaving the panel: if it
    // hid now it would turn inert under their focus and the browser would drop
    // it, so they would come back to find their place in the toolbar gone.
    // Leave things as they are; a real move elsewhere arrives as its own event.
    if (event.relatedTarget === null && !document.hasFocus()) {
      return
    }
    open('focusWithin', isInsidePanel(event.relatedTarget))
  }

  // Escape is the way out for someone who went in with the keyboard.
  const handleKeyDownInBar = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !isRevealed) {
      return
    }
    const wasInPanel = isInsidePanel(document.activeElement)
    open('held', false)
    if (wasInPanel) {
      callbacks.current.focusEditor()
    }
  }

  // Reason 6: something is anchored to the panel. `childList` is observed as well
  // as the attribute because switching tabs can remove an anchor outright, and a
  // removed node reports no attribute change. Naming the one attribute it cares
  // about also keeps this observer from hearing the attributes that `write`
  // above puts on the panel.
  const readExpandedAnchor = () => keep('expandedAnchor', panel.querySelector(EXPANDED_ANCHOR_SELECTOR) !== null)
  const anchorObserver = new MutationObserver(readExpandedAnchor)

  // Reason 2 ends when the user goes back to the note: a press anywhere outside
  // the bar, or a keystroke in the note itself. A press made while something the
  // panel owns is open is aimed at that menu or dialog (or at dismissing it), so
  // it is not a return to the note and leaves the hold alone.
  const handleDocumentPointerDown = (event: Event) => {
    if (!opening.held || isInsideBar(event.target) || ownsOpenSurface()) {
      return
    }
    open('held', false)
  }
  const handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (!opening.held || MODIFIER_KEYS.has(event.key)) {
      return
    }
    const editorRoot = callbacks.current.getEditorRootElement()
    if (editorRoot && event.target instanceof Node && editorRoot.contains(event.target)) {
      open('held', false)
    }
  }

  toolbar.addEventListener('pointerover', handlePointerOver)
  toolbar.addEventListener('pointerenter', handlePointerEnterBar)
  toolbar.addEventListener('pointerleave', handlePointerLeaveBar)
  toolbar.addEventListener('click', handleClick)
  toolbar.addEventListener('keydown', handleKeyDownInBar)
  panel.addEventListener('focusin', handleFocusIn)
  panel.addEventListener('focusout', handleFocusOut)
  anchorObserver.observe(panel, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-expanded'],
  })
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  document.addEventListener('keydown', handleDocumentKeyDown, true)

  // The starting state. Collapsing happens with the pointer ON the bar — it has
  // just pressed the collapse button — so the pointer being there must count as
  // "already over it" without keeping the panel open: the panel closes at once,
  // as the button promised, and still behaves correctly when the pointer then
  // moves to a tab or away. Focus already inside, or a menu already open, do
  // keep it: closing would strand them.
  keeping.pointerOverBar = toolbar.matches(':hover')
  opening.focusWithin = isInsidePanel(document.activeElement)
  keeping.expandedAnchor = panel.querySelector(EXPANDED_ANCHOR_SELECTOR) !== null
  isRevealed = opening.focusWithin || keeping.expandedAnchor
  write()

  return {
    setHasOpenDialog: (isOpen) => keep('openDialog', isOpen),
    release: () => open('held', false),
    containsFocus: () => isInsidePanel(document.activeElement),
    revealAndFocus: () => {
      // Held open until focus arrives or the grace period runs out, whichever is
      // first. The panel is written as revealed BEFORE focus is asked for,
      // because an inert panel cannot take it.
      window.clearTimeout(focusGraceTimer)
      focusGraceTimer = window.setTimeout(stopAwaitingFocus, TOOLBAR_AUTO_HIDE_FOCUS_GRACE_MS)
      open('awaitingFocus', true)
      panel.querySelector<HTMLElement>(FIRST_CONTROL_SELECTOR)?.focus()
    },
    dispose: () => {
      window.clearTimeout(restTimer)
      window.clearTimeout(hideTimer)
      window.clearTimeout(focusGraceTimer)
      anchorObserver.disconnect()
      toolbar.removeEventListener('pointerover', handlePointerOver)
      toolbar.removeEventListener('pointerenter', handlePointerEnterBar)
      toolbar.removeEventListener('pointerleave', handlePointerLeaveBar)
      toolbar.removeEventListener('click', handleClick)
      toolbar.removeEventListener('keydown', handleKeyDownInBar)
      panel.removeEventListener('focusin', handleFocusIn)
      panel.removeEventListener('focusout', handleFocusOut)
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
      document.removeEventListener('keydown', handleDocumentKeyDown, true)
      // Leave the panel exactly as it is when the toolbar is not collapsed.
      panel.removeAttribute(TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE)
      panel.removeAttribute('inert')
    },
  }
}

export function useToolbarAutoHide({
  active,
  toolbarRef,
  panelRef,
  hasOpenDialog,
  getEditorRootElement,
  focusEditor,
}: ToolbarAutoHideOptions): ToolbarAutoHide {
  const controllerRef = useRef<ToolbarAutoHideController | null>(null)

  // The toolbar re-creates these callbacks on every render; the controller reads
  // them through a ref so it does not have to be torn down each time.
  const callbacksRef = useRef<ToolbarAutoHideCallbacks>({ getEditorRootElement, focusEditor })
  const hasOpenDialogRef = useRef(hasOpenDialog)
  useEffect(() => {
    callbacksRef.current = { getEditorRootElement, focusEditor }
    hasOpenDialogRef.current = hasOpenDialog
  })

  // A layout effect, so the panel is marked hidden (and inert) before the
  // browser paints the frame in which the toolbar became collapsed.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    const panel = panelRef.current
    if (!active || !toolbar || !panel) {
      return
    }
    const controller = createToolbarAutoHideController(toolbar, panel, callbacksRef)
    controller.setHasOpenDialog(hasOpenDialogRef.current)
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [active, toolbarRef, panelRef])

  useEffect(() => {
    controllerRef.current?.setHasOpenDialog(hasOpenDialog)
  }, [hasOpenDialog])

  const release = useCallback(() => controllerRef.current?.release(), [])
  const revealAndFocus = useCallback(() => controllerRef.current?.revealAndFocus(), [])
  const containsFocus = useCallback(() => controllerRef.current?.containsFocus() ?? false, [])

  return { revealAndFocus, containsFocus, release }
}
