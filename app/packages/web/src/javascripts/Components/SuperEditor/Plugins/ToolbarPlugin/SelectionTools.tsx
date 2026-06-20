import { FunctionComponent, useCallback, useMemo, useRef, useState } from 'react'
import { $createRangeSelection, $getSelection, $isRangeSelection, $setSelection, LexicalEditor } from 'lexical'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  getSelectionActions,
  getSelectionAIAvailability,
  runSelectionAction,
  SelectionAction,
} from '@/Assistant/selectionActions'

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

const SelectionTools: FunctionComponent<{ editor: LexicalEditor; hasSelection: boolean }> = ({
  editor,
  hasSelection,
}) => {
  const application = useApplication()
  const aiButtonRef = useRef<HTMLButtonElement>(null)
  const [isAIMenuOpen, setIsAIMenuOpen] = useState(false)
  const [askText, setAskText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = useMemo(() => getSelectionActions(application).filter((a) => a.enabled), [application, isAIMenuOpen])
  const availability = useMemo(() => getSelectionAIAvailability(application), [application, isAIMenuOpen])

  const runAction = useCallback(
    async (action: SelectionAction, customInstruction?: string) => {
      const snap = captureSelection(editor)
      if (!snap?.text) {
        return
      }
      const avail = getSelectionAIAvailability(application)
      if (!avail.available) {
        setError(avail.reason ?? 'The AI assistant is not available.')
        return
      }
      const instruction = action.freeform ? (customInstruction ?? '').trim() : action.prompt
      if (action.freeform && !instruction) {
        return
      }
      setError(null)
      setBusy(action.label)
      try {
        const result = await runSelectionAction(application, instruction, snap.text)
        if (result) {
          restoreAndReplace(editor, snap, result)
        }
        setIsAIMenuOpen(false)
        setAskText('')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [application, editor],
  )

  return (
    <>
      <button
        ref={aiButtonRef}
        className={BTN}
        onClick={() => setIsAIMenuOpen((open) => !open)}
        disabled={!hasSelection}
        title="AI actions"
        aria-label="AI actions"
      >
        <Icon type="dashboard" size="custom" className="h-5 w-5 text-info md:h-4 md:w-4" />
        <Icon type="chevron-down" size="custom" className="ml-1 h-3.5 w-3.5" />
      </button>

      <Popover
        title="AI actions"
        anchorElement={aiButtonRef}
        open={isAIMenuOpen}
        togglePopover={() => setIsAIMenuOpen(!isAIMenuOpen)}
        side="bottom"
        align="end"
        className="w-full p-2 md:w-64"
      >
        {!availability.available ? (
          <div className="px-2 py-2 text-sm text-neutral">{availability.reason}</div>
        ) : (
          <div className="flex flex-col gap-1">
            {error && <div className="rounded bg-contrast px-2 py-1 text-xs text-danger">{error}</div>}
            {actions.map((action) =>
              action.freeform ? (
                <div key={action.id} className="flex flex-col gap-1">
                  <textarea
                    className="w-full resize-none rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
                    rows={2}
                    placeholder="Ask the AI about the selection…"
                    value={askText}
                    onChange={(e) => setAskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        void runAction(action, askText)
                      }
                    }}
                  />
                  <button
                    className="w-full rounded bg-info px-2 py-1 text-sm font-semibold text-info-contrast hover:opacity-90 disabled:opacity-50"
                    onClick={() => void runAction(action, askText)}
                    disabled={!askText.trim() || busy !== null}
                  >
                    {busy === action.label ? 'Working…' : 'Ask AI'}
                  </button>
                </div>
              ) : (
                <button
                  key={action.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-text hover:bg-contrast disabled:opacity-50"
                  onClick={() => void runAction(action)}
                  disabled={busy !== null}
                >
                  <Icon type={action.icon} size="small" className="text-neutral" />
                  {busy === action.label ? `${action.label}…` : action.label}
                </button>
              ),
            )}
          </div>
        )}
      </Popover>
    </>
  )
}

export default SelectionTools
