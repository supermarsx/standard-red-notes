import { FunctionComponent, useCallback, useMemo, useRef, useState } from 'react'
import { $createRangeSelection, $getSelection, $isRangeSelection, $setSelection, LexicalEditor } from 'lexical'
import { classNames } from '@standardnotes/utils'
import { addToast, ToastType } from '@standardnotes/toast'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  buildTranslateInstruction,
  getSelectionActions,
  getSelectionAIAvailability,
  runSelectionAction,
  SelectionAction,
} from '@/Assistant/selectionActions'
import { filterLanguages } from '@/Assistant/languages'

type PointSnapshot = { key: string; offset: number; type: 'text' | 'element' }
type SelectionSnapshot = { text: string; anchor: PointSnapshot; focus: PointSnapshot }

const BTN =
  'flex select-none items-center justify-center rounded-md p-2.5 text-text transition-colors duration-75 hover:bg-passive-4 active:bg-passive-3 disabled:opacity-40 md:p-2'

function captureSelection(editor: LexicalEditor): SelectionSnapshot | null {
  let snapshot: SelectionSnapshot | null = null
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection) && !selection.isCollapsed()) {
      snapshot = {
        text: selection.getTextContent(),
        anchor: { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type },
        focus: { key: selection.focus.key, offset: selection.focus.offset, type: selection.focus.type },
      }
    }
  })
  return snapshot
}

function restoreAndReplace(editor: LexicalEditor, snapshot: SelectionSnapshot, replacement: string) {
  editor.update(() => {
    const selection = $createRangeSelection()
    selection.anchor.set(snapshot.anchor.key, snapshot.anchor.offset, snapshot.anchor.type)
    selection.focus.set(snapshot.focus.key, snapshot.focus.offset, snapshot.focus.type)
    $setSelection(selection)
    selection.insertText(replacement)
  })
}

type RunExtra = { customInstruction?: string; language?: string }

/**
 * One toolbar icon per AI action (replacing the former single greyed-out
 * dropdown). Plain actions run on click; the freeform "Ask" and the
 * language-picking "Translate" actions open a small popover for their extra
 * input. All icons grey out when there is no selection or while a request runs.
 */
const ActionButton: FunctionComponent<{
  action: SelectionAction
  disabledBase: boolean
  unavailableReason?: string
  busy: string | null
  run: (action: SelectionAction, extra?: RunExtra) => Promise<void>
}> = ({ action, disabledBase, unavailableReason, busy, run }) => {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [askText, setAskText] = useState('')
  const [languageQuery, setLanguageQuery] = useState('')

  const isBusy = busy === action.label
  const disabled = disabledBase || busy !== null
  const title = unavailableReason ?? (isBusy ? `${action.label}…` : action.label)
  const opensPopover = action.freeform || action.needsLanguage

  const button = (
    <button
      ref={ref}
      type="button"
      className={classNames(BTN, open && 'bg-passive-3')}
      disabled={disabled}
      title={title}
      aria-label={action.label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => (opensPopover ? setOpen((value) => !value) : void run(action))}
    >
      <Icon type={action.icon} size="custom" className="h-5 w-5 text-info md:h-4 md:w-4" />
    </button>
  )

  if (!opensPopover) {
    return button
  }

  return (
    <>
      {button}
      <Popover
        title={action.label}
        anchorElement={ref}
        open={open}
        togglePopover={() => setOpen(!open)}
        side="bottom"
        align="end"
        className="w-64 p-2"
      >
        {action.freeform ? (
          <div className="flex flex-col gap-1">
            <textarea
              className="w-full resize-none rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
              rows={2}
              autoFocus
              placeholder="Ask the AI about the selection…"
              value={askText}
              onChange={(event) => setAskText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && askText.trim()) {
                  void run(action, { customInstruction: askText }).then(() => {
                    setOpen(false)
                    setAskText('')
                  })
                }
              }}
            />
            <button
              className="w-full rounded bg-info px-2 py-1 text-sm font-semibold text-info-contrast hover:opacity-90 disabled:opacity-50"
              onClick={() =>
                void run(action, { customInstruction: askText }).then(() => {
                  setOpen(false)
                  setAskText('')
                })
              }
              disabled={!askText.trim() || busy !== null}
            >
              {isBusy ? 'Working…' : 'Ask AI'}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <input
              className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
              type="text"
              autoFocus
              placeholder="Language (type any, or pick below)…"
              value={languageQuery}
              onChange={(event) => setLanguageQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && languageQuery.trim()) {
                  void run(action, { language: languageQuery }).then(() => {
                    setOpen(false)
                    setLanguageQuery('')
                  })
                }
              }}
            />
            <div className="max-h-40 overflow-y-auto">
              {filterLanguages(languageQuery).map((language) => (
                <button
                  key={language}
                  className="flex w-full items-center rounded px-2 py-1 text-left text-sm text-text hover:bg-contrast disabled:opacity-50"
                  onClick={() =>
                    void run(action, { language }).then(() => {
                      setOpen(false)
                      setLanguageQuery('')
                    })
                  }
                  disabled={busy !== null}
                >
                  {language}
                </button>
              ))}
              {filterLanguages(languageQuery).length === 0 && (
                <div className="px-2 py-1 text-xs text-passive-1">
                  Press Enter to translate into “{languageQuery.trim()}”.
                </div>
              )}
            </div>
          </div>
        )}
      </Popover>
    </>
  )
}

const SelectionTools: FunctionComponent<{ editor: LexicalEditor; hasSelection: boolean }> = ({
  editor,
  hasSelection,
}) => {
  const application = useApplication()
  const [busy, setBusy] = useState<string | null>(null)

  const actions = useMemo(() => getSelectionActions(application).filter((action) => action.enabled), [application])
  // Computed each render (cheap) so the greyed-out state tracks sign-in changes.
  const availability = getSelectionAIAvailability(application)

  const run = useCallback(
    async (action: SelectionAction, extra?: RunExtra) => {
      const snap = captureSelection(editor)
      if (!snap?.text) {
        return
      }
      const avail = getSelectionAIAvailability(application)
      if (!avail.available) {
        addToast({ type: ToastType.Error, message: avail.reason ?? 'The AI assistant is not available.' })
        return
      }
      let instruction: string
      if (action.needsLanguage) {
        const language = (extra?.language ?? '').trim()
        if (!language) {
          return
        }
        instruction = buildTranslateInstruction(action.prompt, language)
      } else if (action.freeform) {
        instruction = (extra?.customInstruction ?? '').trim()
        if (!instruction) {
          return
        }
      } else {
        instruction = action.prompt
      }
      setBusy(action.label)
      try {
        const result = await runSelectionAction(application, instruction, snap.text)
        if (result) {
          restoreAndReplace(editor, snap, result)
        }
      } catch (e) {
        addToast({ type: ToastType.Error, message: e instanceof Error ? e.message : String(e) })
      } finally {
        setBusy(null)
      }
    },
    [application, editor],
  )

  const disabledBase = !hasSelection || !availability.available

  return (
    <div className="flex items-center gap-0.5">
      {actions.map((action) => (
        <ActionButton
          key={action.id}
          action={action}
          disabledBase={disabledBase}
          unavailableReason={!availability.available ? availability.reason : undefined}
          busy={busy}
          run={run}
        />
      ))}
    </div>
  )
}

export default SelectionTools
