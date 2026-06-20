import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { isTag, SmartView, SNTag, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { naturalSort } from '@standardnotes/utils'
import { useMemo, useState } from 'react'
import {
  createQuickActionId,
  QuickAction,
  QuickActionType,
  QUICK_ACTION_TYPES,
} from './quickActionsStorage'

type Props = {
  application: WebApplication
  actions: QuickAction[]
  onChange: (actions: QuickAction[]) => void
}

const TYPE_LABELS: Record<QuickActionType, string> = {
  'new-note-in': 'Create a new note in…',
  'recent-in': 'Open most recent note in…',
  'open-note': 'Open a specific note',
  'go-to': 'Go to a tag/folder/view',
}

const ICON_CHOICES: VectorIconNameOrEmoji[] = [
  'star',
  'add',
  'notes',
  'restore',
  'hashtag',
  'pencil',
  'archive',
  'link',
]

/** Whether the action type targets a note (vs a tag/folder/smart view). */
function targetsNote(type: QuickActionType): boolean {
  return type === 'open-note'
}

const QuickActionsConfig = ({ application, actions, onChange }: Props) => {
  const [draftType, setDraftType] = useState<QuickActionType>('new-note-in')
  const [draftTarget, setDraftTarget] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftIcon, setDraftIcon] = useState<VectorIconNameOrEmoji>('star')

  const tags = useMemo<(SNTag | SmartView)[]>(() => {
    const regularTags = naturalSort(application.items.getDisplayableTags(), 'title')
    const smartViews = application.navigationController.smartViews
    return [...smartViews, ...regularTags]
  }, [application])

  const notes = useMemo(() => naturalSort(application.items.getDisplayableNotes(), 'title'), [application])

  const targetOptions = useMemo(() => {
    if (targetsNote(draftType)) {
      return notes.map((note) => ({ uuid: note.uuid, title: note.title || 'Untitled note' }))
    }
    return tags.map((tag) => ({ uuid: tag.uuid, title: isTag(tag) ? tag.title : tag.title }))
  }, [draftType, notes, tags])

  const addAction = () => {
    if (!draftTarget) {
      return
    }
    const newAction: QuickAction = {
      id: createQuickActionId(),
      type: draftType,
      targetUuid: draftTarget,
      label: draftLabel.trim() || undefined,
      icon: draftIcon,
    }
    onChange([...actions, newAction])
    setDraftTarget('')
    setDraftLabel('')
  }

  const removeAction = (id: string) => {
    onChange(actions.filter((action) => action.id !== id))
  }

  const moveAction = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= actions.length) {
      return
    }
    const next = [...actions]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }

  const titleForTarget = (uuid: string): string => {
    const item = application.items.findItem(uuid) as { title?: string } | undefined
    return item?.title || 'Missing item'
  }

  const selectClassName =
    'rounded border border-border bg-default px-2 py-1.5 text-sm text-text focus:border-info focus:outline-none'

  return (
    <div className="flex max-h-[28rem] w-80 flex-col gap-3 px-3 py-2">
      <div>
        <div className="mb-2 text-sm font-semibold text-text">Your quick actions</div>
        {actions.length === 0 ? (
          <div className="text-xs text-passive-0">No quick actions yet. Add one below.</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {actions.map((action, index) => (
              <li
                key={action.id}
                className="flex items-center gap-2 rounded border border-border px-2 py-1.5"
              >
                <Icon type={(action.icon as VectorIconNameOrEmoji) || 'star'} size="small" className="flex-shrink-0" />
                <div className="min-w-0 flex-grow">
                  <div className="truncate text-sm text-text">{action.label || titleForTarget(action.targetUuid)}</div>
                  <div className="truncate text-xs text-passive-0">{TYPE_LABELS[action.type]}</div>
                </div>
                <button
                  className="rounded p-1 hover:bg-contrast disabled:opacity-40"
                  onClick={() => moveAction(index, -1)}
                  disabled={index === 0}
                  aria-label="Move quick action up"
                >
                  <Icon type="chevron-up" size="small" />
                </button>
                <button
                  className="rounded p-1 hover:bg-contrast disabled:opacity-40"
                  onClick={() => moveAction(index, 1)}
                  disabled={index === actions.length - 1}
                  aria-label="Move quick action down"
                >
                  <Icon type="chevron-down" size="small" />
                </button>
                <button
                  className="rounded p-1 hover:bg-contrast"
                  onClick={() => removeAction(action.id)}
                  aria-label="Remove quick action"
                >
                  <Icon type="trash" size="small" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <div className="text-sm font-semibold text-text">Add a quick action</div>

        <label className="flex flex-col gap-1 text-xs text-passive-0">
          Action
          <select
            className={selectClassName}
            value={draftType}
            onChange={(event) => {
              setDraftType(event.target.value as QuickActionType)
              setDraftTarget('')
            }}
          >
            {QUICK_ACTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-passive-0">
          {targetsNote(draftType) ? 'Note' : 'Tag / folder / view'}
          <select
            className={selectClassName}
            value={draftTarget}
            onChange={(event) => setDraftTarget(event.target.value)}
          >
            <option value="">Select…</option>
            {targetOptions.map((option) => (
              <option key={option.uuid} value={option.uuid}>
                {option.title}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-passive-0">
          Label (optional)
          <input
            className={selectClassName}
            type="text"
            value={draftLabel}
            placeholder="Defaults to the target name"
            onChange={(event) => setDraftLabel(event.target.value)}
          />
        </label>

        <div className="flex flex-col gap-1 text-xs text-passive-0">
          Icon
          <div className="flex flex-wrap gap-1">
            {ICON_CHOICES.map((icon) => (
              <button
                key={icon as string}
                className={
                  'rounded border p-1.5 hover:bg-contrast ' +
                  (draftIcon === icon ? 'border-info bg-info-backdrop' : 'border-border')
                }
                onClick={() => setDraftIcon(icon)}
                aria-label={`Use ${icon} icon`}
                aria-pressed={draftIcon === icon}
              >
                <Icon type={icon} size="small" />
              </button>
            ))}
          </div>
        </div>

        <button
          className="mt-1 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:brightness-125 disabled:opacity-40"
          onClick={addAction}
          disabled={!draftTarget}
        >
          Add quick action
        </button>
      </div>
    </div>
  )
}

export default QuickActionsConfig
