import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { isTag, SmartView, SNTag, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { naturalSort } from '@standardnotes/utils'
import { useMemo, useState } from 'react'
import {
  createHomeCardId,
  HomeCard,
  HomeCardKind,
  HomeConfig,
  HomeMode,
  HOME_MODES,
  reorderCards,
} from './homeConfigStorage'

type Props = {
  application: WebApplication
  config: HomeConfig
  onChange: (config: HomeConfig) => void
  onDone: () => void
}

const MODE_LABELS: Record<HomeMode, string> = {
  default: 'Default (a simple welcome page)',
  note: 'A single note as my home page',
  cards: 'A grid of cards I choose',
}

const KIND_LABELS: Record<HomeCardKind, string> = {
  note: 'Opens a specific note',
  tag: 'Goes to a topic / folder / view',
}

const ICON_CHOICES: VectorIconNameOrEmoji[] = ['notes', 'hashtag', 'star', 'pencil', 'archive', 'link', 'pin', 'info']

const selectClassName =
  'rounded border border-border bg-default px-2 py-1.5 text-sm text-text focus:border-info focus:outline-none'

/**
 * In-pane editor for the Home configuration. This deliberately lives INSIDE the
 * Home pane (not the Preferences pane registry) so the customization UI ships with
 * the feature. Every change is pushed up via `onChange` and persisted live.
 */
const HomeCustomizeEditor = ({ application, config, onChange, onDone }: Props) => {
  const [draftKind, setDraftKind] = useState<HomeCardKind>('note')
  const [draftTarget, setDraftTarget] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftIcon, setDraftIcon] = useState<VectorIconNameOrEmoji>('notes')

  const tags = useMemo<(SNTag | SmartView)[]>(() => {
    const regularTags = naturalSort(application.items.getDisplayableTags(), 'title')
    const smartViews = application.navigationController.smartViews
    return [...smartViews, ...regularTags]
  }, [application])

  const notes = useMemo(() => naturalSort(application.items.getDisplayableNotes(), 'title'), [application])

  const cardTargetOptions = useMemo(() => {
    if (draftKind === 'note') {
      return notes.map((note) => ({ uuid: note.uuid, title: note.title || 'Untitled note' }))
    }
    return tags.map((tag) => ({ uuid: tag.uuid, title: isTag(tag) ? tag.title : tag.title }))
  }, [draftKind, notes, tags])

  const setMode = (mode: HomeMode) => {
    onChange({ ...config, mode })
  }

  const setHomeNote = (noteUuid: string) => {
    onChange({ ...config, noteUuid: noteUuid || undefined })
  }

  const addCard = () => {
    if (!draftTarget) {
      return
    }
    const newCard: HomeCard = {
      id: createHomeCardId(),
      kind: draftKind,
      targetUuid: draftTarget,
      label: draftLabel.trim() || undefined,
      icon: draftIcon,
    }
    onChange({ ...config, cards: [...config.cards, newCard] })
    setDraftTarget('')
    setDraftLabel('')
  }

  const removeCard = (id: string) => {
    onChange({ ...config, cards: config.cards.filter((card) => card.id !== id) })
  }

  const moveCard = (index: number, direction: -1 | 1) => {
    onChange({ ...config, cards: reorderCards(config.cards, index, direction) })
  }

  const titleForTarget = (uuid: string): string => {
    const item = application.items.findItem(uuid) as { title?: string } | undefined
    return item?.title || 'Missing item'
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-text">Customize home</h2>
        <button
          className="rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:brightness-125"
          onClick={onDone}
        >
          Done
        </button>
      </div>

      <label className="flex flex-col gap-1 text-xs text-passive-0">
        What should home show?
        <select
          className={selectClassName}
          value={config.mode}
          onChange={(event) => setMode(event.target.value as HomeMode)}
        >
          {HOME_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      {config.mode === 'note' && (
        <label className="flex flex-col gap-1 text-xs text-passive-0">
          Home note
          <select
            className={selectClassName}
            value={config.noteUuid ?? ''}
            onChange={(event) => setHomeNote(event.target.value)}
          >
            <option value="">Select a note…</option>
            {notes.map((note) => (
              <option key={note.uuid} value={note.uuid}>
                {note.title || 'Untitled note'}
              </option>
            ))}
          </select>
        </label>
      )}

      {config.mode === 'cards' && (
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-2 text-sm font-semibold text-text">Your cards</div>
            {config.cards.length === 0 ? (
              <div className="text-xs text-passive-0">No cards yet. Add one below.</div>
            ) : (
              <ul className="flex flex-col gap-1">
                {config.cards.map((card, index) => (
                  <li key={card.id} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
                    <Icon
                      type={(card.icon as VectorIconNameOrEmoji) || (card.kind === 'note' ? 'notes' : 'hashtag')}
                      size="small"
                      className="flex-shrink-0"
                    />
                    <div className="min-w-0 flex-grow">
                      <div className="truncate text-sm text-text">{card.label || titleForTarget(card.targetUuid)}</div>
                      <div className="truncate text-xs text-passive-0">{KIND_LABELS[card.kind]}</div>
                    </div>
                    <button
                      className="rounded p-1 hover:bg-contrast disabled:opacity-40"
                      onClick={() => moveCard(index, -1)}
                      disabled={index === 0}
                      aria-label="Move card up"
                    >
                      <Icon type="chevron-up" size="small" />
                    </button>
                    <button
                      className="rounded p-1 hover:bg-contrast disabled:opacity-40"
                      onClick={() => moveCard(index, 1)}
                      disabled={index === config.cards.length - 1}
                      aria-label="Move card down"
                    >
                      <Icon type="chevron-down" size="small" />
                    </button>
                    <button
                      className="rounded p-1 hover:bg-contrast"
                      onClick={() => removeCard(card.id)}
                      aria-label="Remove card"
                    >
                      <Icon type="trash" size="small" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="text-sm font-semibold text-text">Add a card</div>

            <label className="flex flex-col gap-1 text-xs text-passive-0">
              Card type
              <select
                className={selectClassName}
                value={draftKind}
                onChange={(event) => {
                  setDraftKind(event.target.value as HomeCardKind)
                  setDraftTarget('')
                  setDraftIcon(event.target.value === 'note' ? 'notes' : 'hashtag')
                }}
              >
                {(Object.keys(KIND_LABELS) as HomeCardKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-passive-0">
              {draftKind === 'note' ? 'Note' : 'Topic / folder / view'}
              <select
                className={selectClassName}
                value={draftTarget}
                onChange={(event) => setDraftTarget(event.target.value)}
              >
                <option value="">Select…</option>
                {cardTargetOptions.map((option) => (
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
              onClick={addCard}
              disabled={!draftTarget}
            >
              Add card
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default HomeCustomizeEditor
