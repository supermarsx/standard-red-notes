import { WebApplication } from '@/Application/WebApplication'
import {
  ContentType,
  isPayloadSourceRetrieved,
  NoteType,
  SNFolder,
  SNNote,
  SNTag,
} from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import Icon from '@/Components/Icon/Icon'
import { extractPlaintextFromNoteText, computePlaintextStats } from '@/Utils/NoteStats'
import { NoteViewController } from '../Controller/NoteViewController'
import {
  BaseDocument,
  BaseSourceKind,
  ColumnDef,
  Filter,
  FilterOperator,
  SortDir,
  BUILTIN_PROPERTIES,
  BuiltinPropertyId,
  builtinPropertyType,
  columnLabel,
  createBaseId,
  createEmptyBaseDocument,
  parseBaseDocument,
  serializeBaseDocument,
} from './BaseDocument'
import {
  BaseRow,
  computeVisibleRows,
  discoverParsedKeys,
  formatCellValue,
  getColumnValue,
  operatorLabel,
  operatorsForType,
  parseFrontmatterProperties,
} from './BaseRows'

/** Identifier stored in `note.editorIdentifier` to mark a note as a Base note. */
export const BaseEditorIdentifier = 'org.standardnotes.base'

const PERSIST_DEBOUNCE_MS = 400
const FOLDER_CONTENT_TYPE = 'Folder'

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

/** Build the BaseRow for a single note (resolving tags, folder, word count, parsed props). */
const buildRow = (application: WebApplication, note: SNNote, foldersByNoteUuid: Map<string, string>): BaseRow => {
  const tags = application.items.getSortedTagsForItem(note).map((tag) => tag.title || 'Untitled')
  const plaintext = extractPlaintextFromNoteText(note.text, note.noteType)
  const wordCount = computePlaintextStats(plaintext).words
  return {
    uuid: note.uuid,
    title: note.title || 'Untitled',
    createdAt: note.created_at,
    updatedAt: note.userModifiedDate,
    tags,
    folder: foldersByNoteUuid.get(note.uuid) ?? '',
    wordCount,
    pinned: note.pinned,
    archived: note.archived,
    protected: note.protected,
    starred: note.starred,
    parsed: parseFrontmatterProperties(plaintext),
  }
}

/** Resolve the source set of notes for a Base definition. */
const resolveSourceNotes = (application: WebApplication, source: BaseDocument['source']): SNNote[] => {
  const allNotes = application.items.getDisplayableNotes()
  if (source.kind === 'all' || !source.uuid) {
    return source.kind === 'all' ? allNotes : []
  }
  const collection = application.items.findItem(source.uuid)
  if (!collection) {
    return []
  }
  const memberUuids = new Set(
    application.items.referencesForItem<SNNote>(collection, ContentType.TYPES.Note).map((note) => note.uuid),
  )
  return allNotes.filter((note) => memberUuids.has(note.uuid))
}

export const BaseEditor: FunctionComponent<Props> = ({
  application,
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const { presentPane } = useResponsiveAppPane()

  const initialParse = useMemo(() => parseBaseDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<BaseDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)
  const [showConfig, setShowConfig] = useState(false)
  /** Bumped to force a re-resolution of source notes when items change. */
  const [refreshToken, setRefreshToken] = useState(0)

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)

  const isReadonly = note.current.locked || Boolean(readonly)

  const persist = useCallback(
    (doc: BaseDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        void controller.saveAndAwaitLocalPropagation({
          text: serializeBaseDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Base: ${doc.columns.length} columns, ${doc.filters.length} filters`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: BaseDocument) => BaseDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes to the definition into local state.
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
        const { document: parsed } = parseBaseDocument(updatedNote.text)
        setDocument(parsed)
      }
    })
    return disposer
  }, [controller])

  // Re-resolve rows whenever any note/tag/folder changes (membership, titles, etc.).
  useEffect(() => {
    const disposer = application.items.streamItems(
      [ContentType.TYPES.Note, ContentType.TYPES.Tag, FOLDER_CONTENT_TYPE],
      () => setRefreshToken((token) => token + 1),
    )
    return disposer
  }, [application])

  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
    }
  }, [])

  const tags = useMemo(() => application.items.getDisplayableTags(), [application, refreshToken])
  const folders = useMemo(
    () => application.items.getItems<SNFolder>(FOLDER_CONTENT_TYPE),
    [application, refreshToken],
  )

  // Resolve source notes into rows (depends on the source + the live items).
  const rows = useMemo(() => {
    const foldersByNoteUuid = new Map<string, string>()
    for (const folder of folders) {
      const folderTitle = (folder as SNFolder).title || 'Untitled'
      for (const memberNote of application.items.referencesForItem<SNNote>(folder, ContentType.TYPES.Note)) {
        if (!foldersByNoteUuid.has(memberNote.uuid)) {
          foldersByNoteUuid.set(memberNote.uuid, folderTitle)
        }
      }
    }
    const sourceNotes = resolveSourceNotes(application, document.source)
    return sourceNotes.map((sourceNote) => buildRow(application, sourceNote, foldersByNoteUuid))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application, document.source, folders, refreshToken])

  const visibleRows = useMemo(
    () => computeVisibleRows(rows, document.filters, document.sort, document.columns),
    [rows, document.filters, document.sort, document.columns],
  )

  const parsedKeys = useMemo(() => discoverParsedKeys(rows), [rows])

  const openNote = useCallback(
    (uuid: string) => {
      const target = application.items.findItem<SNNote>(uuid)
      if (!target) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(target.uuid)
      void application.itemListController.selectItemUsingInstance(target, true)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  // --- config mutators ----------------------------------------------------

  const setSource = useCallback(
    (kind: BaseSourceKind, uuid?: string) => {
      updateDocument((doc) => ({ ...doc, source: kind === 'all' ? { kind } : { kind, uuid } }))
    },
    [updateDocument],
  )

  const addBuiltinColumn = useCallback(
    (property: BuiltinPropertyId) => {
      updateDocument((doc) => {
        const id = createBaseId('col')
        return { ...doc, columns: [...doc.columns, { id, kind: 'builtin', property }] }
      })
    },
    [updateDocument],
  )

  const addParsedColumn = useCallback(
    (key: string) => {
      updateDocument((doc) => {
        const id = createBaseId('col')
        return { ...doc, columns: [...doc.columns, { id, kind: 'parsed', key }] }
      })
    },
    [updateDocument],
  )

  const removeColumn = useCallback(
    (columnId: string) => {
      updateDocument((doc) => ({
        ...doc,
        columns: doc.columns.filter((c) => c.id !== columnId),
        sort: doc.sort.columnId === columnId ? { ...doc.sort, columnId: undefined } : doc.sort,
      }))
    },
    [updateDocument],
  )

  const moveColumn = useCallback(
    (columnId: string, direction: -1 | 1) => {
      updateDocument((doc) => {
        const index = doc.columns.findIndex((c) => c.id === columnId)
        const target = index + direction
        if (index < 0 || target < 0 || target >= doc.columns.length) {
          return doc
        }
        const columns = [...doc.columns]
        const [moved] = columns.splice(index, 1)
        columns.splice(target, 0, moved)
        return { ...doc, columns }
      })
    },
    [updateDocument],
  )

  const addFilter = useCallback(() => {
    updateDocument((doc) => {
      const filter: Filter = { id: createBaseId('flt'), target: 'title', operator: 'contains', value: '' }
      return { ...doc, filters: [...doc.filters, filter] }
    })
  }, [updateDocument])

  const updateFilter = useCallback(
    (filterId: string, patch: Partial<Filter>) => {
      updateDocument((doc) => ({
        ...doc,
        filters: doc.filters.map((f) => (f.id === filterId ? { ...f, ...patch } : f)),
      }))
    },
    [updateDocument],
  )

  const removeFilter = useCallback(
    (filterId: string) => {
      updateDocument((doc) => ({ ...doc, filters: doc.filters.filter((f) => f.id !== filterId) }))
    },
    [updateDocument],
  )

  const setSort = useCallback(
    (columnId: string | undefined, dir: SortDir) => {
      updateDocument((doc) => ({ ...doc, sort: { columnId, dir } }))
    },
    [updateDocument],
  )

  const toggleSortForColumn = useCallback(
    (column: ColumnDef) => {
      if (isReadonly) {
        return
      }
      updateDocument((doc) => {
        if (doc.sort.columnId === column.id) {
          return { ...doc, sort: { columnId: column.id, dir: doc.sort.dir === 'asc' ? 'desc' : 'asc' } }
        }
        return { ...doc, sort: { columnId: column.id, dir: 'asc' } }
      })
    },
    [isReadonly, updateDocument],
  )

  // --- target options for filters ----------------------------------------

  const filterTargetOptions = useMemo(() => {
    const builtins = BUILTIN_PROPERTIES.map((p) => ({ value: p.id, label: p.label }))
    const parsed = parsedKeys.map((key) => ({ value: `parsed:${key}`, label: `${key} (property)` }))
    return [...builtins, ...parsed]
  }, [parsedKeys])

  const typeForTarget = useCallback(
    (target: string): 'text' | 'date' | 'number' | 'boolean' | 'list' => {
      if (target.startsWith('parsed:')) {
        return 'text'
      }
      return builtinPropertyType(target as BuiltinPropertyId)
    },
    [],
  )

  const usedColumnKeys = useMemo(() => {
    const set = new Set<string>()
    for (const column of document.columns) {
      if (column.kind === 'builtin' && column.property) {
        set.add(`builtin:${column.property}`)
      } else if (column.kind === 'parsed' && column.key) {
        set.add(`parsed:${column.key.toLowerCase()}`)
      }
    }
    return set
  }, [document.columns])

  const sourceLabel = useMemo(() => {
    if (document.source.kind === 'all') {
      return 'All notes'
    }
    const collection = document.source.uuid ? application.items.findItem(document.source.uuid) : undefined
    const title = (collection as SNTag | SNFolder | undefined)?.title
    return document.source.kind === 'tag' ? `Tag: ${title ?? '—'}` : `Folder: ${title ?? '—'}`
  }, [application, document.source])

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="hashtag" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">Base</span>
          <span className="truncate text-xs text-neutral">
            {sourceLabel} · {visibleRows.length}
            {visibleRows.length !== rows.length ? `/${rows.length}` : ''} notes
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            className={classNames(
              'flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-default',
              showConfig && 'bg-default text-info',
            )}
            onClick={() => setShowConfig((value) => !value)}
            title="Configure base"
          >
            <Icon type="tune" size="small" />
            <span className="hidden sm:inline">{showConfig ? 'Done' : 'Configure'}</span>
          </button>
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a Base and a new one was started. Your original text is preserved
            until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      {showConfig && (
        <BaseConfigPanel
          document={document}
          tags={tags}
          folders={folders}
          parsedKeys={parsedKeys}
          usedColumnKeys={usedColumnKeys}
          filterTargetOptions={filterTargetOptions}
          typeForTarget={typeForTarget}
          isReadonly={isReadonly}
          onSetSource={setSource}
          onAddBuiltinColumn={addBuiltinColumn}
          onAddParsedColumn={addParsedColumn}
          onRemoveColumn={removeColumn}
          onMoveColumn={moveColumn}
          onAddFilter={addFilter}
          onUpdateFilter={updateFilter}
          onRemoveFilter={removeFilter}
          onSetSort={setSort}
        />
      )}

      {/* Table (scrolls horizontally on small screens). */}
      <div className="min-h-0 flex-grow overflow-auto">
        {document.columns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
            <p className="font-semibold">No columns yet</p>
            <p>Open Configure to add columns to this base.</p>
            {!isReadonly && (
              <button
                className="mt-3 rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
                onClick={() => setShowConfig(true)}
              >
                Configure
              </button>
            )}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-neutral">
            <p className="font-semibold">No matching notes</p>
            <p>
              {rows.length === 0
                ? 'The selected source has no notes.'
                : 'No notes match the current filters. Adjust them in Configure.'}
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-contrast">
              <tr>
                {document.columns.map((column) => {
                  const sorted = document.sort.columnId === column.id
                  return (
                    <th
                      key={column.id}
                      className="select-none whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold"
                    >
                      <button
                        className="flex items-center gap-1 hover:text-info"
                        onClick={() => toggleSortForColumn(column)}
                        title="Sort by this column"
                        disabled={isReadonly}
                      >
                        <span className="truncate">{columnLabel(column)}</span>
                        {sorted && (
                          <Icon
                            type={document.sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'}
                            size="small"
                            className="flex-shrink-0 text-info"
                          />
                        )}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.uuid}
                  className="cursor-pointer border-b border-border hover:bg-contrast"
                  onClick={() => openNote(row.uuid)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openNote(row.uuid)
                    }
                  }}
                >
                  {document.columns.map((column) => (
                    <td key={column.id} className="max-w-xs truncate px-3 py-2 align-top">
                      {formatCellValue(getColumnValue(row, column)) || (
                        <span className="text-passive-2">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Config panel
// ---------------------------------------------------------------------------

type ConfigProps = {
  document: BaseDocument
  tags: SNTag[]
  folders: SNFolder[]
  parsedKeys: string[]
  usedColumnKeys: Set<string>
  filterTargetOptions: { value: string; label: string }[]
  typeForTarget: (target: string) => 'text' | 'date' | 'number' | 'boolean' | 'list'
  isReadonly: boolean
  onSetSource: (kind: BaseSourceKind, uuid?: string) => void
  onAddBuiltinColumn: (property: BuiltinPropertyId) => void
  onAddParsedColumn: (key: string) => void
  onRemoveColumn: (columnId: string) => void
  onMoveColumn: (columnId: string, direction: -1 | 1) => void
  onAddFilter: () => void
  onUpdateFilter: (filterId: string, patch: Partial<Filter>) => void
  onRemoveFilter: (filterId: string) => void
  onSetSort: (columnId: string | undefined, dir: SortDir) => void
}

const BaseConfigPanel: FunctionComponent<ConfigProps> = ({
  document,
  tags,
  folders,
  parsedKeys,
  usedColumnKeys,
  filterTargetOptions,
  typeForTarget,
  isReadonly,
  onSetSource,
  onAddBuiltinColumn,
  onAddParsedColumn,
  onRemoveColumn,
  onMoveColumn,
  onAddFilter,
  onUpdateFilter,
  onRemoveFilter,
  onSetSort,
}) => {
  const inputClass =
    'min-w-0 rounded border border-border bg-default px-2 py-1 text-xs text-text disabled:opacity-50'

  return (
    <div className="max-h-[45%] overflow-auto border-b border-border bg-default px-3 py-3 text-xs">
      {/* Source */}
      <section className="mb-3">
        <h3 className="mb-1 font-bold uppercase tracking-wide text-passive-1">Source</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={inputClass}
            value={document.source.kind}
            disabled={isReadonly}
            onChange={(event) => {
              const kind = event.target.value as BaseSourceKind
              const first = kind === 'tag' ? tags[0]?.uuid : kind === 'folder' ? folders[0]?.uuid : undefined
              onSetSource(kind, first)
            }}
          >
            <option value="all">All notes</option>
            <option value="tag">Notes with tag</option>
            <option value="folder">Notes in folder</option>
          </select>
          {document.source.kind === 'tag' && (
            <select
              className={classNames(inputClass, 'max-w-[12rem] flex-grow truncate')}
              value={document.source.uuid ?? ''}
              disabled={isReadonly}
              onChange={(event) => onSetSource('tag', event.target.value || undefined)}
            >
              <option value="">Select a tag…</option>
              {tags.map((tag) => (
                <option key={tag.uuid} value={tag.uuid}>
                  {tag.title || 'Untitled'}
                </option>
              ))}
            </select>
          )}
          {document.source.kind === 'folder' && (
            <select
              className={classNames(inputClass, 'max-w-[12rem] flex-grow truncate')}
              value={document.source.uuid ?? ''}
              disabled={isReadonly}
              onChange={(event) => onSetSource('folder', event.target.value || undefined)}
            >
              <option value="">Select a folder…</option>
              {folders.map((folder) => (
                <option key={folder.uuid} value={folder.uuid}>
                  {folder.title || 'Untitled'}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      {/* Columns */}
      <section className="mb-3">
        <h3 className="mb-1 font-bold uppercase tracking-wide text-passive-1">Columns</h3>
        <div className="flex flex-col gap-1">
          {document.columns.map((column, index) => (
            <div key={column.id} className="flex items-center gap-1">
              <span className="min-w-0 flex-grow truncate rounded bg-contrast px-2 py-1">{columnLabel(column)}</span>
              <button
                className="rounded p-1 hover:bg-contrast disabled:opacity-30"
                disabled={isReadonly || index === 0}
                onClick={() => onMoveColumn(column.id, -1)}
                title="Move up"
                aria-label="Move column up"
              >
                <Icon type="arrow-up" size="small" />
              </button>
              <button
                className="rounded p-1 hover:bg-contrast disabled:opacity-30"
                disabled={isReadonly || index === document.columns.length - 1}
                onClick={() => onMoveColumn(column.id, 1)}
                title="Move down"
                aria-label="Move column down"
              >
                <Icon type="arrow-down" size="small" />
              </button>
              <button
                className="rounded p-1 text-danger hover:bg-contrast disabled:opacity-30"
                disabled={isReadonly}
                onClick={() => onRemoveColumn(column.id)}
                title="Remove column"
                aria-label="Remove column"
              >
                <Icon type="trash" size="small" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className={inputClass}
            value=""
            disabled={isReadonly}
            onChange={(event) => {
              if (event.target.value) {
                onAddBuiltinColumn(event.target.value as BuiltinPropertyId)
              }
            }}
          >
            <option value="">+ Add property column…</option>
            {BUILTIN_PROPERTIES.filter((p) => !usedColumnKeys.has(`builtin:${p.id}`)).map((property) => (
              <option key={property.id} value={property.id}>
                {property.label}
              </option>
            ))}
          </select>
          {parsedKeys.length > 0 && (
            <select
              className={inputClass}
              value=""
              disabled={isReadonly}
              onChange={(event) => {
                if (event.target.value) {
                  onAddParsedColumn(event.target.value)
                }
              }}
            >
              <option value="">+ Add parsed property…</option>
              {parsedKeys
                .filter((key) => !usedColumnKeys.has(`parsed:${key.toLowerCase()}`))
                .map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
            </select>
          )}
        </div>
      </section>

      {/* Filters */}
      <section className="mb-3">
        <h3 className="mb-1 font-bold uppercase tracking-wide text-passive-1">Filters</h3>
        <div className="flex flex-col gap-2">
          {document.filters.map((filter) => {
            const type = typeForTarget(filter.target)
            const operators = operatorsForType(type)
            const needsValue = !['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty'].includes(filter.operator)
            return (
              <div key={filter.id} className="flex flex-wrap items-center gap-1">
                <select
                  className={classNames(inputClass, 'max-w-[10rem]')}
                  value={filter.target}
                  disabled={isReadonly}
                  onChange={(event) => {
                    const nextTarget = event.target.value
                    const nextOps = operatorsForType(typeForTarget(nextTarget))
                    const nextOp: FilterOperator = nextOps.includes(filter.operator) ? filter.operator : nextOps[0]
                    onUpdateFilter(filter.id, { target: nextTarget, operator: nextOp })
                  }}
                >
                  {filterTargetOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  className={inputClass}
                  value={filter.operator}
                  disabled={isReadonly}
                  onChange={(event) => onUpdateFilter(filter.id, { operator: event.target.value as FilterOperator })}
                >
                  {operators.map((operator) => (
                    <option key={operator} value={operator}>
                      {operatorLabel(operator)}
                    </option>
                  ))}
                </select>
                {needsValue && (
                  <input
                    className={classNames(inputClass, 'max-w-[10rem] flex-grow')}
                    type={type === 'date' ? 'date' : 'text'}
                    value={filter.value ?? ''}
                    disabled={isReadonly}
                    placeholder="value"
                    onChange={(event) => onUpdateFilter(filter.id, { value: event.target.value })}
                  />
                )}
                <button
                  className="rounded p-1 text-danger hover:bg-contrast disabled:opacity-30"
                  disabled={isReadonly}
                  onClick={() => onRemoveFilter(filter.id)}
                  title="Remove filter"
                  aria-label="Remove filter"
                >
                  <Icon type="trash" size="small" />
                </button>
              </div>
            )
          })}
        </div>
        <button
          className="mt-2 flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-contrast disabled:opacity-50"
          disabled={isReadonly}
          onClick={onAddFilter}
        >
          <Icon type="add" size="small" />
          Add filter
        </button>
      </section>

      {/* Sort */}
      <section>
        <h3 className="mb-1 font-bold uppercase tracking-wide text-passive-1">Sort</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={inputClass}
            value={document.sort.columnId ?? ''}
            disabled={isReadonly}
            onChange={(event) => onSetSort(event.target.value || undefined, document.sort.dir)}
          >
            <option value="">Source order</option>
            {document.columns.map((column) => (
              <option key={column.id} value={column.id}>
                {columnLabel(column)}
              </option>
            ))}
          </select>
          <select
            className={inputClass}
            value={document.sort.dir}
            disabled={isReadonly || !document.sort.columnId}
            onChange={(event) => onSetSort(document.sort.columnId, event.target.value as SortDir)}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
      </section>
    </div>
  )
}

export const initializeBaseNoteText = (): string => serializeBaseDocument(createEmptyBaseDocument())
