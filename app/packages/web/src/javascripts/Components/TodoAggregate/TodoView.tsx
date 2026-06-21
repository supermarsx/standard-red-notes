import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { NoteTodos, collectAllTodos, totalTodoProgress } from './allTodos'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

const SOURCE_LABEL: Record<NoteTodos['source'], string> = {
  super: 'Super checklist',
  'advanced-checklist': 'Advanced Checklist',
}

const ProgressBar = ({ completed, total }: { completed: number; total: number }) => {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-contrast">
        <div className="h-full rounded-full bg-info transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-passive-1">
        {completed}/{total}
      </span>
    </div>
  )
}

const TodoView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const [groups, setGroups] = useState<NoteTodos[]>(() =>
    collectAllTodos(application.items.getItems<SNNote>(ContentType.TYPES.Note)),
  )

  // Throttled recompute from local item state — no server polling.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setGroups(collectAllTodos(application.items.getItems<SNNote>(ContentType.TYPES.Note)))
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
  }, [application])

  const total = useMemo(() => totalTodoProgress(groups), [groups])

  const openNote = useCallback(
    (uuid: string) => {
      const note = application.items.findItem<SNNote>(uuid)
      if (!note) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
      void application.itemListController.selectItemUsingInstance(note, true)
      application.paneController.presentPane(AppPaneId.Editor)
    },
    [application],
  )

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="tasks" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Todos</span>
          {total.total > 0 && (
            <span className="ml-2 hidden sm:block">
              <ProgressBar completed={total.completed} total={total.total} />
            </span>
          )}
        </div>
        <button
          className="rounded p-1 hover:bg-default"
          onClick={() => application.paneController.closeViewTab(AppPaneId.Todos)}
          aria-label="Close todos"
          title="Close"
        >
          <Icon type="close" />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4">
        {groups.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-passive-1">
            No todos yet. Add a checklist in a Super note or an Advanced Checklist note.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <section
                key={group.note.uuid}
                className="overflow-hidden rounded-md border border-border bg-default"
                aria-label={group.note.title?.trim() || 'Untitled'}
              >
                <button
                  className="flex w-full items-center justify-between gap-2 border-b border-border bg-contrast px-4 py-2 text-left hover:bg-default"
                  onClick={() => openNote(group.note.uuid)}
                  title="Open source note"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-bold text-text">
                      {group.note.title?.trim() || 'Untitled'}
                    </span>
                    <span className="text-[0.625rem] uppercase tracking-wide text-passive-1">
                      {SOURCE_LABEL[group.source]}
                    </span>
                  </div>
                  <ProgressBar completed={group.completed} total={group.total} />
                </button>
                <ul className="px-4 py-2">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 py-1">
                      <Icon
                        type={item.checked ? 'check-circle-filled' : 'check-circle'}
                        size="small"
                        className={classNames('mt-0.5 flex-shrink-0', item.checked ? 'text-success' : 'text-neutral')}
                      />
                      <span
                        className={classNames(
                          'text-sm',
                          item.checked ? 'text-passive-1 line-through' : 'text-text',
                        )}
                      >
                        {item.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  )
})

TodoView.displayName = 'TodoView'

export default observer(TodoView)
