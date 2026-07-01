import { FocusEvent, FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { ClearEditorPlugin } from '@lexical/react/LexicalClearEditorPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { TablePlugin } from '@lexical/react/LexicalTablePlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HashtagPlugin } from '@lexical/react/LexicalHashtagPlugin'
import SuperHistoryPlugin from './Plugins/HistoryPlugin/SuperHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { EditorState, LexicalEditor } from 'lexical'
import HorizontalRulePlugin from './Plugins/HorizontalRulePlugin'
import CollapsiblePlugin from './Plugins/CollapsiblePlugin'
import FootnotePlugin from './Plugins/FootnotePlugin/FootnotePlugin'
import BookmarkPlugin from './Plugins/BookmarkPlugin/BookmarkPlugin'
import FoldablePlugin from './Plugins/FoldablePlugin/FoldablePlugin'
import DraggableBlockPlugin from './Plugins/DraggableBlockPlugin'
import CodeHighlightPlugin from './Plugins/CodeHighlightPlugin'
import { TabIndentationPlugin } from './Plugins/TabIndentationPlugin'
import { createFlushableDebounce, handleEditorChange } from './Utils'
import { SuperEditorContentId } from './Constants'
import { classNames } from '@standardnotes/utils'
import { MarkdownTransformers } from './MarkdownTransformers'
import { RemoveBrokenTablesPlugin } from './Plugins/TablePlugin'
import TableActionMenuPlugin from './Plugins/TableCellActionMenuPlugin'
import ToolbarPlugin from './Plugins/ToolbarPlugin/ToolbarPlugin'
import ListStylePlugin from './Plugins/ListStylePlugin/ListStylePlugin'
import { useMediaQuery, MutuallyExclusiveMediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import RemoteImagePlugin from './Plugins/RemoteImagePlugin/RemoteImagePlugin'
import CodeOptionsPlugin from './Plugins/CodeOptionsPlugin/CodeOptions'
import { SearchPlugin } from './Plugins/SearchPlugin/SearchPlugin'
import AutoLinkPlugin from './Plugins/AutoLinkPlugin/AutoLinkPlugin'
import DatetimePlugin from './Plugins/DateTimePlugin/DateTimePlugin'
import PasswordPlugin from './Plugins/PasswordPlugin/PasswordPlugin'
import { CheckListPlugin } from './Plugins/CheckListPlugin'
import GoogleDocsPastePlugin from './Plugins/GoogleDocsPastePlugin/GoogleDocsPastePlugin'
import MultiCursorPlugin from './Plugins/MultiCursorPlugin/MultiCursorPlugin'
import AutoPairPlugin from './Plugins/AutoPairPlugin/AutoPairPlugin'
import FormattingMarksPlugin from './Plugins/FormattingMarksPlugin/FormattingMarksPlugin'
import { FormatPainterPlugin } from './Plugins/FormatPainterPlugin'
import { SuperCollaborationPlugin, CollaborationConfig } from './Collaboration/CollaborationPlugin'
import { WebApplication } from '@/Application/WebApplication'

type BlocksEditorProps = {
  /**
   * Standard Red Notes (last-edit-loss fix): `bypassDebounce` is true ONLY when the
   * change originates from a lifecycle flush (note-switch/unmount/blur/logout/unload),
   * signalling the save path to skip the 700ms sync debounce so the edit is dirtied +
   * persisted immediately. Normal typing omits it (preserves the typing-freeze fix).
   */
  onChange?: (value: string, preview: string, bypassDebounce?: boolean) => void
  className?: string
  children?: React.ReactNode
  previewLength?: number
  spellcheck?: boolean
  ignoreFirstChange?: boolean
  readonly?: boolean
  onFocus?: (event: FocusEvent) => void
  onBlur?: (event: FocusEvent) => void
  /** When set, enables live co-editing (opt-in; shared-vault notes only). */
  collaboration?: CollaborationConfig
  application?: WebApplication
  /**
   * Standard Red Notes (last-edit-loss fix): register the editor's debounce control
   * with the owner (SuperEditor -> NoteViewController + the beforeunload hook) so
   * lifecycle code can (a) detect a serialize mid-debounce and (b) force-flush it
   * before the controller/tab is torn down. Returns an unregister disposer.
   */
  registerDebounceControl?: (control: { flush: () => void; hasPending: () => boolean }) => () => void
}

export const BlocksEditor: FunctionComponent<BlocksEditorProps> = ({
  onChange,
  className,
  children,
  previewLength,
  spellcheck,
  ignoreFirstChange = false,
  readonly,
  onFocus,
  onBlur,
  collaboration,
  application,
  registerDebounceControl,
}) => {
  const [didIgnoreFirstChange, setDidIgnoreFirstChange] = useState(false)

  /**
   * Standard Red Notes (FIX 1): serializing the whole document
   * (JSON.stringify(editorState.toJSON())) is O(doc-size) and previously ran on
   * EVERY change, freezing typing on large (e.g. 500KB) notes. We DEBOUNCE the
   * serialize/onChange with a trailing timer so rapid typing serializes at most
   * once per window. Correctness is preserved by FLUSHING any pending serialize
   * on blur and on unmount, so the latest content is always captured before
   * save/blur and no trailing edit is lost.
   */
  const SerializeDebounceMs = 350
  // Refs keep the debounced serialize stable across renders while always reading
  // the current onChange/previewLength.
  const onChangeRef = useRef(onChange)
  const previewLengthRef = useRef(previewLength)
  onChangeRef.current = onChange
  previewLengthRef.current = previewLength

  /**
   * Standard Red Notes (last-edit-loss fix): when the pending serialize is FLUSHED at
   * a lifecycle boundary (note-switch/unmount/blur/logout/unload) we forward
   * bypassDebounce=true to onChange so the save path skips the 700ms sync debounce and
   * the edit is dirtied + persisted immediately. Set true only for the duration of a
   * lifecycle flush; the normal trailing fire keeps it false (preserves typing perf).
   */
  const flushShouldBypassRef = useRef(false)

  const debouncedSerializeRef = useRef(
    createFlushableDebounce((editorState: EditorState) => {
      const bypass = flushShouldBypassRef.current
      editorState.read(() => {
        handleEditorChange(editorState, previewLengthRef.current, (value, previewText) => {
          onChangeRef.current?.(value, previewText, bypass)
        })
      })
    }, SerializeDebounceMs),
  )

  // Flush the pending serialize, forwarding bypassDebounce so the lifecycle save is
  // immediate. The flag is reset afterwards so a later natural trailing fire debounces.
  const flushWithBypass = useCallback(() => {
    flushShouldBypassRef.current = true
    try {
      debouncedSerializeRef.current.flush()
    } finally {
      flushShouldBypassRef.current = false
    }
  }, [])

  /**
   * Standard Red Notes (last-edit-loss fix): expose the debounce's flush + hasPending
   * to the owner (SuperEditor -> NoteViewController, and the beforeunload hook) so
   * lifecycle code can detect a mid-debounce edit and force it through the save path
   * before teardown. Re-registers if the callback identity changes.
   */
  useEffect(() => {
    if (!registerDebounceControl) {
      return
    }
    const debounced = debouncedSerializeRef.current
    return registerDebounceControl({
      flush: flushWithBypass,
      hasPending: () => debounced.hasPending(),
    })
  }, [registerDebounceControl, flushWithBypass])

  const handleChange = useCallback(
    (editorState: EditorState, _editor: LexicalEditor) => {
      if (ignoreFirstChange && !didIgnoreFirstChange) {
        setDidIgnoreFirstChange(true)
        return
      }

      // Always remember the latest state; the trailing flush serializes it.
      debouncedSerializeRef.current(editorState)
    },
    [ignoreFirstChange, didIgnoreFirstChange],
  )

  // Flush any pending serialize when the editor loses focus so a save triggered
  // by blur never loses the last keystrokes. Bypass the sync debounce so the blur
  // save is immediate.
  const handleBlur = useCallback(
    (event: FocusEvent) => {
      flushWithBypass()
      onBlur?.(event)
    },
    [onBlur, flushWithBypass],
  )

  // Flush on unmount so an in-flight debounced edit is captured (and the timer is
  // not left dangling) when the editor is torn down.
  useEffect(() => {
    return () => {
      flushWithBypass()
    }
  }, [flushWithBypass])

  /**
   * Standard Red Notes (last-edit-loss fix — beforeunload best-effort): beforeunload
   * cannot await async work, so on tab close/reload we SYNCHRONOUSLY flush the pending
   * serialize with the sync debounce BYPASSED. That dirties the item and initiates the
   * local IDB save synchronously, maximizing the chance it persists and making the
   * native unsaved-changes warning (driven by useUnsavedChangesWarning) accurate. A
   * truly last-instant edit may still not finish its async IDB write before the tab
   * dies — accepted; this is a large improvement over the prior silent no-op loss.
   */
  useEffect(() => {
    const handleBeforeUnload = () => {
      flushWithBypass()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [flushWithBypass])

  const [floatingAnchorElem, setFloatingAnchorElem] = useState<HTMLDivElement | null>(null)

  const onRef = (_floatingAnchorElem: HTMLDivElement) => {
    if (_floatingAnchorElem !== null) {
      setFloatingAnchorElem(_floatingAnchorElem)
    }
  }

  const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  return (
    <>
      {!isMobile && <ToolbarPlugin />}
      <div className="relative min-h-0 flex-grow">
        <RichTextPlugin
          contentEditable={
            <div id="blocks-editor" className="editor-scroller h-full min-h-0">
              <div className="editor z-0 overflow-hidden" ref={onRef}>
                <ContentEditable
                  id={SuperEditorContentId}
                  className={classNames(
                    'ContentEditable__root relative overflow-y-auto p-4 text-[length:--font-size] leading-[--line-height] focus:shadow-none focus:outline-none',
                    className,
                  )}
                  spellCheck={spellcheck}
                  onFocus={onFocus}
                  onBlur={handleBlur}
                />
                <div className="search-highlight-container pointer-events-none absolute left-0 top-0 h-full w-full" />
              </div>
            </div>
          }
          placeholder={
            <div className="pointer-events-none absolute left-4 top-4 text-[length:--font-size] text-passive-1">
              Type <span className="rounded bg-passive-4-opacity-variant p-0.5">/</span> for commands...
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      {isMobile && <ToolbarPlugin />}
      <ListPlugin />
      <ListStylePlugin />
      <MarkdownShortcutPlugin transformers={MarkdownTransformers} />
      <TablePlugin hasCellMerge />
      <OnChangePlugin onChange={handleChange} ignoreSelectionChange={true} />
      {collaboration && application ? (
        <SuperCollaborationPlugin application={application} config={collaboration} />
      ) : (
        <SuperHistoryPlugin />
      )}
      <HorizontalRulePlugin />
      <ClearEditorPlugin />
      <CheckListPlugin />
      <CodeHighlightPlugin />
      <LinkPlugin />
      <HashtagPlugin />
      <CollapsiblePlugin />
      <FootnotePlugin />
      <BookmarkPlugin />
      <FoldablePlugin />
      <TabIndentationPlugin />
      <RemoveBrokenTablesPlugin />
      <RemoteImagePlugin />
      <CodeOptionsPlugin />
      <SearchPlugin />
      <DatetimePlugin />
      <PasswordPlugin />
      <AutoLinkPlugin />
      <GoogleDocsPastePlugin />
      <MultiCursorPlugin />
      <AutoPairPlugin />
      <FormattingMarksPlugin />
      <FormatPainterPlugin />
      {!readonly && floatingAnchorElem && (
        <>
          <DraggableBlockPlugin anchorElem={floatingAnchorElem} />
          <TableActionMenuPlugin anchorElem={floatingAnchorElem} cellMerge />
        </>
      )}
      {children}
    </>
  )
}
