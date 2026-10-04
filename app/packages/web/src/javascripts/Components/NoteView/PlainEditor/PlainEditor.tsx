import { WebApplication } from '@/Application/WebApplication'
import { usePrevious } from '@/Components/ContentListView/Calendar/usePrevious'
import { ElementIds } from '@/Constants/ElementIDs'
import { log, LoggingDomain } from '@/Logging'
import { Disposer } from '@/Types/Disposer'
import { EditorEventSource } from '@/Types/EditorEventSource'
import { classNames } from '@standardnotes/utils'
import { useResponsiveEditorFontSize } from '@/Utils/getPlaintextFontSize'
import {
  ApplicationEvent,
  EditorFontSize,
  EditorLineHeight,
  isPayloadSourceRetrieved,
  WebAppEvent,
  PrefDefaults,
  LocalPrefKey,
  sanitizeHtmlString,
  PayloadEmitSource,
} from '@standardnotes/snjs'
import { markdownToHtml } from '@/Utils/markdownToHtml'
import { isIOS, TAB_COMMAND } from '@standardnotes/ui-services'
import {
  ChangeEventHandler,
  forwardRef,
  KeyboardEventHandler,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  FocusEvent,
} from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import { applyAction, decideBackspace, decideInsertion } from '@/Components/SuperEditor/Utils/AutoPair/autoPair'

type Props = {
  application: WebApplication
  spellcheck: boolean
  controller: NoteViewController
  locked: boolean
  onFocus: () => void
  onBlur: (event: FocusEvent) => void
  customBackgroundColor?: string
  customTextColor?: string
}

export type PlainEditorInterface = {
  focus: () => void
}

export const PlainEditor = forwardRef<PlainEditorInterface, Props>(
  ({ application, spellcheck, controller, locked, onFocus, onBlur, customBackgroundColor, customTextColor }, ref) => {
    const [editorText, setEditorText] = useState<string | undefined>()
    const [showPreview, setShowPreview] = useState(false)
    const [textareaUnloading, setTextareaUnloading] = useState(false)
    const [lineHeight, setLineHeight] = useState<EditorLineHeight | undefined>()
    const [fontSize, setFontSize] = useState<EditorFontSize | undefined>()
    const responsiveFontSize = useResponsiveEditorFontSize(fontSize || EditorFontSize.Normal)
    const previousSpellcheck = usePrevious(spellcheck)

    const lastEditorFocusEventSource = useRef<EditorEventSource | undefined>(undefined)
    const needsAdjustMobileCursor = useRef(false)
    const isAdjustingMobileCursor = useRef(false)
    const note = useRef(controller.item)

    const [isPendingLocalPropagation, setIsPendingLocalPropagation] = useState(false)
    const localPropagationGeneration = useRef(0)

    const tabObserverDisposer = useRef<Disposer | undefined>(undefined)
    const mutationObserver = useRef<MutationObserver | null>(null)
    /**
     * THIS editor's own textarea. The tiled editor mounts one NoteView — and so one
     * PlainEditor — per open note, and every one renders `ElementIds.NoteTextEditor`,
     * so `document.getElementById` resolves to whichever note is first in the document.
     * See `focusEditor`.
     */
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)

    useImperativeHandle(ref, () => ({
      focus() {
        focusEditor()
      },
    }))

    useEffect(() => {
      return () => {
        localPropagationGeneration.current += 1
        mutationObserver.current?.disconnect()
        tabObserverDisposer.current?.()
        tabObserverDisposer.current = undefined
        mutationObserver.current = null
      }
    }, [])

    useEffect(() => {
      const disposer = controller.addNoteInnerValueChangeObserver((updatedNote, source) => {
        if (updatedNote.uuid !== note.current.uuid) {
          throw Error('Editor received changes for non-current note')
        }

        const isAssistantReplacement = source === PayloadEmitSource.AssistantChanged
        if (isAssistantReplacement || !isPendingLocalPropagation) {
          if (
            isPayloadSourceRetrieved(source) ||
            isAssistantReplacement ||
            editorText == undefined ||
            updatedNote.editorIdentifier !== note.current.editorIdentifier ||
            updatedNote.noteType !== note.current.noteType
          ) {
            setEditorText(updatedNote.text)
          }
        }

        note.current = updatedNote
      })

      return disposer
    }, [
      controller,
      editorText,
      controller.item.uuid,
      controller.item.editorIdentifier,
      controller.item.noteType,
      isPendingLocalPropagation,
    ])

    const commitText = useCallback(
      (text: string) => {
        const generation = ++localPropagationGeneration.current
        setEditorText(text)
        setIsPendingLocalPropagation(true)
        const finishCurrentPropagation = () => {
          if (localPropagationGeneration.current === generation) {
            setIsPendingLocalPropagation(false)
          }
        }
        void controller
          .saveAndAwaitLocalPropagation({ text: text, isUserModified: true })
          .then(finishCurrentPropagation, finishCurrentPropagation)
      },
      [controller],
    )

    const onTextAreaChange: ChangeEventHandler<HTMLTextAreaElement> = ({ currentTarget }) => {
      commitText(currentTarget.value)
    }

    /**
     * Auto-pair brackets/quotes in the plain <textarea>, mirroring the Super
     * editor. Uses the same pure `autoPair` helper to decide the action, then
     * mutates the textarea's value + selection directly and routes the change
     * through `commitText` so the note saves. Returns early (lets the browser
     * handle the key normally) when the helper decides `none`, so existing
     * behaviour — including the Tab-to-spaces command handler, which fires on a
     * different key — is preserved. IME composition is skipped so multi-key
     * input is never auto-paired.
     */
    const onTextAreaKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
      if (locked || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        return
      }

      const target = event.currentTarget
      const ctx = {
        text: target.value,
        selection: { start: target.selectionStart ?? 0, end: target.selectionEnd ?? 0 },
      }

      const action =
        event.key === 'Backspace'
          ? decideBackspace(ctx)
          : event.key.length === 1
            ? decideInsertion(event.key, ctx)
            : { type: 'none' as const }

      if (action.type === 'none') {
        return
      }

      event.preventDefault()
      const result = applyAction(action, ctx)
      commitText(result.text)
      // Restore caret/selection after React re-renders the controlled value.
      requestAnimationFrame(() => {
        target.setSelectionRange(result.selection.start, result.selection.end)
      })
    }

    const onContentFocus = useCallback(() => {
      if (!isAdjustingMobileCursor.current) {
        needsAdjustMobileCursor.current = true
      }

      application.notifyWebEvent(WebAppEvent.EditorDidFocus, { eventSource: lastEditorFocusEventSource.current })

      lastEditorFocusEventSource.current = undefined

      onFocus()
    }, [application, isAdjustingMobileCursor, lastEditorFocusEventSource, onFocus])

    const onContentBlur = useCallback(
      (event: FocusEvent) => {
        lastEditorFocusEventSource.current = undefined

        onBlur(event)
      },
      [lastEditorFocusEventSource, onBlur],
    )

    const scrollMobileCursorIntoViewAfterWebviewResize = useCallback(() => {
      if (needsAdjustMobileCursor.current) {
        needsAdjustMobileCursor.current = false
        isAdjustingMobileCursor.current = true
        document.getElementById('note-text-editor')?.blur()
        document.getElementById('note-text-editor')?.focus()
        isAdjustingMobileCursor.current = false
      }
    }, [needsAdjustMobileCursor])

    useEffect(() => {
      const disposer = application.addWebEventObserver((event) => {
        if (event === WebAppEvent.MobileKeyboardWillChangeFrame) {
          scrollMobileCursorIntoViewAfterWebviewResize()
        }
      })
      return disposer
    }, [application, scrollMobileCursorIntoViewAfterWebviewResize])

    /**
     * Focus THIS note's body, and never a sibling tile's.
     *
     * Standard Red Notes (t112): this used to be
     * `document.getElementById(ElementIds.NoteTextEditor)?.focus()`, which with two or
     * more notes open focused whichever note was FIRST in the document. Both routes in
     * reach it per instance already — `useImperativeHandle` (NoteView's `plainEditorRef`,
     * which is how pressing Enter in the title moves into the body) and the template-note
     * autofocus effect — so the global lookup was the only thing making them land on the
     * wrong note. Pressing Enter after renaming a title therefore dropped the cursor into
     * a different note's text.
     *
     * A null ref (preview mode, or the textarea remounting for a spellcheck change) now
     * means "nothing of mine to focus", which is the honest answer; before, it meant
     * "focus someone else's".
     */
    const focusEditor = useCallback(() => {
      const element = textareaRef.current
      if (element) {
        lastEditorFocusEventSource.current = EditorEventSource.Script
        element.focus()
      }
    }, [])

    useEffect(() => {
      const shouldFocus = controller.isTemplateNote && controller.templateNoteOptions?.autofocusBehavior === 'editor'

      if (shouldFocus) {
        focusEditor()
      }
    }, [controller, focusEditor])

    const reloadPreferences = useCallback(() => {
      const lineHeight = application.preferences.getLocalValue(
        LocalPrefKey.EditorLineHeight,
        PrefDefaults[LocalPrefKey.EditorLineHeight],
      )
      const fontSize = application.preferences.getLocalValue(
        LocalPrefKey.EditorFontSize,
        PrefDefaults[LocalPrefKey.EditorFontSize],
      )

      setLineHeight(lineHeight)
      setFontSize(fontSize)
    }, [application])

    useEffect(() => {
      reloadPreferences()

      return application.addEventObserver(async (event) => {
        const events = [ApplicationEvent.PreferencesChanged, ApplicationEvent.LocalPreferencesChanged]
        if (events.includes(event)) {
          reloadPreferences()
        }
      })
    }, [reloadPreferences, application])

    useEffect(() => {
      if (previousSpellcheck === undefined) {
        return
      }

      if (spellcheck !== previousSpellcheck) {
        setTextareaUnloading(true)
        setTimeout(() => {
          setTextareaUnloading(false)
        }, 0)
      }
    }, [spellcheck, previousSpellcheck])

    const onRef = useCallback(
      (ref: HTMLTextAreaElement | null) => {
        // Recorded before the early return below, so this instance keeps a handle on its
        // own textarea even once the tab observer is installed, and drops it (null) when
        // the textarea unmounts.
        textareaRef.current = ref

        if (tabObserverDisposer.current || !ref) {
          return
        }

        log(LoggingDomain.NoteView, 'On system editor ref')

        /**
         * Insert 4 spaces when a tab key is pressed, only used when inside of the text editor.
         * If the shift key is pressed first, this event is not fired.
         *
         * The element comes from the ref, not from `getElementById(NoteTextEditor)`: with
         * several tiles open that id is duplicated, so the handler and the mutation
         * observer below would have been attached to another note's textarea.
         */
        const editor = ref

        tabObserverDisposer.current = application.keyboardService.addCommandHandler({
          element: editor,
          command: TAB_COMMAND,
          onKeyDown: (event) => {
            if (document.hidden || note.current.locked || event.shiftKey) {
              return
            }
            event.preventDefault()
            /** Using document.execCommand gives us undo support */
            const insertSuccessful = document.execCommand('insertText', false, '\t')
            if (!insertSuccessful) {
              /** document.execCommand works great on Chrome/Safari but not Firefox */
              const start = editor.selectionStart || 0
              const end = editor.selectionEnd || 0
              const spaces = '    '
              /** Insert 4 spaces */
              editor.value = editor.value.substring(0, start) + spaces + editor.value.substring(end)
              /** Place cursor 4 spaces away from where the tab key was pressed */
              editor.selectionStart = editor.selectionEnd = start + 4
            }

            commitText(editor.value)
          },
        })

        const observer = new MutationObserver((records) => {
          for (const record of records) {
            record.removedNodes.forEach((node) => {
              if (node.isEqualNode(editor)) {
                tabObserverDisposer.current?.()
                tabObserverDisposer.current = undefined
                observer.disconnect()
              }
            })
          }
        })

        observer.observe(editor.parentElement as HTMLElement, { childList: true })

        mutationObserver.current = observer
      },
      [application.keyboardService, commitText],
    )

    if (textareaUnloading) {
      return null
    }

    // Standard Red Notes: per-note custom appearance. When no override is set
    // these are `undefined`, so no inline color is emitted and the theme/CSS
    // fully controls the surface.
    const surfaceStyle = {
      backgroundColor: customBackgroundColor,
      color: customTextColor,
    }

    return (
      <div className="flex h-full flex-grow flex-col overflow-hidden" style={surfaceStyle}>
        <div className="plain-editor-mode-toggle border-border bg-contrast flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1 text-xs">
          <button
            type="button"
            className={classNames(
              'touch-manipulation rounded px-2 py-1.5 font-semibold whitespace-nowrap md:py-0.5',
              !showPreview ? 'bg-info text-info-contrast' : 'text-neutral hover:bg-default',
            )}
            onClick={() => setShowPreview(false)}
          >
            Edit
          </button>
          <button
            type="button"
            className={classNames(
              'touch-manipulation rounded px-2 py-1.5 font-semibold whitespace-nowrap md:py-0.5',
              showPreview ? 'bg-info text-info-contrast' : 'text-neutral hover:bg-default',
            )}
            onClick={() => setShowPreview(true)}
          >
            Markdown preview
          </button>
        </div>
        {showPreview ? (
          <div
            className={classNames('markdown-preview font-editor flex-grow overflow-auto p-4', responsiveFontSize)}
            style={surfaceStyle}
            dangerouslySetInnerHTML={{ __html: sanitizeHtmlString(markdownToHtml(editorText ?? '')) }}
          />
        ) : (
          <textarea
            autoComplete="off"
            dir="auto"
            id={ElementIds.NoteTextEditor}
            onChange={onTextAreaChange}
            onKeyDown={onTextAreaKeyDown}
            onFocus={onContentFocus}
            onBlur={onContentBlur}
            readOnly={locked}
            ref={onRef}
            spellCheck={spellcheck}
            value={editorText}
            style={surfaceStyle}
            className={classNames(
              'editable font-editor flex-grow',
              lineHeight && `leading-${lineHeight.toLowerCase()}`,
              responsiveFontSize,
              // Extra bottom padding is added on iOS so that text
              // doesn't get hidden by the floating "Close keyboard" button
              isIOS() && '!pb-12',
            )}
          ></textarea>
        )}
      </div>
    )
  },
)
