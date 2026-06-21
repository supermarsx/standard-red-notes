import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, NoteType, SNNote, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import IconPicker from '@/Components/Icon/IconPicker'
import TagColorPicker from '@/Components/Tags/TagColorPicker'
import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '../SuperEditor/Constants'
import { bookmarkAnchorDomId } from '../SuperEditor/Lexical/Nodes/BookmarkAnchorNode'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import {
  AggregatedBookmark,
  Bookmark,
  DEFAULT_BOOKMARK_ICON,
  collectAllBookmarks,
  filterBookmarks,
  relocateBySnippet,
} from '@/Bookmarks/bookmarks'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

/**
 * Standard Red Notes: the Bookmarks (note markers) aggregate pane (forum #3733).
 *
 * Lists every bookmark from every note's appData (derived in-memory, throttled —
 * no server polling, exactly like the Research/Dashboard views). Each row shows
 * the bookmark's icon + color + nickname and its source note title. The list is
 * searchable. Clicking a bookmark opens its note and jumps to the marked spot.
 * Per-bookmark: rename, set icon (IconPicker), set color (TagColorPicker), delete
 * — reusing the same affordances tags use.
 */
const BookmarksView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { presentPane } = useResponsiveAppPane()

  const readNotes = useCallback(() => application.items.getItems<SNNote>(ContentType.TYPES.Note), [application])

  const [bookmarks, setBookmarks] = useState<AggregatedBookmark[]>(() => collectAllBookmarks(readNotes()))
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [renameValue, setRenameValue] = useState('')

  // Throttled recompute from local item state — no server polling. Driven by item
  // streams + sync completion, exactly like the Research / Reminders views.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setBookmarks(collectAllBookmarks(readNotes()))
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

  const filtered = useMemo(() => filterBookmarks(bookmarks, query), [bookmarks, query])

  const selected = useMemo(
    () => bookmarks.find((entry) => entry.bookmark.id === selectedId),
    [bookmarks, selectedId],
  )

  useEffect(() => {
    setRenameValue(selected?.bookmark.label ?? '')
  }, [selected?.bookmark.id, selected?.bookmark.label])

  /**
   * Open a bookmark's note and jump to the marked spot.
   *
   *  - Super: find the inline anchor element by its stable DOM id and scroll it
   *    into view. The editor mounts asynchronously after the pane is presented, so
   *    we retry over a few animation frames; if the anchor can't be found (e.g. the
   *    note was edited to remove the anchor), we no-op gracefully (no throw) after
   *    falling back to the coarse scroll position.
   *  - Plain: re-locate the offset via the stored snippet (offsets DRIFT on edit;
   *    the snippet mitigates), then set the textarea selection + scroll.
   */
  const openAndJump = useCallback(
    (entry: AggregatedBookmark) => {
      const note = application.items.findItem<SNNote>(entry.note.uuid)
      if (!note) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
      void application.itemListController.selectItemUsingInstance(note, true)
      presentPane(AppPaneId.Editor)

      const anchor = entry.bookmark.anchor
      let attempts = 0
      const MAX_ATTEMPTS = 40 // ~40 frames (<1s) for the editor to mount.

      const tryJump = () => {
        attempts += 1

        if (anchor.kind === 'super') {
          const el = document.getElementById(bookmarkAnchorDomId(anchor.bookmarkId))
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
          }
          // Fall back to the coarse scroll position once we give up finding the anchor.
          if (attempts >= MAX_ATTEMPTS) {
            if (anchor.scrollTop !== undefined) {
              const content = document.getElementById(SuperEditorContentId)
              if (content) {
                content.scrollTop = anchor.scrollTop
              }
            }
            return
          }
        } else {
          const textarea = document.getElementById(ElementIds.NoteTextEditor) as HTMLTextAreaElement | null
          if (textarea) {
            const text = textarea.value ?? note.text ?? ''
            const offset = relocateBySnippet(text, anchor.offset, anchor.snippet)
            textarea.focus()
            try {
              textarea.setSelectionRange(offset, offset)
            } catch {
              /* ignore selection errors on unusual inputs */
            }
            if (anchor.scrollTop !== undefined) {
              textarea.scrollTop = anchor.scrollTop
            }
            return
          }
          if (attempts >= MAX_ATTEMPTS) {
            return
          }
        }

        requestAnimationFrame(tryJump)
      }

      requestAnimationFrame(tryJump)
    },
    [application, presentPane],
  )

  const updateField = useCallback(
    (entry: AggregatedBookmark, patch: { label?: string; color?: string | null; icon?: string | null }) => {
      const note = application.items.findItem<SNNote>(entry.note.uuid)
      if (!note) {
        return
      }
      void application.notesController.updateNoteBookmark(note, entry.bookmark.id, patch).then(() => {
        setBookmarks(collectAllBookmarks(readNotes()))
      })
    },
    [application, readNotes],
  )

  const deleteBookmark = useCallback(
    (entry: AggregatedBookmark) => {
      const note = application.items.findItem<SNNote>(entry.note.uuid)
      if (!note) {
        return
      }
      void application.notesController.removeNoteBookmark(note, entry.bookmark.id).then(() => {
        setBookmarks(collectAllBookmarks(readNotes()))
        setSelectedId((current) => (current === entry.bookmark.id ? undefined : current))
      })
    },
    [application, readNotes],
  )

  const commitRename = useCallback(() => {
    if (selected && renameValue.trim().length > 0 && renameValue !== selected.bookmark.label) {
      updateField(selected, { label: renameValue })
    }
  }, [selected, renameValue, updateField])

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="pin" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Bookmarks</span>
          <span className="text-xs text-passive-1">({bookmarks.length})</span>
        </div>
        <button
          className="rounded p-1 hover:bg-default"
          onClick={() => application.paneController.closeViewTab(AppPaneId.Bookmarks)}
          aria-label="Close bookmarks"
          title="Close"
        >
          <Icon type="close" />
        </button>
      </div>

      <div className="flex min-h-0 flex-grow overflow-hidden">
        {/* List column */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <div className="relative flex min-w-[160px] flex-1 items-center">
              <Icon type="search" size="small" className="pointer-events-none absolute left-2 text-neutral" />
              <input
                className="w-full rounded border border-border bg-default px-2 py-1 pl-7 text-sm text-text focus:border-info focus:outline-none"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search bookmarks"
              />
            </div>
            {query && (
              <button className="rounded px-2 py-1 text-xs text-neutral hover:bg-contrast" onClick={() => setQuery('')}>
                Clear
              </button>
            )}
          </div>

          <div className="min-h-0 flex-grow overflow-y-auto">
            {bookmarks.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-passive-1">
                No bookmarks yet. In a note, press Ctrl/Cmd+M (or use the note options menu / the Super “/” Insert
                menu) to bookmark a spot.
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-passive-1">No bookmarks match your search.</div>
            ) : (
              <ul>
                {filtered.map((entry) => (
                  <li key={entry.bookmark.id}>
                    <button
                      className={classNames(
                        'flex w-full items-center gap-3 border-b border-border px-4 py-2 text-left hover:bg-contrast',
                        entry.bookmark.id === selectedId && 'bg-contrast',
                      )}
                      onClick={() => setSelectedId(entry.bookmark.id)}
                      onDoubleClick={() => openAndJump(entry)}
                      title="Click to manage, double-click to jump"
                    >
                      <span
                        className="flex-shrink-0"
                        style={entry.bookmark.color ? { color: entry.bookmark.color } : undefined}
                      >
                        <Icon
                          type={(entry.bookmark.icon as VectorIconNameOrEmoji) || DEFAULT_BOOKMARK_ICON}
                          className={entry.bookmark.color ? 'fill-current' : undefined}
                        />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-semibold text-text">{entry.bookmark.label}</span>
                        <span className="truncate text-xs text-passive-1">{entry.noteTitle}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Detail / edit column */}
        <div className="hidden w-[320px] flex-shrink-0 flex-col overflow-y-auto border-l border-border p-4 md:flex">
          {selected ? (
            <BookmarkDetail
              key={selected.bookmark.id}
              entry={selected}
              platform={application.platform}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              commitRename={commitRename}
              onOpen={() => openAndJump(selected)}
              onIconChange={(icon) => updateField(selected, { icon: icon ?? null })}
              onColorChange={(color) => updateField(selected, { color: color ?? null })}
              onDelete={() => deleteBookmark(selected)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-passive-1">
              Select a bookmark to manage it, or double-click one to jump to its spot.
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  )
})

const BookmarkDetail = ({
  entry,
  platform,
  renameValue,
  setRenameValue,
  commitRename,
  onOpen,
  onIconChange,
  onColorChange,
  onDelete,
}: {
  entry: AggregatedBookmark
  platform: WebApplication['platform']
  renameValue: string
  setRenameValue: (value: string) => void
  commitRename: () => void
  onOpen: () => void
  onIconChange: (icon?: string) => void
  onColorChange: (color?: string) => void
  onDelete: () => void
}) => {
  const { bookmark, noteTitle }: { bookmark: Bookmark; noteTitle: string } = entry
  const driftCaveat =
    bookmark.anchor.kind === 'plain'
      ? 'Plain-text position is best-effort and may shift if the note was edited; it is re-located via a saved text snippet.'
      : 'Super position is anchored to the document and moves with edits.'

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span style={bookmark.color ? { color: bookmark.color } : undefined}>
          <Icon
            type={(bookmark.icon as VectorIconNameOrEmoji) || DEFAULT_BOOKMARK_ICON}
            className={bookmark.color ? 'fill-current' : undefined}
          />
        </span>
        <h3 className="truncate text-base font-bold text-text">{bookmark.label}</h3>
      </div>
      <p className="mb-3 truncate text-xs text-passive-1" title={noteTitle}>
        in {noteTitle}
      </p>

      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral">Nickname</label>
      <input
        className="mb-3 w-full rounded border border-border bg-default px-2 py-1 text-sm text-text focus:border-info focus:outline-none"
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />

      <div className="mb-3">
        <TagColorPicker selectedColor={bookmark.color} onChange={(color) => onColorChange(color)} />
      </div>

      <div className="mb-3">
        <div className="mb-1.5 text-sm font-semibold">Icon</div>
        <IconPicker
          selectedValue={(bookmark.icon as VectorIconNameOrEmoji) || DEFAULT_BOOKMARK_ICON}
          onIconChange={(value) => onIconChange(value as string | undefined)}
          platform={platform}
          useIconGrid
        />
      </div>

      <p className="mb-3 text-xs text-passive-1">{driftCaveat}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="flex items-center gap-1 rounded bg-info px-3 py-1 text-sm font-semibold text-info-contrast hover:brightness-110"
          onClick={onOpen}
        >
          <Icon type="open-in" size="small" />
          Open & jump
        </button>
        <button
          className="flex items-center gap-1 rounded px-3 py-1 text-sm text-danger hover:bg-contrast"
          onClick={onDelete}
        >
          <Icon type="trash" size="small" />
          Delete
        </button>
      </div>
    </div>
  )
}

BookmarksView.displayName = 'BookmarksView'

export default observer(BookmarksView)
