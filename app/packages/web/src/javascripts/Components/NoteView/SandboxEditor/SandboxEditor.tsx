import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import {
  FunctionComponent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import {
  SandboxDocument,
  SandboxPane,
  SANDBOX_CONSOLE_CHANNEL,
  buildSandboxSrcdoc,
  createEmptySandboxDocument,
  createJsSandboxStarter,
  createWebSandboxStarter,
  parseSandboxDocument,
  serializeSandboxDocument,
} from './SandboxDocument'

/** Identifier stored in `note.editorIdentifier` to mark a note as a JS Sandbox. */
export const JsSandboxEditorIdentifier = 'org.standardnotes.js-sandbox'
/** Identifier stored in `note.editorIdentifier` to mark a note as a Web App Sandbox. */
export const WebSandboxEditorIdentifier = 'org.standardnotes.web-sandbox'

export type SandboxMode = 'js' | 'web'

/** Resolve the editor mode from a note's editorIdentifier. */
export const sandboxModeForIdentifier = (identifier: string | undefined): SandboxMode =>
  identifier === JsSandboxEditorIdentifier ? 'js' : 'web'

const PERSIST_DEBOUNCE_MS = 400
const AUTO_RUN_DEBOUNCE_MS = 600

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error'

type ConsoleEntry = {
  id: number
  level: ConsoleLevel
  message: string
}

type Props = {
  application: WebApplication
  controller: NoteViewController
  /** 'js' = JS-focused with console panel; 'web' = full rendered preview. */
  mode: SandboxMode
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

/** Insert a literal tab on Tab keypress inside a textarea (keeps focus in the pane). */
const handleTabKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>, onChange: (value: string) => void) => {
  if (event.key !== 'Tab' || event.shiftKey) {
    return
  }
  event.preventDefault()
  const target = event.currentTarget
  const start = target.selectionStart
  const end = target.selectionEnd
  const next = target.value.slice(0, start) + '  ' + target.value.slice(end)
  onChange(next)
  // Restore the caret just after the inserted spaces.
  requestAnimationFrame(() => {
    target.selectionStart = target.selectionEnd = start + 2
  })
}

export const SandboxEditor: FunctionComponent<Props> = ({
  application,
  controller,
  mode,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseSandboxDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<SandboxDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)
  const [activePane, setActivePane] = useState<SandboxPane>(
    initialParse.document.activePane ?? (mode === 'js' ? 'js' : 'html'),
  )
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  /** Bumped on each Run to force the iframe to rebuild (and reset) its srcdoc. */
  const [runToken, setRunToken] = useState(0)
  /** The document snapshot currently rendered into the iframe. */
  const [runDocument, setRunDocument] = useState<SandboxDocument>(initialParse.document)

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoRunTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const consoleCounter = useRef(0)

  const isReadonly = note.current.locked || Boolean(readonly)
  const captureConsole = mode === 'js'

  const persist = useCallback(
    (doc: SandboxDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        void controller.saveAndAwaitLocalPropagation({
          text: serializeSandboxDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain:
              mode === 'js'
                ? `JS Sandbox: ${doc.js.length} chars of JS`
                : `Web App Sandbox: ${doc.html.length + doc.css.length + doc.js.length} chars`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly, mode],
  )

  const updateDocument = useCallback(
    (updater: (doc: SandboxDocument) => SandboxDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local sandbox.
  useEffect(() => {
    const disposer = controller.addNoteInnerValueChangeObserver((updatedNote, source) => {
      if (updatedNote.uuid !== note.current.uuid) {
        return
      }
      note.current = updatedNote
      if (ignoreNextChange.current) {
        ignoreNextChange.current = false
        return
      }
      if (isPayloadSourceRetrieved(source)) {
        const { document: parsed } = parseSandboxDocument(updatedNote.text)
        setDocument(parsed)
      }
    })
    return disposer
  }, [controller])

  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      if (autoRunTimer.current) {
        clearTimeout(autoRunTimer.current)
      }
    }
  }, [])

  // Run the current document: snapshot it into the iframe and reset the console.
  const run = useCallback(() => {
    setConsoleEntries([])
    setRunDocument(document)
    setRunToken((token) => token + 1)
  }, [document])

  // Web App Sandbox auto-runs (debounced) as the code changes; JS Sandbox is
  // manual-run only so console output isn't spammed mid-typing.
  useEffect(() => {
    if (mode !== 'web') {
      return
    }
    if (autoRunTimer.current) {
      clearTimeout(autoRunTimer.current)
    }
    autoRunTimer.current = setTimeout(() => {
      setRunDocument(document)
      setRunToken((token) => token + 1)
    }, AUTO_RUN_DEBOUNCE_MS)
    return () => {
      if (autoRunTimer.current) {
        clearTimeout(autoRunTimer.current)
      }
    }
  }, [mode, document])

  // Listen for console messages posted by the sandbox iframe. The source is
  // validated to be exactly our iframe's contentWindow so no other frame can
  // inject lines into the panel.
  useEffect(() => {
    if (!captureConsole) {
      return
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }
      const data = event.data as { channel?: unknown; level?: unknown; message?: unknown } | null
      if (!data || data.channel !== SANDBOX_CONSOLE_CHANNEL) {
        return
      }
      const level: ConsoleLevel =
        data.level === 'warn' || data.level === 'error' || data.level === 'info' ? data.level : 'log'
      const message = typeof data.message === 'string' ? data.message : String(data.message)
      consoleCounter.current += 1
      setConsoleEntries((prev) => [...prev, { id: consoleCounter.current, level, message }])
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [captureConsole])

  const srcdoc = useMemo(
    () => buildSandboxSrcdoc(runDocument, { captureConsole }),
    [runDocument, captureConsole, runToken],
  )

  const setPaneValue = useCallback(
    (pane: SandboxPane, value: string) => {
      updateDocument((doc) => ({ ...doc, [pane]: value, activePane: pane }))
    },
    [updateDocument],
  )

  const selectPane = useCallback(
    (pane: SandboxPane) => {
      setActivePane(pane)
      updateDocument((doc) => ({ ...doc, activePane: pane }))
    },
    [updateDocument],
  )

  // JS Sandbox leads with the JS pane; Web App Sandbox shows HTML/CSS/JS evenly.
  const panes: SandboxPane[] = mode === 'js' ? ['js', 'html', 'css'] : ['html', 'css', 'js']

  const paneLabel: Record<SandboxPane, string> = { html: 'HTML', css: 'CSS', js: 'JS' }

  const codeTextareaClass =
    'h-full w-full flex-grow resize-none border-0 bg-default p-3 font-mono text-sm leading-relaxed text-text outline-none'

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="code" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">
            {mode === 'js' ? 'JS Sandbox' : 'Web App Sandbox'}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 text-xs text-passive-1 sm:flex" title="Your code runs in an isolated sandboxed iframe in your browser. It cannot reach this app, your cookies, or storage.">
            <Icon type="lock" size="small" />
            Isolated sandbox
          </span>
          <button
            className="flex items-center gap-1 rounded bg-info px-3 py-1 text-sm font-semibold text-info-contrast hover:opacity-90"
            onClick={run}
            title="Run code"
          >
            <Icon type="arrow-right" size="small" />
            Run
          </button>
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a sandbox and a blank one was started. Your original text is
            preserved until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Editor + preview. Stacks vertically on mobile, side-by-side on md+. */}
      <div className="flex min-h-0 flex-grow flex-col md:flex-row">
        {/* Code panes */}
        <div className="flex min-h-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
          <div className="flex items-center gap-1 border-b border-border bg-contrast px-2 py-1">
            {panes.map((pane) => (
              <button
                key={pane}
                className={classNames(
                  'rounded px-3 py-1 text-xs font-semibold',
                  activePane === pane ? 'bg-info text-info-contrast' : 'text-passive-1 hover:bg-default',
                )}
                onClick={() => selectPane(pane)}
              >
                {paneLabel[pane]}
              </button>
            ))}
          </div>
          <div className="flex min-h-[12rem] flex-grow md:min-h-0">
            {panes.map((pane) => (
              <textarea
                key={pane}
                className={classNames(codeTextareaClass, activePane === pane ? 'block' : 'hidden')}
                value={document[pane]}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                disabled={isReadonly}
                placeholder={
                  pane === 'js'
                    ? '// JavaScript'
                    : pane === 'css'
                      ? '/* CSS */'
                      : '<!-- HTML -->'
                }
                onChange={(event) => setPaneValue(pane, event.target.value)}
                onKeyDown={(event) => handleTabKey(event, (value) => setPaneValue(pane, value))}
                aria-label={`${paneLabel[pane]} code`}
              />
            ))}
          </div>
        </div>

        {/* Preview / output */}
        <div className="flex min-h-[12rem] flex-1 flex-col md:min-h-0">
          {mode === 'js' ? (
            <>
              <div className="flex items-center justify-between border-b border-border bg-contrast px-3 py-1 text-xs font-semibold text-passive-1">
                <span>Console</span>
                {consoleEntries.length > 0 && (
                  <button className="text-info hover:underline" onClick={() => setConsoleEntries([])}>
                    Clear
                  </button>
                )}
              </div>
              <div className="min-h-0 flex-grow overflow-auto bg-default p-2 font-mono text-xs">
                {consoleEntries.length === 0 ? (
                  <p className="text-passive-2">Press Run to execute your JavaScript and see console output here.</p>
                ) : (
                  consoleEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className={classNames(
                        'whitespace-pre-wrap break-words border-b border-border py-1',
                        entry.level === 'error'
                          ? 'text-danger'
                          : entry.level === 'warn'
                            ? 'text-warning'
                            : 'text-text',
                      )}
                    >
                      {entry.message}
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-border bg-contrast px-3 py-1 text-xs font-semibold text-passive-1">
                Preview
              </div>
              <div className="min-h-0 flex-grow bg-white">
                <iframe
                  ref={iframeRef}
                  key={runToken}
                  title="Web App Sandbox preview"
                  className="h-full w-full border-0"
                  sandbox="allow-scripts"
                  srcDoc={srcdoc}
                />
              </div>
            </>
          )}
          {/* JS Sandbox still needs a (hidden) iframe to actually run the code and
              post console messages back. Web mode renders the visible iframe above. */}
          {mode === 'js' && (
            <iframe
              ref={iframeRef}
              key={runToken}
              title="JS Sandbox runner"
              className="h-0 w-0"
              sandbox="allow-scripts"
              srcDoc={srcdoc}
              aria-hidden
            />
          )}
        </div>
      </div>
    </div>
  )
}

export const initializeJsSandboxNoteText = (): string => serializeSandboxDocument(createJsSandboxStarter())
export const initializeWebSandboxNoteText = (): string => serializeSandboxDocument(createWebSandboxStarter())
export const initializeEmptySandboxNoteText = (): string => serializeSandboxDocument(createEmptySandboxDocument())
