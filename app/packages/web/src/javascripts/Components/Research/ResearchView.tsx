import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import {
  REFERENCE_KINDS,
  REFERENCE_KIND_LABELS,
  ReferenceFilter,
  ReferenceItem,
  ReferenceKind,
  ReferenceMetadata,
  ReferenceSortKey,
  SortDirection,
  availableKinds,
  availableTags,
  availableYears,
  buildReferenceLibrary,
  citationString,
  filterReferences,
  noteIsReference,
  referencesToBibTeX,
  referencesToCSV,
  sortReferences,
  writeNoteReference,
} from '@/References/references'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

/** Trigger a browser download of `content` (Blob + temporary anchor). */
function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.setAttribute('download', filename)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

const todayStamp = (): string => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/* -------------------------------------------------------------------------- */
/* Reference form (add / edit)                                                */
/* -------------------------------------------------------------------------- */

type FormState = {
  kind: ReferenceKind
  authors: string
  year: string
  url: string
  publisher: string
  tags: string
  notes: string
}

const emptyForm = (): FormState => ({
  kind: 'article',
  authors: '',
  year: '',
  url: '',
  publisher: '',
  tags: '',
  notes: '',
})

const formFromMetadata = (metadata: ReferenceMetadata): FormState => ({
  kind: metadata.kind ?? 'other',
  authors: (metadata.authors ?? []).join(', '),
  year: metadata.year !== undefined ? String(metadata.year) : '',
  url: metadata.url ?? '',
  publisher: metadata.publisher ?? '',
  tags: (metadata.tags ?? []).join(', '),
  notes: metadata.notes ?? '',
})

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

const metadataFromForm = (form: FormState): ReferenceMetadata => {
  const metadata: ReferenceMetadata = { isReference: true, kind: form.kind }
  const authors = splitList(form.authors)
  if (authors.length > 0) {
    metadata.authors = authors
  }
  const year = Number(form.year)
  if (form.year.trim().length > 0 && Number.isFinite(year)) {
    metadata.year = Math.floor(year)
  }
  if (form.url.trim()) {
    metadata.url = form.url.trim()
  }
  if (form.publisher.trim()) {
    metadata.publisher = form.publisher.trim()
  }
  const tags = splitList(form.tags)
  if (tags.length > 0) {
    metadata.tags = tags
  }
  if (form.notes.trim()) {
    metadata.notes = form.notes.trim()
  }
  return metadata
}

const fieldClass =
  'w-full rounded border border-border bg-default px-2 py-1 text-sm text-text focus:border-info focus:outline-none'
const labelClass = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral'

const ReferenceForm = ({
  title,
  notePicker,
  form,
  setForm,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  title: string
  notePicker?: ReactNode
  form: FormState
  setForm: (next: FormState) => void
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
}) => {
  const update = (patch: Partial<FormState>) => setForm({ ...form, ...patch })
  return (
    <div className="rounded-md border border-border bg-default p-4">
      <h3 className="mb-3 text-sm font-bold text-text">{title}</h3>
      {notePicker}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>Type</label>
          <select className={fieldClass} value={form.kind} onChange={(e) => update({ kind: e.target.value as ReferenceKind })}>
            {REFERENCE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {REFERENCE_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Year</label>
          <input className={fieldClass} value={form.year} inputMode="numeric" onChange={(e) => update({ year: e.target.value })} placeholder="e.g. 2024" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Authors (comma-separated)</label>
          <input className={fieldClass} value={form.authors} onChange={(e) => update({ authors: e.target.value })} placeholder="Knuth, D., Lamport, L." />
        </div>
        <div>
          <label className={labelClass}>Publisher</label>
          <input className={fieldClass} value={form.publisher} onChange={(e) => update({ publisher: e.target.value })} />
        </div>
        <div>
          <label className={labelClass}>URL</label>
          <input className={fieldClass} value={form.url} onChange={(e) => update({ url: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Keywords / tags (comma-separated)</label>
          <input className={fieldClass} value={form.tags} onChange={(e) => update({ tags: e.target.value })} placeholder="algorithms, ml" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>Notes</label>
          <textarea className={classNames(fieldClass, 'min-h-[60px] resize-y')} value={form.notes} onChange={(e) => update({ notes: e.target.value })} />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button className="rounded px-3 py-1 text-sm text-neutral hover:bg-contrast" onClick={onCancel}>
          Cancel
        </button>
        <button className="rounded bg-info px-3 py-1 text-sm font-semibold text-info-contrast hover:brightness-110" onClick={onSubmit}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Main view                                                                  */
/* -------------------------------------------------------------------------- */

type Mode = { type: 'browse' } | { type: 'add' } | { type: 'edit'; uuid: string }

const ResearchView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { removePane, presentPane } = useResponsiveAppPane()

  const readNotes = useCallback(
    () => application.items.getItems<SNNote>(ContentType.TYPES.Note),
    [application],
  )

  const [library, setLibrary] = useState<ReferenceItem[]>(() => buildReferenceLibrary(readNotes()))
  const [selectedUuid, setSelectedUuid] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<Mode>({ type: 'browse' })

  // Filters / sort / search state.
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<ReferenceKind | ''>('')
  const [tagFilter, setTagFilter] = useState('')
  const [yearFilter, setYearFilter] = useState('')
  const [sortKey, setSortKey] = useState<ReferenceSortKey>('title')
  const [sortDir, setSortDir] = useState<SortDirection>('asc')

  // Add-reference note picker + form state.
  const [pickUuid, setPickUuid] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm())

  // Throttled recompute from local item state — no server polling. Driven by
  // item streams + sync completion, exactly like the Dashboard / Reminders view.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setLibrary(buildReferenceLibrary(readNotes()))
    }

    const scheduleRecompute = () => {
      if (throttleTimeout) {
        pending = true
        return
      }
      recompute()
      throttleTimeout = setTimeout(() => {
        throttleTimeout = undefined
        if (pending) {
          recompute()
        }
      }, RECOMPUTE_THROTTLE_MS)
    }

    const removeItemObserver = application.items.streamItems([ContentType.TYPES.Note], () => scheduleRecompute())
    const removeSyncObserver = application.addEventObserver(async () => {
      scheduleRecompute()
    }, ApplicationEvent.CompletedFullSync)

    return () => {
      removeItemObserver()
      removeSyncObserver()
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
      }
    }
  }, [application, readNotes])

  const kinds = useMemo(() => availableKinds(library), [library])
  const tags = useMemo(() => availableTags(library), [library])
  const years = useMemo(() => availableYears(library), [library])

  const filteredSorted = useMemo(() => {
    const filter: ReferenceFilter = { query }
    if (kindFilter) {
      filter.kind = kindFilter
    }
    if (tagFilter) {
      filter.tag = tagFilter
    }
    if (yearFilter) {
      const year = Number(yearFilter)
      if (Number.isFinite(year)) {
        filter.year = year
      }
    }
    return sortReferences(filterReferences(library, filter), sortKey, sortDir)
  }, [library, query, kindFilter, tagFilter, yearFilter, sortKey, sortDir])

  const selected = useMemo(
    () => library.find((item) => item.uuid === selectedUuid),
    [library, selectedUuid],
  )

  // Notes not yet marked as references — candidates for "Add reference".
  const candidateNotes = useMemo(
    () => readNotes().filter((note) => !note.trashed && !noteIsReference(note)),
    [readNotes, library],
  )

  const openNote = useCallback(
    (uuid: string) => {
      const note = application.items.findItem<SNNote>(uuid)
      if (!note) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
      void application.itemListController.selectItemUsingInstance(note, true)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  const toggleSort = (key: ReferenceSortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const startAdd = () => {
    setForm(emptyForm())
    setPickUuid('')
    setMode({ type: 'add' })
  }

  const startEdit = (item: ReferenceItem) => {
    setForm(formFromMetadata(item.metadata))
    setMode({ type: 'edit', uuid: item.uuid })
  }

  const cancelForm = () => setMode({ type: 'browse' })

  const submitAdd = useCallback(() => {
    if (!pickUuid) {
      return
    }
    const note = application.items.findItem<SNNote>(pickUuid)
    if (!note) {
      return
    }
    void writeNoteReference(application, note, metadataFromForm(form)).then(() => {
      setLibrary(buildReferenceLibrary(readNotes()))
      setSelectedUuid(note.uuid)
      setMode({ type: 'browse' })
    })
  }, [application, pickUuid, form, readNotes])

  const submitEdit = useCallback(() => {
    if (mode.type !== 'edit') {
      return
    }
    const note = application.items.findItem<SNNote>(mode.uuid)
    if (!note) {
      return
    }
    void writeNoteReference(application, note, metadataFromForm(form)).then(() => {
      setLibrary(buildReferenceLibrary(readNotes()))
      setMode({ type: 'browse' })
    })
  }, [application, mode, form, readNotes])

  const removeReference = useCallback(
    (item: ReferenceItem) => {
      const note = application.items.findItem<SNNote>(item.uuid)
      if (!note) {
        return
      }
      void writeNoteReference(application, note, undefined).then(() => {
        setLibrary(buildReferenceLibrary(readNotes()))
        setSelectedUuid((current) => (current === item.uuid ? undefined : current))
      })
    },
    [application, readNotes],
  )

  const copyCitation = useCallback((item: ReferenceItem) => {
    const text = citationString(item)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(console.error)
    }
  }, [])

  const exportBibTeX = () => {
    if (filteredSorted.length === 0) {
      return
    }
    downloadText(referencesToBibTeX(filteredSorted), `references-${todayStamp()}.bib`, 'application/x-bibtex;charset=utf-8')
  }

  const exportCSV = () => {
    if (filteredSorted.length === 0) {
      return
    }
    downloadText(referencesToCSV(filteredSorted), `references-${todayStamp()}.csv`, 'text/csv;charset=utf-8')
  }

  const sortIndicator = (key: ReferenceSortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const filtersActive = Boolean(query || kindFilter || tagFilter || yearFilter)

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="toc" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Research</span>
          <span className="text-xs text-passive-1">({library.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-info hover:bg-default"
            onClick={startAdd}
            title="Add an existing note as a reference"
          >
            <Icon type="add" size="small" />
            Add reference
          </button>
          <button
            className="rounded p-1 hover:bg-default disabled:opacity-40"
            onClick={exportBibTeX}
            disabled={filteredSorted.length === 0}
            aria-label="Export as BibTeX"
            title="Export current list as BibTeX"
          >
            <Icon type="download" size="small" />
          </button>
          <button
            className="rounded px-2 py-1 text-xs font-semibold text-neutral hover:bg-default disabled:opacity-40"
            onClick={exportCSV}
            disabled={filteredSorted.length === 0}
            title="Export current list as CSV"
          >
            CSV
          </button>
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => removePane(AppPaneId.Research)}
            aria-label="Close research"
            title="Close"
          >
            <Icon type="menu-close" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-grow overflow-hidden">
        {/* Library column */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Search + filters */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <div className="relative flex min-w-[160px] flex-1 items-center">
              <Icon type="search" size="small" className="pointer-events-none absolute left-2 text-neutral" />
              <input
                className={classNames(fieldClass, 'pl-7')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search references"
              />
            </div>
            <select className={classNames(fieldClass, 'w-auto')} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as ReferenceKind | '')}>
              <option value="">All types</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {REFERENCE_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
            <select className={classNames(fieldClass, 'w-auto')} value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} disabled={tags.length === 0}>
              <option value="">All tags</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <select className={classNames(fieldClass, 'w-auto')} value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} disabled={years.length === 0}>
              <option value="">All years</option>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            {filtersActive && (
              <button
                className="rounded px-2 py-1 text-xs text-neutral hover:bg-contrast"
                onClick={() => {
                  setQuery('')
                  setKindFilter('')
                  setTagFilter('')
                  setYearFilter('')
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Table */}
          <div className="min-h-0 flex-grow overflow-y-auto">
            {library.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-passive-1">
                No references yet. Use “Add reference” to mark an existing note as a research source.
              </div>
            ) : filteredSorted.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-passive-1">No references match your filters.</div>
            ) : (
              <table className="w-full table-fixed border-collapse text-sm">
                <thead className="sticky top-0 bg-contrast text-left text-xs uppercase tracking-wide text-neutral">
                  <tr>
                    <th className="w-[36%] cursor-pointer px-3 py-2 font-semibold" onClick={() => toggleSort('title')}>
                      Title{sortIndicator('title')}
                    </th>
                    <th className="w-[28%] cursor-pointer px-3 py-2 font-semibold" onClick={() => toggleSort('authors')}>
                      Authors{sortIndicator('authors')}
                    </th>
                    <th className="w-[10%] cursor-pointer px-3 py-2 font-semibold" onClick={() => toggleSort('year')}>
                      Year{sortIndicator('year')}
                    </th>
                    <th className="w-[14%] cursor-pointer px-3 py-2 font-semibold" onClick={() => toggleSort('kind')}>
                      Type{sortIndicator('kind')}
                    </th>
                    <th className="w-[12%] px-3 py-2 font-semibold">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSorted.map((item) => (
                    <tr
                      key={item.uuid}
                      className={classNames(
                        'cursor-pointer border-b border-border hover:bg-contrast',
                        item.uuid === selectedUuid && 'bg-contrast',
                      )}
                      onClick={() => setSelectedUuid(item.uuid)}
                    >
                      <td className="truncate px-3 py-2 font-semibold text-text" title={item.title}>
                        {item.title}
                      </td>
                      <td className="truncate px-3 py-2 text-neutral" title={(item.metadata.authors ?? []).join(', ')}>
                        {(item.metadata.authors ?? []).join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-neutral">{item.metadata.year ?? '—'}</td>
                      <td className="px-3 py-2 text-neutral">
                        {item.metadata.kind ? REFERENCE_KIND_LABELS[item.metadata.kind] : '—'}
                      </td>
                      <td className="truncate px-3 py-2 text-passive-1" title={(item.metadata.tags ?? []).join(', ')}>
                        {(item.metadata.tags ?? []).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Detail / form column */}
        <div className="hidden w-[340px] flex-shrink-0 flex-col overflow-y-auto border-l border-border p-4 md:flex">
          {mode.type === 'add' ? (
            <ReferenceForm
              title="Add reference"
              notePicker={
                <div className="mb-3">
                  <label className={labelClass}>Note</label>
                  <select className={fieldClass} value={pickUuid} onChange={(e) => setPickUuid(e.target.value)}>
                    <option value="">Select an existing note…</option>
                    {candidateNotes.map((note) => (
                      <option key={note.uuid} value={note.uuid}>
                        {note.title?.trim() || 'Untitled'}
                      </option>
                    ))}
                  </select>
                  {candidateNotes.length === 0 && (
                    <p className="mt-1 text-xs text-passive-1">Every note is already a reference.</p>
                  )}
                </div>
              }
              form={form}
              setForm={setForm}
              onSubmit={submitAdd}
              onCancel={cancelForm}
              submitLabel="Add to library"
            />
          ) : mode.type === 'edit' ? (
            <ReferenceForm
              title="Edit reference"
              form={form}
              setForm={setForm}
              onSubmit={submitEdit}
              onCancel={cancelForm}
              submitLabel="Save changes"
            />
          ) : selected ? (
            <div>
              <div className="mb-3 flex items-start justify-between gap-2">
                <h3 className="text-base font-bold text-text">{selected.title}</h3>
              </div>
              <dl className="space-y-2 text-sm">
                {selected.metadata.kind && (
                  <Detail label="Type" value={REFERENCE_KIND_LABELS[selected.metadata.kind]} />
                )}
                {selected.metadata.authors && <Detail label="Authors" value={selected.metadata.authors.join(', ')} />}
                {selected.metadata.year !== undefined && <Detail label="Year" value={String(selected.metadata.year)} />}
                {selected.metadata.publisher && <Detail label="Publisher" value={selected.metadata.publisher} />}
                {selected.metadata.url && (
                  <div>
                    <dt className={labelClass}>URL</dt>
                    <dd>
                      <a className="break-all text-info hover:underline" href={selected.metadata.url} target="_blank" rel="noreferrer">
                        {selected.metadata.url}
                      </a>
                    </dd>
                  </div>
                )}
                {selected.metadata.tags && <Detail label="Tags" value={selected.metadata.tags.join(', ')} />}
                {selected.metadata.notes && <Detail label="Notes" value={selected.metadata.notes} />}
              </dl>

              <div className="mt-4 rounded border border-border bg-contrast p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className={labelClass}>Citation</span>
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-info hover:bg-default"
                    onClick={() => copyCitation(selected)}
                    title="Copy citation"
                  >
                    <Icon type="copy" size="small" />
                    Copy
                  </button>
                </div>
                <p className="text-sm text-text">{citationString(selected)}</p>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  className="flex items-center gap-1 rounded bg-info px-3 py-1 text-sm font-semibold text-info-contrast hover:brightness-110"
                  onClick={() => openNote(selected.uuid)}
                >
                  <Icon type="open-in" size="small" />
                  Open note
                </button>
                <button
                  className="flex items-center gap-1 rounded px-3 py-1 text-sm text-neutral hover:bg-contrast"
                  onClick={() => startEdit(selected)}
                >
                  <Icon type="pencil" size="small" />
                  Edit
                </button>
                <button
                  className="flex items-center gap-1 rounded px-3 py-1 text-sm text-danger hover:bg-contrast"
                  onClick={() => removeReference(selected)}
                  title="Remove reference metadata (the note itself is kept)"
                >
                  <Icon type="trash" size="small" />
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-passive-1">
              Select a reference to see its details.
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  )
})

const Detail = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className={labelClass}>{label}</dt>
    <dd className="whitespace-pre-wrap break-words text-text">{value}</dd>
  </div>
)

ResearchView.displayName = 'ResearchView'

export default observer(ResearchView)
