import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { TemplateEntry, collectTemplates, filterTemplates } from '@/Templates/templates'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

/**
 * Standard Red Notes: the Templates aggregate pane.
 *
 * Lists every note flagged as a reusable template (the flag lives in the note's
 * appData — see Templates/templates.ts). Derived in-memory, throttled — no server
 * polling, exactly like the Bookmarks/Research/Dashboard views. Each row shows the
 * template's title + a short preview. "New note from this template" creates a
 * fresh, INDEPENDENT note that copies the template's text + editor type (but is
 * not itself a template) and opens it.
 */
const TemplatesView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { presentPane } = useResponsiveAppPane()

  const readNotes = useCallback(() => application.items.getItems<SNNote>(ContentType.TYPES.Note), [application])

  const [templates, setTemplates] = useState<TemplateEntry[]>(() => collectTemplates(readNotes()))
  const [query, setQuery] = useState('')

  // Throttled recompute from local item state — no server polling. Driven by item
  // streams + sync completion, exactly like the Bookmarks / Research views.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setTemplates(collectTemplates(readNotes()))
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

  const filtered = useMemo(() => filterTemplates(templates, query), [templates, query])

  /** Open the template note itself (to edit the template). */
  const openTemplate = useCallback(
    (entry: TemplateEntry) => {
      void application.itemListController.selectItemUsingInstance(entry.note, true)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  /** Create a fresh independent note from the template and open it. */
  const newFromTemplate = useCallback(
    (entry: TemplateEntry) => {
      void application.notesController.createNoteFromTemplate(entry.note).then((created) => {
        if (created) {
          presentPane(AppPaneId.Editor)
        }
      })
    },
    [application, presentPane],
  )

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="copy" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Templates</span>
          <span className="text-xs text-passive-1">({templates.length})</span>
        </div>
        <button
          className="rounded p-1 hover:bg-default"
          onClick={() => application.paneController.closeViewTab(AppPaneId.Templates)}
          aria-label="Close templates"
          title="Close"
        >
          <Icon type="close" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <div className="relative flex min-w-[160px] flex-1 items-center">
          <Icon type="search" size="small" className="pointer-events-none absolute left-2 text-neutral" />
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 pl-7 text-sm text-text focus:border-info focus:outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
          />
        </div>
        {query && (
          <button className="rounded px-2 py-1 text-xs text-neutral hover:bg-contrast" onClick={() => setQuery('')}>
            Clear
          </button>
        )}
      </div>

      <div className="min-h-0 flex-grow overflow-y-auto">
        {templates.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-passive-1">
            No templates yet. Open a note, then use its options menu (•••) → “Save as template”.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-passive-1">No templates match your search.</div>
        ) : (
          <ul>
            {filtered.map((entry) => (
              <li key={entry.note.uuid}>
                <div className="flex items-start gap-3 border-b border-border px-4 py-3 hover:bg-contrast">
                  <Icon type="copy" className="mt-0.5 flex-shrink-0 text-neutral" />
                  <button
                    className="flex min-w-0 flex-grow flex-col text-left"
                    onClick={() => openTemplate(entry)}
                    title="Open this template to edit it"
                  >
                    <span className="truncate text-sm font-semibold text-text">{entry.title}</span>
                    {entry.preview && (
                      <span className="truncate text-xs text-passive-1">{entry.preview}</span>
                    )}
                  </button>
                  <button
                    className="flex flex-shrink-0 items-center gap-1 rounded bg-info px-2.5 py-1 text-xs font-semibold text-info-contrast hover:brightness-110"
                    onClick={() => newFromTemplate(entry)}
                    title="Create a new note from this template"
                  >
                    <Icon type="add" size="small" />
                    New note
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </div>
  )
})

TemplatesView.displayName = 'TemplatesView'

export default observer(TemplatesView)
