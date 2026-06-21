import { forwardRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { openOrFocusAssistantWindow } from '@/Assistant/assistantWindow'
import {
  ChatTab,
  DEFAULT_TAB_TITLE,
  deriveTitleFromMessage,
  persistTabs,
  readPersistedTabs,
} from '@/Assistant/chatTabs'
import ConversationPanel from './ConversationPanel'
import DeepResearchPanel from './DeepResearchPanel'
import ResearchModePanel from './ResearchModePanel'
import { isDeepResearchEnabled } from '@/Assistant/deepResearchSettings'
import { isResearchModeEnabled } from '@/Assistant/researchModeSettings'

type Props = {
  application: WebApplication
  className?: string
  id: string
  /** When true the view is rendered as a standalone popped-out window. */
  standalone?: boolean
  /** Extra overlay content (e.g. the panel resize handle) rendered inside the root. */
  children?: ReactNode
}

const newId = () => Math.random().toString(36).slice(2)

const createTab = (): ChatTab => ({ id: newId(), title: DEFAULT_TAB_TITLE, userRenamed: false })

/** Anchor + tab the tab context menu is open against. */
type MenuState = { tabId: string; x: number; y: number }

const AssistantView = forwardRef<HTMLDivElement, Props>(
  ({ application, className, id, standalone, children }, ref) => {
    const { dismissLastPane } = useResponsiveAppPane()

    const [tabs, setTabs] = useState<ChatTab[]>(() => readPersistedTabs() ?? [createTab()])
    const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id)
    const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null)
    // Tab whose label is currently an inline-editable input, if any.
    const [editingTabId, setEditingTabId] = useState<string | null>(null)
    // Open context menu (right-click or caret), if any.
    const [menu, setMenu] = useState<MenuState | null>(null)
    // Whether the Deep research panel is overlaying the chat. The entry point is
    // only shown when the (default-off) deep-research feature is enabled.
    const [showDeepResearch, setShowDeepResearch] = useState(false)
    const deepResearchEnabled = isDeepResearchEnabled()
    // Research mode (web-knowledge structured note) overlay. Same default-off gating.
    const [showResearchMode, setShowResearchMode] = useState(false)
    const researchModeEnabled = isResearchModeEnabled()
    const editInputRef = useRef<HTMLInputElement | null>(null)

    // Persist the tab strip (id + title + userRenamed) so it survives a reload.
    useEffect(() => {
      persistTabs(tabs)
    }, [tabs])

    // Focus + select the inline rename input when editing starts.
    useEffect(() => {
      if (editingTabId) {
        const input = editInputRef.current
        input?.focus()
        input?.select()
      }
    }, [editingTabId])

    const handlePopOut = useCallback(() => {
      openOrFocusAssistantWindow()
    }, [])

    const addTab = useCallback(() => {
      const tab = createTab()
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    }, [])

    const closeTab = useCallback((tabId: string) => {
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
    }, [])

    // Auto-name from the first user message, but never clobber a user-chosen title.
    const autoNameTab = useCallback((tabId: string, text: string) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId && !tab.userRenamed ? { ...tab, title: deriveTitleFromMessage(text) } : tab,
        ),
      )
    }, [])

    // Commit a manual rename: mark the tab userRenamed so auto-naming won't override.
    const renameTab = useCallback((tabId: string, rawTitle: string) => {
      const title = rawTitle.trim()
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId ? { ...tab, title: title || DEFAULT_TAB_TITLE, userRenamed: true } : tab,
        ),
      )
    }, [])

    const startEditing = useCallback((tabId: string) => {
      setMenu(null)
      setActiveTabId(tabId)
      setEditingTabId(tabId)
    }, [])

    const openMenu = useCallback((event: { clientX: number; clientY: number }, tabId: string) => {
      setActiveTabId(tabId)
      setMenu({ tabId, x: event.clientX, y: event.clientY })
    }, [])

    // Close the menu on any outside click / Escape.
    useEffect(() => {
      if (!menu) {
        return
      }
      const close = () => setMenu(null)
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setMenu(null)
        }
      }
      window.addEventListener('click', close)
      window.addEventListener('keydown', onKey)
      return () => {
        window.removeEventListener('click', close)
        window.removeEventListener('keydown', onKey)
      }
    }, [menu])

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
            {deepResearchEnabled && (
              <button
                className={classNames(
                  'rounded p-1 hover:bg-contrast',
                  showDeepResearch && 'bg-info-faded text-info',
                )}
                onClick={() => {
                  setShowResearchMode(false)
                  setShowDeepResearch((value) => !value)
                }}
                aria-label="Deep research"
                aria-pressed={showDeepResearch}
                title="Deep research over your notes"
              >
                <Icon type="search" />
              </button>
            )}
            {researchModeEnabled && (
              <button
                className={classNames(
                  'rounded p-1 hover:bg-contrast',
                  showResearchMode && 'bg-info-faded text-info',
                )}
                onClick={() => {
                  setShowDeepResearch(false)
                  setShowResearchMode((value) => !value)
                }}
                aria-label="Research mode"
                aria-pressed={showResearchMode}
                title="Research mode (write a structured note on a topic)"
              >
                <Icon type="notes" />
              </button>
            )}
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
            const isEditing = tab.id === editingTabId
            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                onClick={() => setActiveTabId(tab.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  openMenu(event, tab.id)
                }}
                onKeyDown={(event) => {
                  if (isEditing) {
                    return
                  }
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveTabId(tab.id)
                  } else if (event.key === 'F2') {
                    // F2 is the conventional rename key; reachable without a mouse.
                    event.preventDefault()
                    startEditing(tab.id)
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
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    className="w-[10rem] rounded border border-info bg-default px-1 text-xs text-text focus:outline-none"
                    defaultValue={tab.title}
                    aria-label="Rename chat"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        renameTab(tab.id, (event.target as HTMLInputElement).value)
                        setEditingTabId(null)
                      } else if (event.key === 'Escape') {
                        setEditingTabId(null)
                      }
                    }}
                    onBlur={(event) => {
                      renameTab(tab.id, event.target.value)
                      setEditingTabId(null)
                    }}
                  />
                ) : (
                  <span className="max-w-[10rem] truncate">{tab.title}</span>
                )}
                {/* Caret affordance: keyboard- and touch-reachable way to open the
                    same menu as right-click (right-click is unavailable on touch). */}
                {!isEditing && (
                  <button
                    className="rounded p-0.5 text-passive-1 hover:bg-contrast hover:text-text"
                    onClick={(event) => {
                      event.stopPropagation()
                      openMenu(event, tab.id)
                    }}
                    aria-label="Chat options"
                    aria-haspopup="menu"
                    title="Chat options"
                  >
                    <Icon type="chevron-down" size="small" />
                  </button>
                )}
                {!isEditing && tabs.length > 1 && (
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

        {menu && (
          <div
            role="menu"
            className="fixed z-[10000] min-w-[10rem] rounded border border-border bg-default py-1 text-sm shadow-md"
            style={{ top: menu.y, left: menu.x }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-contrast"
              onClick={() => startEditing(menu.tabId)}
            >
              <Icon type="pencil-filled" size="small" />
              Rename
            </button>
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-contrast"
              onClick={() => {
                setMenu(null)
                addTab()
              }}
            >
              <Icon type="add" size="small" />
              New chat
            </button>
            {tabs.length > 1 && (
              <button
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-contrast"
                onClick={() => {
                  const tabId = menu.tabId
                  setMenu(null)
                  closeTab(tabId)
                }}
              >
                <Icon type="close" size="small" />
                Close
              </button>
            )}
          </div>
        )}

        {deepResearchEnabled && showDeepResearch ? (
          <DeepResearchPanel application={application} onClose={() => setShowDeepResearch(false)} />
        ) : researchModeEnabled && showResearchMode ? (
          <ResearchModePanel application={application} onClose={() => setShowResearchMode(false)} />
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div key={tab.id} className={isActive ? 'contents' : 'hidden'}>
                <ConversationPanel
                  application={application}
                  onFirstUserMessage={(text) => autoNameTab(tab.id, text)}
                  onUsageChange={isActive ? setUsage : undefined}
                />
              </div>
            )
          })
        )}
        {children}
      </div>
    )
  },
)

AssistantView.displayName = 'AssistantView'

export default observer(AssistantView)
