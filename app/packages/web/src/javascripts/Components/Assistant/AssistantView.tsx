import { forwardRef, ReactNode, useCallback, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { openOrFocusAssistantWindow } from '@/Assistant/assistantWindow'
import ConversationPanel from './ConversationPanel'

type Props = {
  application: WebApplication
  className?: string
  id: string
  /** When true the view is rendered as a standalone popped-out window. */
  standalone?: boolean
  /** Extra overlay content (e.g. the panel resize handle) rendered inside the root. */
  children?: ReactNode
}

type Tab = { id: string; title: string }

const newId = () => Math.random().toString(36).slice(2)

const titleFromMessage = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return 'New chat'
  }
  return trimmed.length > 22 ? `${trimmed.slice(0, 22)}…` : trimmed
}

const AssistantView = forwardRef<HTMLDivElement, Props>(
  ({ application, className, id, standalone, children }, ref) => {
    const { dismissLastPane } = useResponsiveAppPane()

    const [tabs, setTabs] = useState<Tab[]>(() => [{ id: newId(), title: 'New chat' }])
    const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id)
    const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null)

    const handlePopOut = useCallback(() => {
      openOrFocusAssistantWindow()
    }, [])

    const addTab = useCallback(() => {
      const tab = { id: newId(), title: 'New chat' }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    }, [])

    const closeTab = useCallback(
      (tabId: string) => {
        setTabs((prev) => {
          if (prev.length <= 1) {
            return prev
          }
          const index = prev.findIndex((tab) => tab.id === tabId)
          if (index === -1) {
            return prev
          }
          const next = prev.filter((tab) => tab.id !== tabId)
          setActiveTabId((current) => {
            if (current !== tabId) {
              return current
            }
            const fallback = next[index] ?? next[index - 1] ?? next[0]
            return fallback.id
          })
          return next
        })
      },
      [],
    )

    const setTabTitle = useCallback((tabId: string, title: string) => {
      setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)))
    }, [])

    return (
      <div
        id={id}
        ref={ref}
        className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
      >
        <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon type="dashboard" className="text-info" />
            <span className="text-base font-bold">Assistant</span>
            {usage && (
              <span className="text-xs text-passive-0" title="AI requests used today">
                AI usage: {usage.used} / {usage.limit > 0 ? usage.limit : '∞'} today
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!standalone && (
              <button
                className="rounded p-1 hover:bg-contrast"
                onClick={handlePopOut}
                aria-label="Pop out assistant"
                title="Pop out to a new window"
              >
                <Icon type="open-in" />
              </button>
            )}
            {!standalone && (
              <button
                className="rounded p-1 hover:bg-contrast"
                onClick={() => dismissLastPane()}
                aria-label="Close assistant"
                title="Close assistant"
              >
                <Icon type="close" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-contrast px-2 py-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveTabId(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveTabId(tab.id)
                  }
                }}
                className={classNames(
                  'flex flex-shrink-0 cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs',
                  isActive
                    ? 'border-info bg-default font-semibold text-text'
                    : 'border-border bg-contrast text-passive-0 hover:text-text',
                )}
                title={tab.title}
              >
                <span className="max-w-[10rem] truncate">{tab.title}</span>
                {tabs.length > 1 && (
                  <button
                    className="rounded p-0.5 hover:bg-contrast"
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(tab.id)
                    }}
                    aria-label="Close chat"
                    title="Close chat"
                  >
                    <Icon type="close" size="small" />
                  </button>
                )}
              </div>
            )
          })}
          <button
            className="flex flex-shrink-0 items-center rounded border border-border bg-contrast p-1 text-passive-0 hover:text-text"
            onClick={addTab}
            aria-label="New chat"
            title="New chat"
          >
            <Icon type="add" size="small" />
          </button>
        </div>

        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div key={tab.id} className={isActive ? 'contents' : 'hidden'}>
              <ConversationPanel
                application={application}
                onFirstUserMessage={(text) => setTabTitle(tab.id, titleFromMessage(text))}
                onUsageChange={isActive ? setUsage : undefined}
              />
            </div>
          )
        })}
        {children}
      </div>
    )
  },
)

AssistantView.displayName = 'AssistantView'

export default observer(AssistantView)
