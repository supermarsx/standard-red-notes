import { ASSISTANT_CHAT_TRASH_RETENTION_DAYS, type AssistantSyncedChats } from '@/Assistant/assistantSyncedChats'
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
  trashedTabs,
  storageStats,
  onRestore,
  onPurge,
  onEmptyTrash,
}: Props & {
  onRename: (id: string, title: string) => void
  onDelete: (ids: string[]) => Promise<boolean>
  trashedTabs?: ChatTab[]
  storageStats?: Awaited<ReturnType<AssistantSyncedChats['getStorageStats']>>
  onRestore?: (ids: string[]) => Promise<boolean>
  onPurge?: (ids: string[]) => Promise<boolean>
  onEmptyTrash?: () => Promise<boolean>
}) {
  const [showTrash, setShowTrash] = useState(false)
  const visibleTabs = useMemo(() => (showTrash ? (trashedTabs ?? []) : tabs), [showTrash, trashedTabs, tabs])
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<{ id: string; title: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const ordered = useMemo(() => assistantTabsByActivity(visibleTabs), [visibleTabs])
  const tabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs])
  const selectedIds = selected.filter((id) => tabIds.has(id))
  const selectedSet = new Set(selectedIds)
  const control = 'border-border hover:bg-contrast rounded border px-2 py-1 text-xs disabled:opacity-50'
  const perform = async (ids: string[], action: (ids: string[]) => Promise<boolean>) => {
    if (busyRef.current || !ids.length) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (await action(ids)) {
        setSelected((previous) => previous.filter((id) => !ids.includes(id)))
      }
    } catch {
      setError('The history action could not be completed. Retry after checking storage and your connection.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const remove = (ids: string[]) => perform(ids, showTrash ? onPurge! : onDelete)
  return (
    <section aria-label="Assistant history" className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <h2 className="text-base font-semibold">History</h2>
      {trashedTabs && (
        <div className="mt-2 flex items-center gap-2" role="group" aria-label="History view">
          <button
            type="button"
            className={control}
            disabled={busy}
            aria-pressed={!showTrash}
            onClick={() => {
              setShowTrash(false)
              setSelected([])
              setEditing(undefined)
            }}
          >
            Chats
          </button>
          <button
            type="button"
            className={control}
            disabled={busy}
            aria-pressed={showTrash}
            onClick={() => {
              setShowTrash(true)
              setSelected([])
              setEditing(undefined)
            }}
          >
            Trash ({trashedTabs.length})
          </button>
        </div>
      )}
      {storageStats && (
        <details className="text-passive-0 mt-2 text-xs">
          <summary className="cursor-pointer">
            Storage · {storageStats.activeChats} chats · {storageStats.trashedChats} trashed ·{' '}
            {Math.round((storageStats.budgetedSerializedUnits / storageStats.limits.serializedUnits) * 100)}% of chat
            budget
          </summary>
          <p>
            {storageStats.activeChats} / {storageStats.limits.chats} active chat slots;{' '}
            {storageStats.budgetedWriterRecords} active transcript records; writer record cap{' '}
            {storageStats.limits.records}; up to {storageStats.limits.writersPerChat} writers per chat; single-record
            limit {storageStats.limits.recordUnits.toLocaleString()} serialized units.
          </p>
          <p>
            {storageStats.budgetedSerializedUnits.toLocaleString()} /{' '}
            {storageStats.limits.serializedUnits.toLocaleString()} active serialized units;{' '}
            {storageStats.serializedUnits.toLocaleString()} total retained units;{' '}
            {storageStats.trashedSerializedUnits.toLocaleString()} trashed units;{' '}
            {storageStats.deletedSerializedUnits.toLocaleString()} deleted units; {storageStats.writerRecords}{' '}
            transcript records; {storageStats.lifecycleRecords} lifecycle markers; {storageStats.deletedChats} deleted
            chat markers; {storageStats.deletedResidualRecords} retained deleted records; {storageStats.invalidRecords}{' '}
            unreadable records.
          </p>
          <p>
            Hidden chats still use storage. Trashed chats can be restored for {ASSISTANT_CHAT_TRASH_RETENTION_DAYS}{' '}
            days, then are permanently deleted. Small deletion markers remain to prevent stale devices restoring deleted
            chats. Trash and deleted records do not count toward active chat limits. Restoring a chat requires room in
            the active budget. Expired trash is cleaned when the Assistant opens and periodically while it is running.
            Serialized units count JSON UTF-16 code units before encryption, not device disk space.
          </p>
        </details>
      )}
      {showTrash && onEmptyTrash && (
        <button
          type="button"
          className={`${control} mt-2 self-start`}
          disabled={busy || (!trashedTabs?.length && !storageStats?.deletedResidualRecords)}
          onClick={() => void perform(['empty-trash'], () => onEmptyTrash())}
        >
          Empty trash and clean deleted history
        </button>
      )}
      <p className="text-passive-0 mt-1 text-xs">
        Open a conversation in this workspace. Research reports stay in their chat history. In-flight work continues
        while this app stays open; reloading does not restart a model request.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={control}
          disabled={busy || !visibleTabs.length}
          onClick={() => {
            setSelected(selectedIds.length === visibleTabs.length ? [] : visibleTabs.map((tab) => tab.id))
          }}
        >
          {selectedIds.length === visibleTabs.length && visibleTabs.length > 0 ? 'Deselect all' : 'Select all'}
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
          {busy
            ? 'Working…'
            : showTrash
              ? 'Permanently delete selected'
              : trashedTabs
                ? 'Move selected to trash'
                : 'Delete selected'}
        </button>
        {showTrash && onRestore && (
          <button
            type="button"
            className={control}
            disabled={busy || !selectedIds.length}
            onClick={() => void perform(selectedIds, onRestore)}
          >
            Restore selected
          </button>
        )}
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
                  aria-label={`${showTrash ? 'Restore' : 'Resume'} ${tab.title}`}
                  onClick={() => (showTrash && onRestore ? void perform([tab.id], onRestore) : onResume(tab.id))}
                  disabled={busy}
                  className="hover:bg-contrast focus-visible:ring-info flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-2 text-left focus-visible:ring-2"
                >
                  <Icon type={assistantWorkTabIcon(tab)} size="small" className="text-info shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">{tab.title}</span>
                  <span className="text-passive-1 shrink-0 text-xs">
                    {showTrash ? 'Restore' : closedTabIds.includes(tab.id) ? 'Hidden' : 'Open'}
                  </span>
                </button>
                {!showTrash && (
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
                )}
                <button
                  type="button"
                  className={control}
                  disabled={busy}
                  aria-label={`${showTrash ? 'Permanently delete' : trashedTabs ? 'Move to trash:' : 'Delete'} ${tab.title}`}
                  title={showTrash ? 'Permanently delete chat' : trashedTabs ? 'Move chat to trash' : 'Delete chat'}
                  onClick={() => void remove([tab.id])}
                >
                  <Icon type="trash" size="small" />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {visibleTabs.length === 0 && (
        <p className="text-passive-0 mt-3 text-sm">{showTrash ? 'Trash is empty.' : 'No conversations yet.'}</p>
      )}
    </section>
  )
}

export function AssistantRecentChats({
  tabs,
  currentTabId,
  onResume,
  onMenu,
}: Omit<Props, 'closedTabIds'> & {
  currentTabId: string
  onMenu: (position: { clientX: number; clientY: number }, id: string) => void
}) {
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
          <li
            key={tab.id}
            className="flex items-center"
            onContextMenu={(event) => {
              event.preventDefault()
              onMenu(event, tab.id)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault()
                const bounds = event.currentTarget.getBoundingClientRect()
                onMenu({ clientX: bounds.left, clientY: bounds.bottom }, tab.id)
              }
            }}
          >
            <button
              type="button"
              onClick={() => onResume(tab.id)}
              className="hover:bg-contrast focus-visible:ring-info flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left focus-visible:ring-2"
            >
              <Icon type="comment" size="small" className="text-passive-1 shrink-0" />
              <span className="truncate text-sm">{tab.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Actions for ${tab.title}`}
              aria-haspopup="menu"
              className="hover:bg-contrast focus-visible:ring-info shrink-0 rounded p-1.5 focus-visible:ring-2"
              onClick={(event) => {
                event.stopPropagation()
                const bounds = event.currentTarget.getBoundingClientRect()
                onMenu({ clientX: bounds.left, clientY: bounds.bottom }, tab.id)
              }}
            >
              <Icon type="more" size="small" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
