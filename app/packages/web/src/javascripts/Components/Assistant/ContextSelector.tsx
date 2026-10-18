import { useMemo, useState } from 'react'
import { Popover, PopoverDisclosure, usePopoverStore } from '@ariakit/react'
import { observer } from 'mobx-react-lite'
import { ContentType, FolderContentType, SNFolder, SNNote, SNTag } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { AssistantContextScope } from '@/Assistant/assistantContext'
import { AssistantContextSelection, CollectionSelection } from '@/Assistant/assistantContextSource'

type Props = {
  application: WebApplication
  selection: AssistantContextSelection
  onChange: (selection: AssistantContextSelection) => void
  disabled?: boolean
}

const SCOPE_OPTIONS: {
  value: AssistantContextScope
  label: string
  icon: 'notes' | 'list-bulleted' | 'folder' | 'window' | 'search'
}[] = [
  { value: 'no-note', label: 'No note', icon: 'window' },
  { value: 'new-note', label: 'New note', icon: 'notes' },
  { value: 'current-note', label: 'Current note', icon: 'notes' },
  { value: 'selection', label: 'Selected text only', icon: 'notes' },
  { value: 'open-notes', label: 'Open notes (tabs)', icon: 'window' },
  { value: 'all-notes', label: 'Notebook (all notes)', icon: 'list-bulleted' },
  { value: 'topic', label: 'Topic / search…', icon: 'search' },
  { value: 'collection', label: 'Folder / tag / selection…', icon: 'folder' },
]

/** Encode a collection selection as a single dropdown value string and back. */
const encodeCollection = (collection: CollectionSelection | undefined): string => {
  if (!collection) {
    return ''
  }
  if (collection.type === 'notes') {
    return `notes:${collection.uuids.join(',')}`
  }
  return `${collection.type}:${collection.uuid}`
}

const decodeCollection = (value: string): CollectionSelection | undefined => {
  if (!value) {
    return undefined
  }
  const [type, rest] = value.split(/:(.*)/s)
  if (type === 'tag' || type === 'folder') {
    return { type, uuid: rest }
  }
  if (type === 'notes') {
    return { type: 'notes', uuids: rest ? rest.split(',').filter(Boolean) : [] }
  }
  return undefined
}

const compactDropdown = {
  wrapper: 'min-w-0 max-w-full',
  button:
    'min-w-0! w-auto! gap-1 px-2! py-1! text-xs! [&_.text-base]:text-xs [&_.mr-2]:mr-1 [&>svg]:h-3.5 [&>svg]:w-3.5',
  popover: 'min-w-56 max-w-[calc(100vw-2rem)]',
}

function ContextSelectorImpl({ application, selection, onChange, disabled }: Props) {
  const [pickingNotes, setPickingNotes] = useState(false)
  const popover = usePopoverStore({ placement: 'top-start' })
  const selectedScope = SCOPE_OPTIONS.find((option) => option.value === selection.scope)
  const abbreviations = {
    'no-note': 'None',
    'new-note': 'New',
    'current-note': 'Note',
    selection: 'Sel.',
    'open-notes': 'Tabs',
    'all-notes': 'All',
    topic: 'Topic',
    collection: 'Set',
  }

  const noExistingNoteContext = selection.scope === 'no-note' || selection.scope === 'new-note'
  const tags = useMemo(
    () => (noExistingNoteContext ? [] : application.items.getItems<SNTag>(ContentType.TYPES.Tag)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [application, pickingNotes, noExistingNoteContext],
  )
  const folders = useMemo(
    () => (noExistingNoteContext ? [] : application.items.getItems<SNFolder>(FolderContentType)),

    [application, noExistingNoteContext],
  )
  const notes = useMemo(
    () => {
      if (noExistingNoteContext) {
        return []
      }
      return application.items.getItems<SNNote>(ContentType.TYPES.Note).filter((note) => !note.trashed)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [application, pickingNotes, noExistingNoteContext],
  )

  const scopeItems = SCOPE_OPTIONS.map((option) => ({
    label: option.label,
    value: option.value,
    icon: option.icon,
  }))

  const collectionItems = useMemo(() => {
    const items: { label: string; value: string }[] = [{ label: 'Pick specific notes…', value: '__pick_notes__' }]
    if (tags.length > 0) {
      for (const tag of tags) {
        items.push({ label: `# ${application.items.getTagLongTitle(tag)}`, value: `tag:${tag.uuid}` })
      }
    }
    for (const folder of folders) {
      items.push({ label: `📁 ${folder.title}`, value: `folder:${folder.uuid}` })
    }
    return items
  }, [application, tags, folders])

  const handleScopeChange = (value: string) => {
    const scope = value as AssistantContextScope
    if (scope === 'collection') {
      onChange({ scope: 'collection', collection: selection.collection })
    } else if (scope === 'topic') {
      onChange({ scope: 'topic', topicQuery: selection.topicQuery ?? '' })
    } else {
      onChange({ scope })
    }
  }

  const handleCollectionChange = (value: string) => {
    if (value === '__pick_notes__') {
      setPickingNotes(true)
      return
    }
    onChange({ scope: 'collection', collection: decodeCollection(value) })
  }

  const selectedNoteUuids =
    selection.collection?.type === 'notes' ? new Set(selection.collection.uuids) : new Set<string>()

  const toggleNote = (uuid: string) => {
    const next = new Set(selectedNoteUuids)
    if (next.has(uuid)) {
      next.delete(uuid)
    } else {
      next.add(uuid)
    }
    onChange({ scope: 'collection', collection: { type: 'notes', uuids: [...next] } })
  }

  return (
    <>
      <PopoverDisclosure
        store={popover}
        disabled={disabled}
        aria-label="Assistant context"
        title={`Context: ${selectedScope?.label ?? selection.scope}`}
        className="border-border bg-default text-text hover:bg-contrast flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-50"
      >
        <Icon type={selectedScope?.icon ?? 'notes'} size="small" />
        <span>{abbreviations[selection.scope]}</span>
        <Icon type="chevron-down" size="small" />
      </PopoverDisclosure>
      <Popover
        unmountOnHide
        store={popover}
        portal
        aria-label="Choose assistant context"
        className="z-dropdown-menu border-border bg-default text-text w-72 max-w-[calc(100vw-2rem)] rounded border p-2 shadow-lg"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-passive-1 shrink-0 text-[11px] font-medium">Context</span>
            <Dropdown
              label="Assistant context scope"
              items={scopeItems}
              value={selection.scope}
              onChange={handleScopeChange}
              disabled={disabled}
              popoverPlacement="bottom"
              classNameOverride={compactDropdown}
            />
          </div>

          {selection.scope === 'topic' && (
            <input
              type="text"
              value={selection.topicQuery ?? ''}
              onChange={(event) => onChange({ scope: 'topic', topicQuery: event.target.value })}
              disabled={disabled}
              placeholder="Search notes by title or preview (e.g. taxes 2025)…"
              aria-label="Topic search query"
              className="border-border bg-default text-text focus:border-info min-w-0 flex-1 basis-40 rounded border px-2 py-1 text-xs focus:outline-none"
            />
          )}

          {selection.scope === 'collection' && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <Dropdown
                label="Collection source"
                items={collectionItems}
                value={
                  selection.collection && selection.collection.type !== 'notes'
                    ? encodeCollection(selection.collection)
                    : ''
                }
                onChange={handleCollectionChange}
                disabled={disabled}
                popoverPlacement="bottom"
                classNameOverride={compactDropdown}
              />

              {(pickingNotes || selection.collection?.type === 'notes') && (
                <div className="border-border bg-default max-h-40 w-full overflow-y-auto rounded border p-1">
                  {notes.length === 0 && (
                    <div className="text-passive-0 px-2 py-1 text-xs">No notes to choose from.</div>
                  )}
                  {notes.map((note) => {
                    const checked = selectedNoteUuids.has(note.uuid)
                    return (
                      <button
                        key={note.uuid}
                        type="button"
                        onClick={() => toggleNote(note.uuid)}
                        disabled={disabled}
                        className={classNames(
                          'hover:bg-contrast flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs',
                          checked ? 'text-text' : 'text-passive-0',
                        )}
                      >
                        <span
                          className={classNames(
                            'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border',
                            checked ? 'border-info bg-info text-info-contrast' : 'border-border',
                          )}
                          aria-hidden
                        >
                          {checked && <Icon type="check" size="small" />}
                        </span>
                        <span className="truncate">{note.title || 'Untitled note'}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Popover>
    </>
  )
}

const ContextSelector = observer(ContextSelectorImpl)

export default ContextSelector
