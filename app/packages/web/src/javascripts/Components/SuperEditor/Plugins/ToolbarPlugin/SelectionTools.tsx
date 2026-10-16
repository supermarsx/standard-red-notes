import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import { $getRoot, LexicalEditor } from 'lexical'
import { ApplicationEvent } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { addToast, ToastType } from '@standardnotes/toast'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  buildTranslateInstruction,
  getSelectionActions,
  getSelectionAIAvailability,
  SelectionAction,
  SelectionActionGroup,
} from '@/Assistant/selectionActions'
import { filterLanguages } from '@/Assistant/languages'
import { publishAssistantDirective } from '@/Assistant/assistantDirectives'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { captureSelectionSnapshot } from './SelectionReplacement'
import { superEditorPortalTarget } from '../../ownSuperEditorElements'

const BTN =
  'flex select-none items-center gap-1.5 rounded-md px-2 py-1.5 text-text transition-colors duration-75 hover:bg-passive-4 active:bg-passive-3 disabled:opacity-40'

type RunExtra = { customInstruction?: string; language?: string }

/**
 * One toolbar icon per AI action (replacing the former single greyed-out
 * dropdown). Plain actions run on click; the freeform "Ask" and the
 * language-picking "Translate" actions open a small popover for their extra
 * input. Actions use the selected text, or the current note when no text is selected.
 */
const ActionButton: FunctionComponent<{
  action: SelectionAction
  disabledBase: boolean
  unavailableReason?: string
  busy: string | null
  run: (action: SelectionAction, extra?: RunExtra) => Promise<void>
  /**
   * The editor this toolbar belongs to. Needed only to resolve the popover's own Super
   * editor: taken as a prop rather than from `useLexicalComposerContext` because this
   * component is also rendered outside a composer (SelectionTools.spec.tsx), where the
   * context hook throws.
   */
  editor: LexicalEditor
}> = ({ action, disabledBase, unavailableReason, busy, run, editor }) => {
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
      <Icon type={action.icon} size="custom" className="text-info h-5 w-5 md:h-4 md:w-4" />
      <span className="text-xs font-medium whitespace-nowrap">{action.label}</span>
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
        // Clamp against THIS note's own Super editor, walked up from its own Lexical root.
        // Left unset, the popover is positioned against the whole document instead, so with
        // more than one note open it is sized and flipped against the wrong box. Resolved
        // here, on every render of this button, so the render that opens it is current.
        documentElement={superEditorPortalTarget(editor.getRootElement())}
      >
        {action.freeform ? (
          <div className="flex flex-col gap-1">
            <textarea
              className="border-border bg-default text-foreground focus:border-info w-full resize-none rounded border px-2 py-1 text-sm outline-none"
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
              className="bg-info text-info-contrast w-full rounded px-2 py-1 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
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
              className="border-border bg-default text-foreground focus:border-info w-full rounded border px-2 py-1 text-sm outline-none"
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
                  className="text-text hover:bg-contrast flex w-full items-center rounded px-2 py-1 text-left text-sm disabled:opacity-50"
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
                <div className="text-passive-1 px-2 py-1 text-xs">
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

const ACTION_GROUPS: { id: SelectionActionGroup; label: string; icon: string }[] = [
  { id: 'text-review', label: 'Text review', icon: 'pencil-filled' },
  { id: 'transforms', label: 'Transforms', icon: 'arrows-sort-down' },
  { id: 'assistant', label: 'Assistant', icon: 'assistant' },
  { id: 'checklists', label: 'Checklist', icon: 'list-check' },
]

const SelectionTools: FunctionComponent<{ editor: LexicalEditor; hasSelection: boolean; noteUuid?: string }> = ({
  editor,
  hasSelection,
  noteUuid,
}) => {
  const application = useApplication()
  const { presentPane } = useResponsiveAppPane()
  const busy = null
  const [activeGroup, setActiveGroup] = useState<SelectionActionGroup>('text-review')

  const [, refreshActions] = useState(0)
  useEffect(
    () =>
      application.addEventObserver(async (event) => {
        if (event === ApplicationEvent.PreferencesChanged) {
          refreshActions((revision) => revision + 1)
        }
      }, ApplicationEvent.PreferencesChanged),
    [application],
  )
  const actions = getSelectionActions(application).filter((action) => action.enabled)
  const visibleActions = actions.filter((action) => action.group === activeGroup)
  // Computed each render (cheap) so the greyed-out state tracks sign-in changes.
  const availability = getSelectionAIAvailability(application)

  const run = useCallback(
    async (action: SelectionAction, extra?: RunExtra) => {
      const sourceNote = noteUuid ? application.items.findItem(noteUuid) : undefined
      if (!sourceNote || sourceNote.trashed || sourceNote.locked || !application.isAuthorizedToRenderItem(sourceNote)) {
        addToast({ type: ToastType.Error, message: 'This note is not available to the Assistant.' })
        return
      }
      const snap = captureSelectionSnapshot(editor)
      const hasTextSelection = !!snap?.text.trim()
      const text = hasTextSelection ? snap!.text : editor.getEditorState().read(() => $getRoot().getTextContent())
      if (!text.trim()) {
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

      const metadataInstruction =
        action.group === 'checklists'
          ? '\n\nBefore relying on checked state or task metadata, use notes.readBlocks for Super notes (or notes.read for other note types) with the normal permission checks. Plain text alone does not establish completion. Do not silently broaden selected-text access.'
          : ''
      const accountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
      presentPane(AppPaneId.Assistant)
      const published = publishAssistantDirective({
        accountScope,
        noteUuid,
        instruction: `${instruction}${metadataInstruction}\n\nDiscuss proposed changes in this chat. Use the normal permission and change-review controls before editing the note.`,
        selectedText: text,
        contextKind: hasTextSelection ? 'selection' : 'note',
      })
      if (!published) {
        addToast({ type: ToastType.Error, message: 'The note context could not be sent to the Assistant.' })
      }
    },
    [application, editor, noteUuid, presentPane],
  )

  const disabledBase = (!hasSelection && !noteUuid) || !availability.available

  return (
    <div className="flex min-w-0 items-stretch gap-1.5" aria-label="AI selection tools">
      <div
        className="border-border grid grid-cols-2 content-center gap-0.5 border-r pr-1.5"
        role="tablist"
        aria-label="AI action groups"
      >
        {ACTION_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={activeGroup === group.id}
            className={classNames(
              'flex items-center gap-1.5 rounded px-2 py-1 text-left text-xs whitespace-nowrap',
              activeGroup === group.id ? 'bg-info-faded text-info font-semibold' : 'text-passive-0 hover:bg-passive-4',
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setActiveGroup(group.id)}
          >
            <Icon type={group.icon} size="small" />
            {group.label}
          </button>
        ))}
      </div>
      <div
        className="grid grid-flow-col grid-rows-2 items-center gap-0.5"
        role="tabpanel"
        aria-label={`${activeGroup} actions`}
      >
        {visibleActions.map((action) => (
          <ActionButton
            key={action.id}
            action={action}
            disabledBase={disabledBase}
            unavailableReason={!availability.available ? availability.reason : undefined}
            busy={busy}
            run={run}
            editor={editor}
          />
        ))}
      </div>
    </div>
  )
}

export default SelectionTools
