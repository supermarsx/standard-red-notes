import { useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ContentType,
  FolderContentType,
  SNFolder,
  SNNote,
  SNTag,
} from '@standardnotes/snjs'
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

const SCOPE_OPTIONS: { value: AssistantContextScope; label: string; icon: 'notes' | 'list-bulleted' | 'folder' }[] = [
  { value: 'current-note', label: 'Current note', icon: 'notes' },
  { value: 'all-notes', label: 'Notebook (all notes)', icon: 'list-bulleted' },
  { value: 'collection', label: 'Collection…', icon: 'folder' },
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

function ContextSelectorImpl({ application, selection, onChange, disabled }: Props) {
  const [pickingNotes, setPickingNotes] = useState(false)

  const tags = useMemo(
    () => application.items.getItems<SNTag>(ContentType.TYPES.Tag),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [application, pickingNotes],
  )
  const folders = useMemo(
    () => application.items.getItems<SNFolder>(FolderContentType),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [application],
  )
  const notes = useMemo(
    () => application.items.getItems<SNNote>(ContentType.TYPES.Note).filter((note) => !note.trashed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [application, pickingNotes],
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
    <div className="flex flex-col gap-2 border-b border-border bg-contrast px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-passive-1">Context</span>
        <Dropdown
          label="Assistant context scope"
          items={scopeItems}
          value={selection.scope}
          onChange={handleScopeChange}
          disabled={disabled}
          popoverPlacement="bottom"
        />
      </div>

      {selection.scope === 'collection' && (
        <div className="flex flex-col gap-2">
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
          />

          {(pickingNotes || selection.collection?.type === 'notes') && (
            <div className="max-h-48 overflow-y-auto rounded border border-border bg-default p-1">
              {notes.length === 0 && <div className="px-2 py-1 text-xs text-passive-0">No notes to choose from.</div>}
              {notes.map((note) => {
                const checked = selectedNoteUuids.has(note.uuid)
                return (
                  <button
                    key={note.uuid}
                    type="button"
                    onClick={() => toggleNote(note.uuid)}
                    disabled={disabled}
                    className={classNames(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-contrast',
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
  )
}

const ContextSelector = observer(ContextSelectorImpl)

export default ContextSelector
