import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { SNNote, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'
import { useApplication } from '@/Components/ApplicationProvider'
import { useMediaQuery, MutuallyExclusiveMediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { DEFAULT_BOOKMARK_ICON, getNoteBookmarks } from '@/Bookmarks/bookmarks'
import { NavigationSettings, loadNoteLayout, saveNoteLayout } from '../../Layout/layoutSettings'
import { bookmarkAnchorDomId } from '../../Lexical/Nodes/BookmarkAnchorNode'
import { $buildDocumentOutline, DocumentOutline } from './outline'

/**
 * Standard Red Notes: the on-screen navigation sidebar (a Word-style document
 * outline) for the Super editor.
 *
 * Renders a live tree of the note's HEADINGS (indented by level) plus a
 * BOOKMARKS section, docked beside the editor content. Clicking an entry scrolls
 * the editor to it. This is a desktop, on-screen affordance only — it never
 * affects export/print output.
 *
 * Visibility lives in the per-note `NoteLayout.navigation` bag. The Layout popover
 * (ToolbarPlugin) owns the toggle and communicates changes across the Lexical
 * boundary via a DOM CustomEvent on the editor root — mirroring the established
 * `BOOKMARK_INSERT_DOM_EVENT` bridge. The sidebar's own close button does the
 * reverse (persist + dispatch) so the popover checkbox stays in sync.
 */

/** DOM CustomEvent name bridging the Layout popover toggle ↔ this sidebar. */
export const NAVIGATION_LAYOUT_CHANGED_EVENT = 'srn:navigation-layout-changed'

/** The `detail` payload carried by {@link NAVIGATION_LAYOUT_CHANGED_EVENT}. */
export type NavigationLayoutChangedDetail = NavigationSettings

/** How often the outline recomputes while the document changes (throttle window). */
const OUTLINE_THROTTLE_MS = 300

const NavigationSidebar = () => {
  const [editor] = useLexicalComposerContext()
  const application = useApplication()
  const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  const activeNoteUuid = application.itemListController.activeControllerItem?.uuid

  // Visibility / options — seeded from the persisted per-note layout, kept live
  // via the popover's DOM-event bridge and re-read when the active note changes.
  const [navigation, setNavigation] = useState<NavigationSettings>(() => loadNoteLayout(activeNoteUuid).navigation)
  useEffect(() => {
    setNavigation(loadNoteLayout(activeNoteUuid).navigation)
  }, [activeNoteUuid])

  // Live outline of the document (headings + bookmark anchors), throttled so
  // large-doc typing doesn't churn.
  const [outline, setOutline] = useState<DocumentOutline>(() => editor.getEditorState().read($buildDocumentOutline))
  useEffect(() => {
    setOutline(editor.getEditorState().read($buildDocumentOutline))

    let timeout: ReturnType<typeof setTimeout> | undefined
    let pending = false
    const recompute = () => {
      pending = false
      setOutline(editor.getEditorState().read($buildDocumentOutline))
    }
    const schedule = () => {
      if (timeout) {
        pending = true
        return
      }
      recompute()
      timeout = setTimeout(() => {
        timeout = undefined
        if (pending) {
          recompute()
        }
      }, OUTLINE_THROTTLE_MS)
    }
    const unregister = editor.registerUpdateListener(() => schedule())
    return () => {
      unregister()
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [editor])

  // Listen for the Layout popover's toggle changes (popover → sidebar).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NavigationLayoutChangedDetail>).detail
      if (detail && typeof detail === 'object') {
        setNavigation({ visible: detail.visible === true, showBookmarks: detail.showBookmarks !== false })
      }
    }
    // The root element may not be attached yet on first run; registerRootListener
    // fires with the current element and on every (re)mount.
    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener(NAVIGATION_LAYOUT_CHANGED_EVENT, handler)
      rootElement?.addEventListener(NAVIGATION_LAYOUT_CHANGED_EVENT, handler)
    })
  }, [editor])

  // Bookmark id → label/icon/color, joined from the note's appData. Best-effort
  // and refreshed on each render tick (labels live outside the Lexical tree).
  const bookmarkMeta = useMemo(() => {
    const map = new Map<string, { label: string; icon?: string; color?: string }>()
    if (!activeNoteUuid) {
      return map
    }
    try {
      const note = application.items.findItem<SNNote>(activeNoteUuid)
      if (note) {
        for (const bookmark of getNoteBookmarks(note)) {
          map.set(bookmark.id, { label: bookmark.label, icon: bookmark.icon, color: bookmark.color })
        }
      }
    } catch {
      /* tolerate a note that can't be resolved (e.g. during teardown) */
    }
    return map
    // Recompute when the note changes or the outline (a throttled tick) refreshes.
  }, [application, activeNoteUuid, outline])

  const jumpToHeading = useCallback(
    (nodeKey: string) => {
      editor.getElementByKey(nodeKey)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    [editor],
  )

  const jumpToBookmark = useCallback(
    (nodeKey: string, bookmarkId: string) => {
      const byKey = editor.getElementByKey(nodeKey)
      if (byKey) {
        byKey.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      // Fallback: the stable DOM id on the rendered anchor (t60's proven target).
      const doc = editor.getRootElement()?.ownerDocument ?? document
      doc.getElementById(bookmarkAnchorDomId(bookmarkId))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [editor],
  )

  const persistNavigation = useCallback(
    (patch: Partial<NavigationSettings>) => {
      setNavigation((prev) => {
        const next: NavigationSettings = { ...prev, ...patch }
        const layout = loadNoteLayout(activeNoteUuid)
        saveNoteLayout(activeNoteUuid, { ...layout, navigation: next })
        editor
          .getRootElement()
          ?.dispatchEvent(
            new CustomEvent<NavigationLayoutChangedDetail>(NAVIGATION_LAYOUT_CHANGED_EVENT, { detail: next }),
          )
        return next
      })
    },
    [activeNoteUuid, editor],
  )

  if (!navigation.visible || isMobile) {
    return null
  }

  const showBookmarks = navigation.showBookmarks && outline.bookmarks.length > 0

  return (
    <aside
      data-navigation-sidebar="true"
      className="border-border bg-default flex w-60 flex-shrink-0 flex-col overflow-y-auto border-r"
    >
      <div className="border-border bg-contrast flex items-center justify-between border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="list-bulleted" className="text-info flex-shrink-0" size="small" />
          <span className="truncate text-sm font-bold">Navigation</span>
        </div>
        <button
          className="hover:bg-default rounded p-1"
          onClick={() => persistNavigation({ visible: false })}
          aria-label="Hide navigation sidebar"
          title="Hide"
        >
          <Icon type="close" size="small" />
        </button>
      </div>

      <div className="min-h-0 flex-grow overflow-y-auto py-1">
        {outline.headings.length === 0 ? (
          <div className="text-passive-1 px-3 py-4 text-center text-xs">No headings yet.</div>
        ) : (
          <ul>
            {outline.headings.map((heading) => (
              <li key={heading.nodeKey}>
                <button
                  data-outline-heading="true"
                  className="text-text hover:bg-contrast flex w-full items-center truncate py-1 pr-2 text-left text-sm"
                  style={{ paddingLeft: (heading.level - 1) * 12 + 8 }}
                  onClick={() => jumpToHeading(heading.nodeKey)}
                  title={heading.text || 'Untitled heading'}
                >
                  <span className="truncate">{heading.text || '(untitled heading)'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {showBookmarks && (
          <div className="border-border mt-2 border-t pt-1">
            <div className="text-neutral px-3 py-1 text-xs font-semibold tracking-wide uppercase">Bookmarks</div>
            <ul>
              {outline.bookmarks.map((bookmark) => {
                const meta = bookmarkMeta.get(bookmark.bookmarkId)
                return (
                  <li key={bookmark.nodeKey}>
                    <button
                      data-outline-bookmark="true"
                      className={classNames(
                        'text-text hover:bg-contrast flex w-full items-center gap-2 py-1 pr-2 pl-2 text-left text-sm',
                      )}
                      onClick={() => jumpToBookmark(bookmark.nodeKey, bookmark.bookmarkId)}
                      title={meta?.label ?? 'Bookmark'}
                    >
                      <span className="flex-shrink-0" style={meta?.color ? { color: meta.color } : undefined}>
                        <Icon
                          type={(meta?.icon as VectorIconNameOrEmoji) || DEFAULT_BOOKMARK_ICON}
                          size="small"
                          className={meta?.color ? 'fill-current' : undefined}
                        />
                      </span>
                      <span className="truncate">{meta?.label ?? 'Bookmark'}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </aside>
  )
}

export default NavigationSidebar
