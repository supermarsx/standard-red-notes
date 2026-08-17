import { forwardRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { openOrFocusAssistantWindow } from '@/Assistant/assistantWindow'
import {
  ChatTab,
  DEFAULT_TAB_TITLE,
  MAX_CHAT_TABS,
  assistantChatWorkspaceScope,
  deletePersistedTabsStrict,
  deriveTitleFromMessage,
  getAssistantBrowsingContextId,
  normalizeChatTabTitle,
  persistTabsStrict,
  readPersistedTabsResult,
} from '@/Assistant/chatTabs'
import ConversationPanel from './ConversationPanel'
import DeepResearchPanel from './DeepResearchPanel'
import ResearchModePanel from './ResearchModePanel'
import {
  clearAssistantChatHistoryDeletionTombstone,
  deleteAssistantChatHistory,
  deleteAssistantChatHistoryStrict,
} from '@/Assistant/assistantChatHistory'
import {
  AssistantChatDirective,
  clearAssistantDirectives,
  subscribeAssistantDirectives,
} from '@/Assistant/assistantDirectives'
import {
  AssistantWorkspaceClaim,
  assistantWorkspaceRetention,
  waitForAssistantWorkspaceReleases,
} from '@/Assistant/assistantWorkspaceRetention'

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
type RoutedDirective = { directive: AssistantChatDirective; targetTabId: string }

const AssistantView = forwardRef<HTMLDivElement, Props>(({ application, className, id, standalone, children }, ref) => {
  const { dismissLastPane } = useResponsiveAppPane()
  const accountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
  const browsingContextId = useRef(getAssistantBrowsingContextId()).current
  const chatAccountScope = assistantChatWorkspaceScope(accountScope, standalone === true, browsingContextId)

  const initialTab = useRef(createTab()).current
  const [tabs, setTabs] = useState<ChatTab[]>([initialTab])
  const [activeTabId, setActiveTabId] = useState<string>(initialTab.id)
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  // Closing is a reversible hide. Keeping the panel mounted lets an in-flight
  // run continue; Delete is the only operation that erases the transcript.
  const [closedTabIds, setClosedTabIds] = useState<string[]>([])
  // Never render or persist one account's chat metadata under another account
  // while React catches up with a sign-in/account switch.
  const [loadedChatAccountScope, setLoadedChatAccountScope] = useState('')
  const [workspacePersistence, setWorkspacePersistence] = useState<'pending' | 'durable' | 'transient'>('pending')
  const [workspacePersistenceNotice, setWorkspacePersistenceNotice] = useState('')
  const [manifestTabIds, setManifestTabIds] = useState<string[]>([])
  const [retainedCleanupTabIds, setRetainedCleanupTabIds] = useState<string[]>([])
  // Tab whose label is currently an inline-editable input, if any.
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  // Open context menu (right-click or caret), if any.
  const [menu, setMenu] = useState<MenuState | null>(null)
  // Research panels may cover the chat, but never unmount it: a running assistant
  // session remains alive while the user switches modes.
  const [showDeepResearch, setShowDeepResearch] = useState(false)
  const [showResearchMode, setShowResearchMode] = useState(false)
  const [pendingDirectives, setPendingDirectives] = useState<RoutedDirective[]>([])
  const [workspaceLocked, setWorkspaceLocked] = useState(false)
  const workspaceLockedRef = useRef(false)
  const [keyEpoch, setKeyEpoch] = useState(0)
  const [, refreshSessionScope] = useState(0)
  const editInputRef = useRef<HTMLInputElement | null>(null)
  const sessionTransitionRef = useRef(0)
  const workspaceActivationRef = useRef(0)
  const workspaceActivationChainRef = useRef(Promise.resolve())
  const observedAccountScopeRef = useRef(accountScope)
  const workspaceClaimRef = useRef<AssistantWorkspaceClaim | null>(null)
  const pendingWorkspaceReleasesRef = useRef(new Set<Promise<void>>())
  const workspaceManifestChainRef = useRef(Promise.resolve(true))
  const [workspaceRevision, setWorkspaceRevision] = useState(0)

  const releaseWorkspaceClaim = useCallback((claim: AssistantWorkspaceClaim): Promise<void> => {
    const release = claim.release().catch(() => undefined)
    pendingWorkspaceReleasesRef.current.add(release)
    void release.finally(() => pendingWorkspaceReleasesRef.current.delete(release))
    return release
  }, [])

  // Session methods are not React state. Force an immediate scope recomputation
  // on account transitions so account-keyed background panels are torn down and
  // their abort signals fire even when no surrounding view happens to rerender.
  useEffect(() => {
    let mounted = true
    const dispose = application.addEventObserver(async (event) => {
      if (
        mounted &&
        (event === ApplicationEvent.SignedIn ||
          event === ApplicationEvent.SignedOut ||
          event === ApplicationEvent.KeyStatusChanged)
      ) {
        const nextAccountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
        const accountChanged = nextAccountScope !== observedAccountScopeRef.current
        observedAccountScopeRef.current = nextAccountScope
        if (event !== ApplicationEvent.KeyStatusChanged && !accountChanged) {
          refreshSessionScope((revision) => revision + 1)
          return
        }
        // Sign-in, sign-out, and key changes are all hard privacy boundaries.
        // Purge every decrypted React value synchronously, then restore only the
        // latest principal's encrypted workspace after lock state is proven.
        const transition = ++sessionTransitionRef.current
        workspaceActivationRef.current += 1
        const previousClaim = workspaceClaimRef.current
        workspaceClaimRef.current = null
        if (previousClaim) {
          void releaseWorkspaceClaim(previousClaim)
        }
        workspaceLockedRef.current = true
        clearAssistantDirectives()
        setPendingDirectives([])
        setWorkspaceLocked(true)
        setWorkspacePersistence('pending')
        setWorkspacePersistenceNotice('')
        setManifestTabIds([])
        setRetainedCleanupTabIds([])
        setLoadedChatAccountScope('')
        const blank = createTab()
        setTabs([blank])
        setActiveTabId(blank.id)
        setClosedTabIds([])
        setEditingTabId(null)
        setMenu(null)
        setShowDeepResearch(false)
        setShowResearchMode(false)
        setKeyEpoch((epoch) => epoch + 1)
        refreshSessionScope((revision) => revision + 1)

        let locked = true
        try {
          locked = await application.protections.isLocked()
        } catch {
          // If lock state cannot be proven, keep decrypted assistant state hidden.
        }
        if (!mounted || locked || transition !== sessionTransitionRef.current) {
          return
        }

        setWorkspaceLocked(false)
        setWorkspaceRevision((revision) => revision + 1)
      }
    })
    return () => {
      mounted = false
      dispose()
    }
  }, [application, browsingContextId, releaseWorkspaceClaim, standalone])

  useEffect(() => {
    let cancelled = false
    let ownedClaim: AssistantWorkspaceClaim | undefined
    const transition = ++workspaceActivationRef.current
    workspaceLockedRef.current = true
    setWorkspacePersistence('pending')
    setWorkspacePersistenceNotice('')
    setManifestTabIds([])
    setRetainedCleanupTabIds([])
    setLoadedChatAccountScope('')

    const activate = async () => {
      let locked = true
      try {
        locked = await application.protections.isLocked()
      } catch {
        // A storage read is not safe until the protection state is known.
      }
      if (cancelled || transition !== workspaceActivationRef.current) {
        return
      }
      if (locked) {
        setWorkspaceLocked(true)
        return
      }

      const priorReleasesSettled = await waitForAssistantWorkspaceReleases(pendingWorkspaceReleasesRef.current)
      if (cancelled || transition !== workspaceActivationRef.current) {
        return
      }

      ownedClaim = await assistantWorkspaceRetention.claimWorkspace(
        accountScope,
        chatAccountScope,
        undefined,
        async (entry) => {
          await deletePersistedTabsStrict(application.storage, entry.workspaceScope)
          for (const tabId of entry.tabIds) {
            await deleteAssistantChatHistoryStrict(application.storage, entry.workspaceScope, tabId)
          }
        },
      )
      if (cancelled || transition !== workspaceActivationRef.current) {
        await releaseWorkspaceClaim(ownedClaim)
        return
      }

      const tabsRead = ownedClaim.durable
        ? readPersistedTabsResult(application.storage, chatAccountScope)
        : ({ status: 'missing' } as const)
      let restored = tabsRead.status === 'found' ? tabsRead.tabs : [createTab()]
      let durable = ownedClaim.durable
      let retainedCleanupIds: string[] = []
      let manifestIds = restored.map((tab) => tab.id)
      if (durable) {
        if (tabsRead.status === 'error') {
          await releaseWorkspaceClaim(ownedClaim)
          ownedClaim = undefined
          durable = false
          restored = [createTab()]
          manifestIds = []
        } else {
          const restoredIds = new Set(manifestIds)
          for (const trackedTabId of ownedClaim.trackedTabIds) {
            if (restoredIds.has(trackedTabId)) {
              continue
            }
            try {
              await deleteAssistantChatHistoryStrict(application.storage, chatAccountScope, trackedTabId)
            } catch {
              retainedCleanupIds.push(trackedTabId)
            }
          }
          manifestIds = [...new Set([...manifestIds, ...retainedCleanupIds])]
          const manifestReady = await ownedClaim.updateTabIds(manifestIds)
          let metadataReady = false
          if (manifestReady) {
            try {
              metadataReady = await ownedClaim.runPersistence(() =>
                persistTabsStrict(application.storage, chatAccountScope, restored),
              )
            } catch {
              metadataReady = false
            }
          }
          if (!manifestReady || !metadataReady) {
            await releaseWorkspaceClaim(ownedClaim)
            ownedClaim = undefined
            durable = false
            restored = [createTab()]
            manifestIds = []
            retainedCleanupIds = []
          }
        }
      }
      if (cancelled || transition !== workspaceActivationRef.current) {
        if (ownedClaim) {
          await releaseWorkspaceClaim(ownedClaim)
        }
        return
      }
      workspaceClaimRef.current = ownedClaim ?? null
      setTabs(restored)
      setActiveTabId(restored[0].id)
      setClosedTabIds([])
      setEditingTabId(null)
      setMenu(null)
      setPendingDirectives([])
      setLoadedChatAccountScope(chatAccountScope)
      setManifestTabIds(durable ? manifestIds : [])
      setRetainedCleanupTabIds(durable ? retainedCleanupIds : [])
      setWorkspacePersistence(durable ? 'durable' : 'transient')
      setWorkspacePersistenceNotice(
        durable
          ? ''
          : priorReleasesSettled
            ? 'Durable chat storage is unavailable or already owned by another live Assistant view. This workspace stays private to this tab.'
            : 'A previous encrypted Assistant workspace is still finishing a local save. This view stays private to this tab instead of waiting indefinitely.',
      )
      setWorkspaceLocked(false)
      workspaceLockedRef.current = false
      setKeyEpoch((epoch) => epoch + 1)
    }

    const activation = workspaceActivationChainRef.current.then(activate)
    workspaceActivationChainRef.current = activation.catch(() => undefined)
    return () => {
      cancelled = true
      if (workspaceClaimRef.current === ownedClaim) {
        workspaceClaimRef.current = null
      }
      if (ownedClaim) {
        void releaseWorkspaceClaim(ownedClaim)
      }
    }
  }, [accountScope, application, chatAccountScope, releaseWorkspaceClaim, workspaceRevision])

  useEffect(() => {
    if (workspaceLocked || workspacePersistence === 'pending' || loadedChatAccountScope !== chatAccountScope) {
      return
    }
    return subscribeAssistantDirectives(accountScope, (directive) => {
      if (workspaceLockedRef.current || directive.accountScope !== observedAccountScopeRef.current) {
        return
      }
      setShowDeepResearch(false)
      setShowResearchMode(false)
      setPendingDirectives((current) => {
        return current.some((item) => item.directive.id === directive.id)
          ? current
          : [...current, { directive, targetTabId: activeTabIdRef.current }]
      })
    })
  }, [accountScope, chatAccountScope, loadedChatAccountScope, workspaceLocked, workspacePersistence])

  // Persist the tab strip (id + title + userRenamed) so it survives a reload.
  useEffect(() => {
    const claim = workspaceClaimRef.current
    if (
      workspaceLocked ||
      workspacePersistence !== 'durable' ||
      !claim?.durable ||
      loadedChatAccountScope !== chatAccountScope
    ) {
      return
    }
    const tabIds = [...new Set([...tabs.map((tab) => tab.id), ...retainedCleanupTabIds])]
    const persistenceUpdate = workspaceManifestChainRef.current.then(async () => {
      const manifestReady = await claim.updateTabIds(tabIds)
      if (workspaceClaimRef.current !== claim || loadedChatAccountScope !== chatAccountScope) {
        return true
      }
      if (!manifestReady) {
        return false
      }
      try {
        const metadataReady = await claim.runPersistence(() =>
          persistTabsStrict(application.storage, chatAccountScope, tabs),
        )
        if (!metadataReady) {
          return false
        }
      } catch {
        return false
      }
      setManifestTabIds(tabIds)
      return true
    })
    workspaceManifestChainRef.current = persistenceUpdate.catch(() => false)
    void persistenceUpdate.then(async (persisted) => {
      if (persisted || workspaceClaimRef.current !== claim) {
        return
      }
      workspaceClaimRef.current = null
      setManifestTabIds([])
      setWorkspacePersistence('transient')
      setWorkspacePersistenceNotice(
        'Encrypted chat metadata could not be saved durably. This workspace stays private to this tab to protect the saved copy.',
      )
      await releaseWorkspaceClaim(claim)
    })
  }, [
    application,
    chatAccountScope,
    loadedChatAccountScope,
    releaseWorkspaceClaim,
    retainedCleanupTabIds,
    tabs,
    workspaceLocked,
    workspacePersistence,
  ])

  // Focus + select the inline rename input when editing starts.
  useEffect(() => {
    if (editingTabId) {
      const input = editInputRef.current
      input?.focus()
      input?.select()
    }
  }, [editingTabId])

  const handlePopOut = useCallback(() => {
    if (openOrFocusAssistantWindow()) {
      dismissLastPane()
    }
  }, [dismissLastPane])

  const addTab = useCallback(() => {
    if (tabs.length >= MAX_CHAT_TABS) {
      return
    }
    const tab = createTab()
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }, [tabs.length])

  const visibleTabs = tabs.filter((tab) => !closedTabIds.includes(tab.id))

  const closeTab = useCallback(
    (tabId: string) => {
      const visible = tabs.filter((tab) => !closedTabIds.includes(tab.id))
      if (visible.length <= 1 || !visible.some((tab) => tab.id === tabId)) {
        return
      }
      const index = visible.findIndex((tab) => tab.id === tabId)
      const remaining = visible.filter((tab) => tab.id !== tabId)
      setClosedTabIds((prev) => (prev.includes(tabId) ? prev : [...prev, tabId]))
      if (activeTabId === tabId) {
        setActiveTabId((remaining[index] ?? remaining[index - 1] ?? remaining[0]).id)
      }
    },
    [activeTabId, closedTabIds, tabs],
  )

  const restoreLastClosedTab = useCallback(() => {
    setClosedTabIds((prev) => {
      const tabId = prev.at(-1)
      if (!tabId) {
        return prev
      }
      setActiveTabId(tabId)
      return prev.slice(0, -1)
    })
  }, [])

  const deleteChat = useCallback(
    async (tabId: string) => {
      setMenu(null)
      const claim = workspaceClaimRef.current
      let retainForCleanup = false
      if (claim?.durable && workspacePersistence === 'durable') {
        let deletionDurable = false
        let retired = false
        try {
          retired = await claim.retirePersistence(tabId, async () => {
            deletionDurable = await deleteAssistantChatHistory(application.storage, loadedChatAccountScope, tabId)
            if (deletionDurable) {
              clearAssistantChatHistoryDeletionTombstone(loadedChatAccountScope, tabId)
            }
          })
        } catch {
          retired = false
        }
        retainForCleanup = !retired || !deletionDurable
      }
      if (retainForCleanup) {
        setRetainedCleanupTabIds((current) => (current.includes(tabId) ? current : [...current, tabId]))
      }
      setPendingDirectives((current) => current.filter((item) => item.targetTabId !== tabId))
      setClosedTabIds((prev) => prev.filter((id) => id !== tabId))
      setTabs((prev) => {
        const index = prev.findIndex((tab) => tab.id === tabId)
        if (index < 0) {
          return prev
        }
        const next = prev.filter((tab) => tab.id !== tabId)
        if (next.length === 0) {
          const replacement = createTab()
          setActiveTabId(replacement.id)
          return [replacement]
        }
        if (activeTabId === tabId) {
          const visibleNext = next.filter((tab) => !closedTabIds.includes(tab.id))
          setActiveTabId((visibleNext[index] ?? visibleNext[index - 1] ?? visibleNext[0] ?? next[0]).id)
        }
        return next
      })
    },
    [activeTabId, application, closedTabIds, loadedChatAccountScope, workspacePersistence],
  )

  // Auto-name from the first user message, but never clobber a user-chosen title.
  const autoNameTab = useCallback((tabId: string, text: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId && !tab.userRenamed ? { ...tab, title: deriveTitleFromMessage(text) } : tab)),
    )
  }, [])

  const consumeDirective = useCallback((directiveId: string) => {
    setPendingDirectives((current) => current.filter((item) => item.directive.id !== directiveId))
  }, [])

  // Commit a manual rename: mark the tab userRenamed so auto-naming won't override.
  const renameTab = useCallback((tabId: string, rawTitle: string) => {
    const title = normalizeChatTabTitle(rawTitle)
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, title, userRenamed: true } : tab)))
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
      className={classNames(
        className,
        'border-border bg-default relative flex h-full flex-col overflow-hidden border-l',
      )}
    >
      <div className="border-border bg-contrast flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon type="dashboard" className="text-info" />
          <span className="text-base font-bold">Assistant</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={classNames('hover:bg-contrast rounded p-1', showDeepResearch && 'bg-info-faded text-info')}
            onClick={() => {
              setShowResearchMode(false)
              setShowDeepResearch((value) => !value)
            }}
            aria-label="Deep research"
            aria-pressed={showDeepResearch}
            title="Deep research over your notes"
            disabled={workspaceLocked || workspacePersistence === 'pending'}
          >
            <Icon type="search" />
          </button>
          <button
            className={classNames('hover:bg-contrast rounded p-1', showResearchMode && 'bg-info-faded text-info')}
            onClick={() => {
              setShowDeepResearch(false)
              setShowResearchMode((value) => !value)
            }}
            aria-label="Research mode"
            aria-pressed={showResearchMode}
            title="Research mode (write a structured note on a topic)"
            disabled={workspaceLocked || workspacePersistence === 'pending'}
          >
            <Icon type="notes" />
          </button>
          {!standalone && (
            <button
              className="hover:bg-contrast rounded p-1"
              onClick={handlePopOut}
              aria-label="Open a separate assistant window"
              title="Open a separate assistant workspace in a new window"
              disabled={workspaceLocked || workspacePersistence === 'pending'}
            >
              <Icon type="open-in" />
            </button>
          )}
          {!standalone && (
            <button
              className="hover:bg-contrast rounded p-1"
              onClick={() => dismissLastPane()}
              aria-label="Close assistant"
              title="Close assistant"
            >
              <Icon type="close" />
            </button>
          )}
        </div>
      </div>

      {workspaceLocked && (
        <div className="bg-default absolute inset-x-0 top-[3.05rem] bottom-0 z-20 flex items-center justify-center p-6">
          <div className="text-passive-0 flex max-w-xs flex-col items-center gap-2 text-center text-sm">
            <Icon type="lock" className="text-info" />
            <span className="text-text font-semibold">Assistant workspace locked</span>
            <span>Unlock the app to reload encrypted chats. Decrypted chat state has been cleared from this view.</span>
          </div>
        </div>
      )}

      <div className="border-border bg-contrast flex items-center gap-1 overflow-x-auto border-b px-2 py-1">
        {visibleTabs.map((tab) => {
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
                  ? 'border-info bg-default text-text font-semibold'
                  : 'border-border bg-contrast text-passive-0 hover:text-text',
              )}
              title={tab.title}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  className="border-info bg-default text-text w-[10rem] rounded border px-1 text-xs focus:outline-none"
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
                  className="text-passive-1 hover:bg-contrast hover:text-text rounded p-0.5"
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
              {!isEditing && visibleTabs.length > 1 && (
                <button
                  className="hover:bg-contrast rounded p-0.5"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                  aria-label="Close chat"
                  title="Hide chat; running work continues in the background"
                >
                  <Icon type="close" size="small" />
                </button>
              )}
            </div>
          )
        })}
        <button
          className="border-border bg-contrast text-passive-0 hover:text-text flex flex-shrink-0 items-center rounded border p-1"
          onClick={addTab}
          disabled={tabs.length >= MAX_CHAT_TABS}
          aria-label="New chat"
          title={tabs.length >= MAX_CHAT_TABS ? `Up to ${MAX_CHAT_TABS} chats can stay open` : 'New chat'}
        >
          <Icon type="add" size="small" />
        </button>
        {closedTabIds.length > 0 && (
          <button
            className="border-border bg-contrast text-passive-0 hover:text-text flex flex-shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs"
            onClick={restoreLastClosedTab}
            aria-label="Restore closed chat"
            title="Restore the most recently closed chat"
          >
            <Icon type="history" size="small" />
            Restore ({closedTabIds.length})
          </button>
        )}
      </div>

      {workspacePersistence === 'transient' && loadedChatAccountScope === chatAccountScope && (
        <div className="border-warning bg-warning-faded text-text border-b px-3 py-2 text-xs">
          {workspacePersistenceNotice ||
            'This Assistant workspace is private to this tab and will not be restored after it closes.'}
        </div>
      )}

      {menu && (
        <div
          role="menu"
          className="border-border bg-default fixed z-[10000] min-w-[10rem] rounded border py-1 text-sm shadow-md"
          style={{ top: menu.y, left: menu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            className="text-text hover:bg-contrast flex w-full items-center gap-2 px-3 py-1.5 text-left"
            onClick={() => startEditing(menu.tabId)}
          >
            <Icon type="pencil-filled" size="small" />
            Rename
          </button>
          <button
            role="menuitem"
            className="text-text hover:bg-contrast flex w-full items-center gap-2 px-3 py-1.5 text-left"
            onClick={() => {
              setMenu(null)
              addTab()
            }}
          >
            <Icon type="add" size="small" />
            New chat
          </button>
          <button
            role="menuitem"
            className="text-danger hover:bg-contrast flex w-full items-center gap-2 px-3 py-1.5 text-left"
            onClick={() => deleteChat(menu.tabId)}
          >
            <Icon type="trash" size="small" />
            Delete chat
          </button>
          {visibleTabs.length > 1 && (
            <button
              role="menuitem"
              className="text-danger hover:bg-contrast flex w-full items-center gap-2 px-3 py-1.5 text-left"
              onClick={() => {
                const tabId = menu.tabId
                setMenu(null)
                closeTab(tabId)
              }}
            >
              <Icon type="close" size="small" />
              Close (keep running)
            </button>
          )}
        </div>
      )}

      <div
        className={classNames(
          'min-h-0 flex-1',
          loadedChatAccountScope === chatAccountScope && (showDeepResearch || showResearchMode) && 'hidden',
        )}
      >
        {loadedChatAccountScope !== chatAccountScope ? (
          <div className="text-passive-0 p-4 text-sm">Loading conversations…</div>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const workspaceClaim = workspaceClaimRef.current
            return (
              <div key={`${loadedChatAccountScope}:${keyEpoch}:${tab.id}`} className={isActive ? 'contents' : 'hidden'}>
                <ConversationPanel
                  application={application}
                  tabId={tab.id}
                  accountScope={loadedChatAccountScope}
                  isActive={isActive && !showDeepResearch && !showResearchMode}
                  persistenceAllowed={workspacePersistence === 'durable' && manifestTabIds.includes(tab.id)}
                  runPersistence={
                    workspaceClaim ? (operation) => workspaceClaim.runPersistence(operation, tab.id) : undefined
                  }
                  registerPersistenceFinalizer={workspaceClaim?.registerFinalizer}
                  onFirstUserMessage={(text) => autoNameTab(tab.id, text)}
                  directive={pendingDirectives[0]?.targetTabId === tab.id ? pendingDirectives[0].directive : undefined}
                  onDirectiveConsumed={consumeDirective}
                />
              </div>
            )
          })
        )}
      </div>
      <div
        className={classNames(
          'min-h-0 flex-1',
          (loadedChatAccountScope !== chatAccountScope || !showDeepResearch) && 'hidden',
        )}
      >
        <DeepResearchPanel
          key={`deep-research:${chatAccountScope}:${keyEpoch}`}
          application={application}
          onClose={() => setShowDeepResearch(false)}
        />
      </div>
      <div
        className={classNames(
          'min-h-0 flex-1',
          (loadedChatAccountScope !== chatAccountScope || !showResearchMode) && 'hidden',
        )}
      >
        <ResearchModePanel
          key={`research-mode:${chatAccountScope}:${keyEpoch}`}
          application={application}
          onClose={() => setShowResearchMode(false)}
        />
      </div>
      {children}
    </div>
  )
})

AssistantView.displayName = 'AssistantView'

export default observer(AssistantView)
