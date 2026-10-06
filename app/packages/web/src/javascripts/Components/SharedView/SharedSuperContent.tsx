import { Component, useEffect, useMemo, useRef, type JSX, type RefObject } from 'react'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { TablePlugin } from '@lexical/react/LexicalTablePlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { EditorState } from 'lexical'

import { BlocksEditorComposer } from '../SuperEditor/BlocksEditorComposer'
import ListStylePlugin from '../SuperEditor/Plugins/ListStylePlugin/ListStylePlugin'
import CodeHighlightPlugin from '../SuperEditor/Plugins/CodeHighlightPlugin'
import { TableWidgetLayoutPlugin } from '../SuperEditor/Plugins/TablePlugin'
import TableFilterPlugin from '../SuperEditor/Plugins/TableFilterPlugin/TableFilterPlugin'
import { redactShareNodes, type ShareRedaction } from './SharedNodePolicy'

/**
 * Standard Red Notes — the Super renderer for a PUBLIC share link.
 *
 *
 * WHY THIS EXISTS RATHER THAN A THIRD RENDERER
 *
 * The viewer used to run every shared note through the plain editor markdown
 * renderer. The `text` of a Super note is its serialized Lexical state, so a
 * shared Super note put `{"root":{"children":[{"children":[{"detail":0,…` on
 * screen as paragraph text — measured in headless Chrome at 7 320 characters of
 * JSON with zero `<ul>`, zero `<table>` and zero `<svg>`.
 *
 * The app already has a read-only Super surface that works: the revision
 * preview (`NoteView/ReadonlyNoteContent`) and the markdown preview both mount
 * `BlocksEditorComposer readonly`, which is the Lexical theme plus the node
 * registry (`Lexical/Nodes/AllNodes`). This file mounts the SAME composer with
 * the SAME registry — so every node renders exactly as it does in the editor —
 * and differs only in which plugins sit inside it.
 *
 * It cannot reuse `BlocksEditor` itself: that component mounts the toolbar, the
 * navigation sidebar, the block picker, the item-selection plugin and the
 * collaboration plugin, every one of which calls `useApplication()`, which
 * THROWS without an `<ApplicationProvider>`. The public page has no
 * WebApplication by design. So the plugin list below is the display-only
 * subset, and that subset is itself the second layer of read-only.
 *
 *
 * HOW READ-ONLY IS STRUCTURALLY ENFORCED — five independent layers
 *
 *  1. `BlocksEditorComposer readonly` sets the Lexical `editable: false` flag,
 *     so the content element renders `contenteditable="false"` and Lexical
 *     beforeinput/keydown/paste handling bails before touching the document.
 *
 *  2. NO EDITING PLUGIN IS MOUNTED. The toolbar, block picker, draggable block,
 *     markdown shortcuts, auto-pair, format painter, item selection, file
 *     upload, history and collaboration plugins are absent, so the commands
 *     they register do not exist on this editor at all. That is an absence, not
 *     a disabled flag: there is no handler left to re-enable.
 *
 *  3. THERE IS NO CHANGE SINK. No `OnChangePlugin`, no `onChange` prop, no
 *     `NoteViewController`, no `WebApplication`, no sync service and no
 *     authenticated HTTP client is reachable from this component. An in-memory
 *     mutation is never serialized, never saved and never sent anywhere; the
 *     only request the share page makes at all is the unauthenticated
 *     `GET /v1/shares/:id` that fetched the ciphertext.
 *
 *  4. {@link SharedReadOnlyGuard} REVERTS any update that changes the document.
 *     Layers 1-3 stop the reader and Lexical; this one stops a DECORATOR. The
 *     React component of a decorator node (the colour dots on a callout, a
 *     mermaid settings panel) calls `editor.update()` directly, and Lexical
 *     does NOT gate `update()` on `isEditable()`. The guard compares a content
 *     fingerprint and restores the last permitted state.
 *
 *  5. {@link SharedInertControls} makes every form control a decorator paints
 *     `inert`, and dams the events that would drive one. Layer 4 undoes a
 *     write; this one means the reader is never offered the control that would
 *     attempt it, and is not left looking at an editable-looking textarea on a
 *     page that says it is read-only.
 *
 * One exception is deliberate and named: folding a collapsible section changes
 * what THIS reader sees, not the document, and is allowed — otherwise a shared
 * note containing a collapsed section could never be opened.
 */

/** The tag the guard puts on its own restores so it cannot re-enter. */
export const SHARE_READONLY_REVERT_TAG = 'shared-view-readonly-revert'

/**
 * Serialized fields that describe how a block is being LOOKED AT rather than
 * what it says. A change confined to these is reader view state and is left
 * alone; anything else is a document mutation and is reverted.
 */
export const SHARE_VIEW_ONLY_FIELDS: Record<string, readonly string[]> = {
  'collapsible-container': ['open'],
}

/**
 * The part of a serialized editor state a public reader may not change.
 * Exported for its spec: this function IS the read-only policy, so it is tested
 * directly rather than only through a rendered editor.
 */
export function shareContentFingerprint(state: EditorState): string {
  return JSON.stringify(state.toJSON(), (_key: string, value: unknown) => {
    if (value === null || typeof value !== 'object') {
      return value
    }
    const type = (value as { type?: unknown }).type
    if (typeof type !== 'string') {
      return value
    }
    const viewOnly = SHARE_VIEW_ONLY_FIELDS[type]
    if (viewOnly === undefined) {
      return value
    }
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const field of viewOnly) {
      delete copy[field]
    }
    return copy
  })
}

/** Interactions that mean the READER has started driving the page. */
const ARMING_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'keydown'] as const

/**
 * Layer 4 of read-only. Once the reader has touched the page, any editor
 * update that changes the document is reverted.
 *
 * WHY IT ARMS ON FIRST INTERACTION RATHER THAN AT MOUNT. The first version
 * baselined the document the moment the plugin mounted and reverted everything
 * afterwards, and it broke syntax highlighting: `registerCodeHighlighting`
 * works by registering a node transform, and registering a transform marks the
 * existing nodes of that type dirty, so Prism splits the code block text into
 * `CodeHighlightNode`s in an update of its own. The guard saw a changed
 * document and put the unsplit text back. Measured in headless Chrome: the
 * code block rendered as ONE `<span data-lexical-text="true">` with no tokens
 * at all, while the gutter (a mutation listener, not a transform) updated
 * normally — the tell that the transform had run and been undone.
 *
 * The threat is a READER-DRIVEN mutation: a decorator that writes to the
 * document from one of its own controls. The renderer normalizing the document
 * it was just handed is not that, and cannot be, because nobody has touched
 * the page yet. So the guard adopts every update until the first interaction
 * and freezes the document from then on.
 *
 * `onBlocked` is called for every reverted update, so a spec can prove the
 * guard FIRED rather than inferring it from an unchanged document — a
 * decorator that silently did nothing would look identical.
 */
export function SharedReadOnlyGuard({ onBlocked }: { onBlocked?: (count: number) => void }): null {
  const [editor] = useLexicalComposerContext()
  const onBlockedRef = useRef(onBlocked)
  onBlockedRef.current = onBlocked

  useEffect(() => {
    // Re-assert editability here as well as in the composer: a plugin or a
    // decorator can call `setEditable(true)`, and the initial config of the
    // composer is only read once.
    editor.setEditable(false)

    let permitted = editor.getEditorState()
    let permittedFingerprint = shareContentFingerprint(permitted)
    let armed = false
    let blocked = 0

    const arm = () => {
      armed = true
    }
    for (const type of ARMING_EVENTS) {
      document.addEventListener(type, arm, true)
    }

    let disposed = false
    let revertScheduled = false

    /**
     * The restore is deferred by a microtask rather than applied inside the
     * listener. An update listener runs INSIDE `$commitPendingUpdates`, and a
     * `setEditorState` from there re-enters the commit it is standing in:
     * measured in jsdom, the listener ran, the counter incremented, and the
     * document kept the decorator write — a guard that reported success and
     * reverted nothing, which is the worst of the three possible outcomes.
     */
    const scheduleRevert = () => {
      if (revertScheduled) {
        return
      }
      revertScheduled = true
      queueMicrotask(() => {
        revertScheduled = false
        if (disposed) {
          return
        }
        editor.setEditorState(permitted, { tag: SHARE_READONLY_REVERT_TAG })
      })
    }

    const unregister = editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      if (tags.has(SHARE_READONLY_REVERT_TAG)) {
        return
      }
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        // A selection-only update moves no content.
        return
      }

      const fingerprint = shareContentFingerprint(editorState)

      // Before the reader has touched anything, the only source of an update is
      // the renderer settling the document it was handed.
      if (!armed || fingerprint === permittedFingerprint) {
        // The second arm of that condition is the view-only exemption: a
        // section folded by the reader. Adopt it so a later revert does not
        // undo the fold.
        permitted = editorState
        permittedFingerprint = fingerprint
        return
      }

      blocked += 1
      onBlockedRef.current?.(blocked)
      scheduleRevert()
    })

    return () => {
      disposed = true
      for (const type of ARMING_EVENTS) {
        document.removeEventListener(type, arm, true)
      }
      unregister()
    }
  }, [editor])

  return null
}

/**
 * Every form control a decorator can put on screen. Measured on the fixture
 * note: a read-only share page rendered 15 `<button>` elements and 2
 * `<textarea>` elements — the colour dots and body field of a callout, the
 * source field and controls of a mermaid diagram and of a gantt chart. None of
 * the node components in `Lexical/Nodes` consults `useLexicalEditable()`, so
 * they render their editing affordances whatever the editor is set to.
 */
export const SHARE_INERT_CONTROL_SELECTOR = 'input, textarea, select, button'

/** DOM events that would let one of those controls be driven by the reader. */
const DAMMED_EVENTS = [
  'pointerdown',
  'mousedown',
  'touchstart',
  'click',
  'dblclick',
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'change',
  'paste',
  'drop',
] as const

/**
 * Layer 5 of read-only, and the one that answers "a disabled-looking editor
 * that still wires edit handlers is not read-only" from the other side: the
 * controls above are not merely styled as inactive, they are made inert.
 *
 *  - the `inert` attribute removes the element and its subtree from hit
 *    testing, focus order and assistive technology while leaving it VISIBLE,
 *    so the body text of a callout is still readable in its textarea;
 *  - a capture-phase dam cancels the events anyway, which covers a browser
 *    without `inert` and any control added after the stamp;
 *  - a MutationObserver re-stamps, because a decorator that re-renders would
 *    otherwise reinstate a live control.
 *
 * Links and `<summary>` elements are deliberately NOT dammed: following a link
 * and folding a section are reading actions, not edits.
 */
export function SharedInertControls({ containerRef }: { containerRef: RefObject<HTMLElement | null> }): null {
  useEffect(() => {
    const container = containerRef.current
    if (container === null) {
      return
    }

    const stamp = () => {
      for (const control of Array.from(container.querySelectorAll(SHARE_INERT_CONTROL_SELECTOR))) {
        control.setAttribute('inert', '')
        control.setAttribute('tabindex', '-1')
        control.setAttribute('aria-disabled', 'true')
      }
    }

    const dam = (event: Event) => {
      const target = event.target
      if (target === null || !(target instanceof Element)) {
        return
      }
      if (target.closest(SHARE_INERT_CONTROL_SELECTOR) === null) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    }

    stamp()
    for (const type of DAMMED_EVENTS) {
      container.addEventListener(type, dam, true)
    }

    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(stamp)
    observer?.observe(container, { childList: true, subtree: true })

    return () => {
      for (const type of DAMMED_EVENTS) {
        container.removeEventListener(type, dam, true)
      }
      observer?.disconnect()
    }
  }, [containerRef])

  return null
}

type BoundaryProps = { children: JSX.Element; onError: (error: Error) => void }

/**
 * The boundary Lexical wraps every decorator in.
 *
 * Lexical isolates each decorator (`@lexical/react/shared/useDecorators`) and
 * renders the fallback of this boundary in its place, so a decorator that
 * throws takes out only itself. The stock `LexicalErrorBoundary` used by the
 * in-app editor renders a red "An error was thrown." box, and `fallback={null}`
 * renders nothing at all. NEITHER is right on a public page: the reader has no
 * other copy of the note, so a block that vanishes silently leaves them reading
 * an incomplete document believing it is complete.
 *
 * The fallback therefore NAMES the block that could not be drawn. The usual
 * cause here is a decorator that calls `useApplication()` — an embedded
 * encrypted file, an item bubble, a remote image — which throws by design,
 * because the public viewer has no WebApplication.
 */
class SharedDecoratorBoundaryImpl extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error : new Error(String(error)))
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children
    }
    return (
      <div
        data-share-unrenderable="true"
        className="border-border text-passive-0 my-2 rounded border border-dashed px-3 py-2 text-sm"
      >
        This block could not be displayed on a shared link.
      </div>
    )
  }
}

/**
 * Lexical types the boundary prop as a component taking a single-argument
 * `onError`; a function wrapper keeps the class private and keeps the prop
 * variance Lexical expects.
 */
export function SharedDecoratorBoundary({ children, onError }: BoundaryProps): JSX.Element {
  return <SharedDecoratorBoundaryImpl onError={onError}>{children}</SharedDecoratorBoundaryImpl>
}

export const SharedSuperContent = ({
  text,
  onBlockedMutation,
  onRedacted,
}: {
  text: string
  onBlockedMutation?: (count: number) => void
  /** Reports what was removed before the document was parsed. For specs. */
  onRedacted?: (redactions: ShareRedaction[]) => void
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)

  /*
   * Layer 0 of read-only, and the privacy boundary of a public page: the
   * serialized state is rewritten BEFORE Lexical parses it, so a node that
   * needs an application or that would fetch from a third party is never
   * constructed. See SharedNodePolicy — a runtime guard cannot close the
   * second case, because an `<iframe>` or `<img>` starts fetching when it
   * enters the document and a MutationObserver only runs afterwards.
   */
  const { text: safeText, redacted } = useMemo(() => redactShareNodes(text), [text])

  const onRedactedRef = useRef(onRedacted)
  onRedactedRef.current = onRedacted
  useEffect(() => {
    onRedactedRef.current?.(redacted)
  }, [redacted])

  return (
    <div ref={containerRef} data-shared-note-format="super">
      <BlocksEditorComposer readonly initialValue={safeText} key={safeText}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="ContentEditable__root blocks-editor relative resize-none focus:shadow-none focus:outline-none"
              spellCheck={false}
            />
          }
          ErrorBoundary={SharedDecoratorBoundary}
        />
        <SharedReadOnlyGuard onBlocked={onBlockedMutation} />
        <SharedInertControls containerRef={containerRef} />
        <ListPlugin />
        <ListStylePlugin />
        <TablePlugin hasCellMerge hasHorizontalScroll />
        <TableWidgetLayoutPlugin />
        <TableFilterPlugin />
        <CodeHighlightPlugin />
      </BlocksEditorComposer>
    </div>
  )
}

export default SharedSuperContent
