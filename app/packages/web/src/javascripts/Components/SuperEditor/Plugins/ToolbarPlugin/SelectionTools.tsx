import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import { LexicalEditor } from 'lexical'
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
  runSelectionAction,
  SelectionAction,
  SelectionActionGroup,
} from '@/Assistant/selectionActions'
import { filterLanguages } from '@/Assistant/languages'
import { publishAssistantDirective } from '@/Assistant/assistantDirectives'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { captureSelectionSnapshot, restoreAndReplaceSelection } from './SelectionReplacement'

const BTN =
  'flex select-none items-center gap-1.5 rounded-md px-2 py-1.5 text-text transition-colors duration-75 hover:bg-passive-4 active:bg-passive-3 disabled:opacity-40'

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
  { id: 'assistant', label: 'Assistant', icon: 'dashboard' },
]

const SelectionTools: FunctionComponent<{ editor: LexicalEditor; hasSelection: boolean; noteUuid?: string }> = ({
  editor,
  hasSelection,
  noteUuid,
}) => {
  const application = useApplication()
  const { presentPane } = useResponsiveAppPane()
  const [busy, setBusy] = useState<string | null>(null)
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
      const snap = captureSelectionSnapshot(editor)
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

      if (action.behavior === 'chat') {
        const accountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
        presentPane(AppPaneId.Assistant)
        const published = publishAssistantDirective({
          accountScope,
          noteUuid,
          instruction,
          selectedText: snap.text,
        })
        if (!published) {
          addToast({ type: ToastType.Error, message: 'The selected text could not be sent to the Assistant.' })
        }
        return
      }

      if (snap.unsupportedStructuredSelection) {
        addToast({
          type: ToastType.Error,
          message: 'Select complete checklist rows before using a replacement action so task details stay attached.',
        })
        return
      }

      if (action.id === 'organize' && (snap.checklistRows?.length ?? 0) > 1) {
        addToast({
          type: ToastType.Error,
          message:
            'Organize cannot safely reorder multiple checklist tasks without detaching their dates and recurrence. Send the selection to Assistant instead.',
        })
        return
      }

      const checklistInstruction = snap.checklistRows?.length
        ? `${instruction}\n\nReturn exactly ${snap.checklistRows.length} lines in the original row order: one plain-text line per checklist item, with no bullets or checkbox markers.`
        : instruction
      setBusy(action.label)
      try {
        const result = await runSelectionAction(application, checklistInstruction, snap.text)
        if (result) {
          const replacement = restoreAndReplaceSelection(editor, snap, result)
          if (replacement === 'stale-selection') {
            addToast({
              type: ToastType.Regular,
              message: 'The selection changed while AI was working. Nothing was replaced.',
            })
          } else if (replacement === 'checklist-shape-mismatch') {
            addToast({
              type: ToastType.Error,
              message: 'AI returned a different number of checklist rows. Nothing was replaced.',
            })
          } else if (replacement === 'unsupported-structured-selection') {
            addToast({
              type: ToastType.Error,
              message: 'Select complete checklist rows before using AI so task details stay attached safely.',
            })
          }
        }
      } catch (e) {
        addToast({ type: ToastType.Error, message: e instanceof Error ? e.message : String(e) })
      } finally {
        setBusy(null)
      }
    },
    [application, editor, noteUuid, presentPane],
  )

  const disabledBase = !hasSelection || !availability.available

  return (
    <div className="flex min-w-0 items-stretch gap-1.5" aria-label="AI selection tools">
      <div className="border-border flex flex-col gap-0.5 border-r pr-1.5" role="tablist" aria-label="AI action groups">
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
      <div className="flex flex-col justify-center gap-0.5" role="tabpanel" aria-label={`${activeGroup} actions`}>
        {visibleActions.map((action) => (
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
    </div>
  )
}

export default SelectionTools
