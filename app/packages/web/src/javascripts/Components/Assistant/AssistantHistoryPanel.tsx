import { assistantTabsByActivity, ChatTab, DEFAULT_TAB_TITLE } from '@/Assistant/chatTabs'
import Icon from '@/Components/Icon/Icon'

export const assistantWorkTabIcon = (tab: ChatTab) => {
  return tab.kind === 'research' ? 'notes' : tab.kind === 'deep-research' ? 'search' : 'comment'
}

type Props = {
  tabs: ChatTab[]
  closedTabIds: string[]
  onResume: (id: string) => void
}

/** Titles come only from the active encrypted workspace; transcripts are never loaded for previews. */
export function AssistantHistoryPanel({ tabs, closedTabIds, onResume }: Props) {
  return (
    <section aria-label="Assistant history" className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <h2 className="text-base font-semibold">History</h2>
      <p className="text-passive-0 mt-1 text-xs">
        Open a conversation in this workspace. Research reports stay in their chat history. In-flight work continues
        while this app stays open; reloading does not restart a model request.
      </p>
      <ul className="mt-3 space-y-2">
        {assistantTabsByActivity(tabs).map((tab) => (
          <li key={tab.id}>
            <button
              type="button"
              aria-label={`Resume ${tab.title}`}
              onClick={() => onResume(tab.id)}
              className="border-border hover:bg-contrast focus-visible:ring-info flex w-full items-center gap-2 rounded border px-3 py-2 text-left focus-visible:ring-2"
            >
              <Icon type={assistantWorkTabIcon(tab)} size="small" className="text-info shrink-0" />
              <span className="min-w-0 flex-1 truncate text-sm">{tab.title}</span>
              <span className="text-passive-1 shrink-0 text-xs">
                {closedTabIds.includes(tab.id) ? 'Hidden' : 'Open'}
              </span>
            </button>
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
    .filter(
      (tab) =>
        tab.id !== currentTabId &&
        (tab.title !== DEFAULT_TAB_TITLE || tab.userRenamed),
    )
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
