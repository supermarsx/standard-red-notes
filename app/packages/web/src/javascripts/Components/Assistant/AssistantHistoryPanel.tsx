import { assistantTabsByActivity, ChatTab, DEFAULT_TAB_TITLE } from '@/Assistant/chatTabs'
import Icon from '@/Components/Icon/Icon'
import { useMemo, useRef, useState } from 'react'

export const assistantWorkTabIcon = (tab: ChatTab) => {
  return tab.kind === 'research' ? 'notes' : tab.kind === 'deep-research' ? 'search' : 'comment'
}

type Props = {
  tabs: ChatTab[]
  closedTabIds: string[]
  onResume: (id: string) => void
}

/** Titles come only from the active encrypted workspace; transcripts are never loaded for previews. */
export function AssistantHistoryPanel({
  tabs,
  closedTabIds,
  onResume,
  onRename,
  onDelete,
}: Props & { onRename: (id: string, title: string) => void; onDelete: (ids: string[]) => Promise<boolean> }) {
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<{ id: string; title: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const ordered = useMemo(() => assistantTabsByActivity(tabs), [tabs])
  const tabIds = useMemo(() => new Set(tabs.map((tab) => tab.id)), [tabs])
  const selectedIds = selected.filter((id) => tabIds.has(id))
  const selectedSet = new Set(selectedIds)
  const control = 'border-border hover:bg-contrast rounded border px-2 py-1 text-xs disabled:opacity-50'
  const remove = async (ids: string[]) => {
    if (busyRef.current || !ids.length) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (await onDelete(ids)) {
        setSelected((previous) => previous.filter((id) => !ids.includes(id)))
      }
    } catch {
      setError('Chat deletion could not be completed. Your remaining history was kept; try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <section aria-label="Assistant history" className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <h2 className="text-base font-semibold">History</h2>
      <p className="text-passive-0 mt-1 text-xs">
        Open a conversation in this workspace. Research reports stay in their chat history. In-flight work continues
        while this app stays open; reloading does not restart a model request.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={control}
          disabled={busy || !tabs.length}
          onClick={() => {
            setSelected(selectedIds.length === tabs.length ? [] : tabs.map((tab) => tab.id))
          }}
        >
          {selectedIds.length === tabs.length && tabs.length > 0 ? 'Deselect all' : 'Select all'}
        </button>
        <span className="text-passive-0 text-xs" role="status">
          {selectedIds.length} selected
        </span>
        <button
          type="button"
          className={control}
          disabled={busy || !selectedIds.length}
          onClick={() => void remove(selectedIds)}
        >
          <Icon type="trash" size="small" className="mr-1 inline-block" />
          {busy ? 'Deleting…' : 'Delete selected'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-danger mt-2 text-xs">
          {error}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {ordered.map((tab) => (
          <li key={tab.id} className="border-border flex items-center gap-2 rounded border px-2 py-1">
            <input
              type="checkbox"
              aria-label={`Select ${tab.title}`}
              checked={selectedSet.has(tab.id)}
              disabled={busy}
              onChange={(event) =>
                setSelected((previous) => {
                  return event.target.checked ? [...previous, tab.id] : previous.filter((id) => id !== tab.id)
                })
              }
            />
            {editing?.id === tab.id ? (
              <form
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  onRename(tab.id, editing.title)
                  setEditing(undefined)
                }}
              >
                <input
                  autoFocus
                  aria-label="Chat title"
                  className="bg-default text-text border-border min-w-0 flex-1 rounded border px-2 py-1 text-sm"
                  value={editing.title}
                  maxLength={40}
                  disabled={busy}
                  onChange={(event) => setEditing({ id: tab.id, title: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditing(undefined)
                    }
                  }}
                />
                <button type="submit" className={control} disabled={busy}>
                  Save
                </button>
                <button type="button" className={control} disabled={busy} onClick={() => setEditing(undefined)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={`Resume ${tab.title}`}
                  onClick={() => onResume(tab.id)}
                  disabled={busy}
                  className="hover:bg-contrast focus-visible:ring-info flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-2 text-left focus-visible:ring-2"
                >
                  <Icon type={assistantWorkTabIcon(tab)} size="small" className="text-info shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">{tab.title}</span>
                  <span className="text-passive-1 shrink-0 text-xs">
                    {closedTabIds.includes(tab.id) ? 'Hidden' : 'Open'}
                  </span>
                </button>
                <button
                  type="button"
                  className={control}
                  disabled={busy}
                  aria-label={`Rename ${tab.title}`}
                  title="Rename chat"
                  onClick={() => setEditing({ id: tab.id, title: tab.title })}
                >
                  <Icon type="pencil-filled" size="small" />
                </button>
                <button
                  type="button"
                  className={control}
                  disabled={busy}
                  aria-label={`Delete ${tab.title}`}
                  title="Delete chat"
                  onClick={() => void remove([tab.id])}
                >
                  <Icon type="trash" size="small" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {tabs.length === 0 && <p className="text-passive-0 mt-3 text-sm">No conversations yet.</p>}
    </section>
  )
}

export function AssistantRecentChats({
  tabs,
  currentTabId,
  onResume,
}: Omit<Props, 'closedTabIds'> & { currentTabId: string }) {
  const recent = assistantTabsByActivity(tabs)
    .filter((tab) => tab.id !== currentTabId && (tab.title !== DEFAULT_TAB_TITLE || tab.userRenamed))
    .slice(0, 5)
  if (!recent.length) {
    return null
  }
  return (
    <section aria-label="Recent chats" className="border-border mb-4 border-b pb-3">
      <h3 className="text-passive-0 mb-2 text-xs font-semibold">Recent chats</h3>
      <ul className="space-y-1">
        {recent.map((tab) => (
          <li key={tab.id}>
            <button
              type="button"
              onClick={() => onResume(tab.id)}
              className="hover:bg-contrast focus-visible:ring-info flex w-full items-center gap-2 rounded px-2 py-1.5 text-left focus-visible:ring-2"
            >
              <Icon type="comment" size="small" className="text-passive-1 shrink-0" />
              <span className="truncate text-sm">{tab.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
