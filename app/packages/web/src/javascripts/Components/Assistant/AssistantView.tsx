import { addToast, ToastType } from '@standardnotes/toast'
import { assistantDirectiveContextMatches, AssistantChatContextSnapshot } from '@/Assistant/assistantDirectiveContext'
import { forwardRef, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { classNames } from '@standardnotes/utils'
import { ApplicationEvent, ButtonType } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { openAssistantEditorTab } from '@/Assistant/assistantEditorNavigation'
import { openOrFocusAssistantWindow } from '@/Assistant/assistantWindow'
import {
  ChatTab,
  AssistantWorkTabKind,
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
import { AssistantSyncedChats, reconcileSyncedChatSnapshots, type SyncedChat } from '@/Assistant/assistantSyncedChats'
import { AssistantHistoryPanel, AssistantRecentChats, assistantWorkTabIcon } from './AssistantHistoryPanel'
import {
  clearAssistantChatHistoryDeletionTombstone,
  deleteAssistantChatHistory,
  deleteAssistantChatHistoryStrict,
  readAssistantChatHistoryResult,
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
  /** Independent retention scope when mounted inside the notes tab surface. */
  editorTab?: boolean
  focusChatId?: string
  focusRequestRevision?: number
  /** Extra overlay content (e.g. the panel resize handle) rendered inside the root. */
  children?: ReactNode
}

const newId = () => Math.random().toString(36).slice(2)

const createTab = (kind: AssistantWorkTabKind = 'chat', number = 1): ChatTab => ({
  id: newId(),
  title: kind === 'chat' ? DEFAULT_TAB_TITLE : `${kind === 'research' ? 'Research' : 'Deep research'} ${number}`,
  userRenamed: false,
  kind,
  lastActiveAt: Date.now(),
})

/** Anchor + tab the tab context menu is open against. */
type MenuState = { tabId: string; x: number; y: number }
type RoutedDirective = { directive: AssistantChatDirective; targetTabId: string }

const AssistantView = forwardRef<HTMLDivElement, Props>((props, ref) => {
  const { application, className, id, standalone, editorTab, focusChatId, focusRequestRevision, children } = props
  const { dismissLastPane } = useResponsiveAppPane()
  const accountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
  const browsingContextId = useRef(getAssistantBrowsingContextId()).current
  const chatAccountScope =
    assistantChatWorkspaceScope(accountScope, standalone === true, browsingContextId) + (editorTab ? ':editor' : '')
  const dockOpen = application.paneController?.panes?.includes(AppPaneId.Assistant) === true
  const editorAssistantFocused = application.paneController?.activeViewTabId === AppPaneId.Assistant
  const receivesDirectives = editorTab
    ? editorAssistantFocused && !dockOpen
    : standalone || !editorAssistantFocused || dockOpen
  const appliedFocusRequest = useRef<string | undefined>(undefined)

  const initialTab = useRef(createTab()).current
  const [tabs, setTabs] = useState<ChatTab[]>([initialTab])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [activeTabId, setActiveTabId] = useState<string>(initialTab.id)
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  // Closing is a reversible hide. Keeping the panel mounted lets an in-flight
  // run continue; Delete is the only operation that erases the transcript.
  const [closedTabIds, setClosedTabIds] = useState<string[]>([])
  const closedTabIdsRef = useRef(closedTabIds)
  closedTabIdsRef.current = closedTabIds
  const [mountedTabIds, setMountedTabIds] = useState<string[]>([])
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
  // History is a view of the encrypted manifest, never its own persisted chat.
  const historyTabId = useRef(newId()).current
  const [historyOpen, setHistoryOpen] = useState(false)
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
  const chatContextsRef = useRef(new Map<string, AssistantChatContextSnapshot>())
  const workspaceClaimRef = useRef<AssistantWorkspaceClaim | null>(null)
  const pendingWorkspaceReleasesRef = useRef(new Set<Promise<void>>())
  const workspaceManifestChainRef = useRef(Promise.resolve(true))
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const sharedStoreRef = useRef<AssistantSyncedChats | null>(null)
  // Empty ordinary chats are local drafts. Metadata follows real history (or
  // an explicit rename), rather than allocating a synced chat on every click.
  const seededChatIdsRef = useRef(new Set<string>())
  const [sharedChats, setSharedChats] = useState<SyncedChat[]>([])
  const [sharedReady, setSharedReady] = useState(false)
  const metadataTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const checkpointMetadata = useCallback((tab: ChatTab) => {
    const store = sharedStoreRef.current
    const pending = metadataTimers.current.get(tab.id)
    if (pending) {
      clearTimeout(pending)
    }
    if (!store || !seededChatIdsRef.current.has(tab.id)) {
      return
    }
    const timer = setTimeout(() => {
      metadataTimers.current.delete(tab.id)
      if (sharedStoreRef.current !== store || workspaceLockedRef.current) {
        return
      }
      void store
        .updateMetadata(tab)
        .then(() => {
          if (sharedStoreRef.current === store && !workspaceLockedRef.current) {
            setWorkspacePersistenceNotice((notice) => {
              return notice === 'Chat details could not be synced. Try again when storage is available.' ? '' : notice
            })
          }
        })
        .catch(() => {
          if (sharedStoreRef.current === store && !workspaceLockedRef.current) {
            setWorkspacePersistenceNotice('Chat details could not be synced. Try again when storage is available.')
          }
        })
    }, 500)
    metadataTimers.current.set(tab.id, timer)
  }, [])
  useEffect(
    () => () => {
      for (const timer of metadataTimers.current.values()) {
        clearTimeout(timer)
      }
      metadataTimers.current.clear()
    },
    [],
  )

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
        (event === ApplicationEvent.PreparingForSignOut ||
          event === ApplicationEvent.SignedIn ||
          event === ApplicationEvent.SignedOut ||
          event === ApplicationEvent.KeyStatusChanged)
      ) {
        const nextAccountScope = application.sessions.getUser()?.uuid ?? `anonymous:${application.identifier}`
        const accountChanged = nextAccountScope !== observedAccountScopeRef.current
        observedAccountScopeRef.current = nextAccountScope
        if (
          event !== ApplicationEvent.KeyStatusChanged &&
          event !== ApplicationEvent.PreparingForSignOut &&
          !accountChanged
        ) {
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
        sharedStoreRef.current?.dispose()
        sharedStoreRef.current = null
        seededChatIdsRef.current.clear()
        setSharedChats([])
        setSharedReady(false)
        clearAssistantDirectives()
        setPendingDirectives([])
        chatContextsRef.current.clear()
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
        setMountedTabIds([])
        setEditingTabId(null)
        setMenu(null)
        setHistoryOpen(false)
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
    let sharedStore: AssistantSyncedChats | undefined
    let stopShared: (() => void) | undefined
    const transition = ++workspaceActivationRef.current
    workspaceLockedRef.current = true
    setWorkspacePersistence('pending')
    setWorkspacePersistenceNotice('')
    setManifestTabIds([])
    setRetainedCleanupTabIds([])
    setLoadedChatAccountScope('')
    setSharedChats([])
    setSharedReady(false)
    seededChatIdsRef.current.clear()
    setMountedTabIds([])

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

      // Account chats are encrypted sync items, shared by all views. The old
      // workspace lifetime lock continues to protect anonymous local storage.
      if (application.sessions.getUser()?.uuid) {
        sharedStore = new AssistantSyncedChats(application)
        sharedStoreRef.current = sharedStore
        try {
          let incompleteImports = 0
          let remote = await sharedStore.read()
          const local = readPersistedTabsResult(application.storage, chatAccountScope)
          if (local.status === 'found') {
            const existing = new Set(remote.map((chat) => chat.tab.id))
            for (const tab of local.tabs) {
              if (existing.has(tab.id)) {
                continue
              }
              const history = readAssistantChatHistoryResult(application.storage, chatAccountScope, tab.id)
              if (history.status !== 'found' || !history.messages.length) {
                if (tab.kind === 'research' || tab.kind === 'deep-research') {
                  try {
                    await sharedStore.updateMetadata(tab)
                  } catch {
                    incompleteImports += 1
                  }
                } else if (history.status === 'error') {
                  incompleteImports += 1
                }
                continue
              }
              try {
                await sharedStore.save(tab, history.messages, history.deniedToolNames)
              } catch {
                // A shared deletion tombstone wins over a legacy local copy.
                incompleteImports += 1
              }
            }
            remote = await sharedStore.read()
          }
          if (cancelled || transition !== workspaceActivationRef.current) {
            return
          }
          const restored = remote.length ? remote.map((chat) => chat.tab) : [createTab()]
          let known = new Set(remote.map((chat) => chat.tab.id))
          let catalog = remote
          let refreshing = false
          let refreshRequested = false
          const refreshOnce = async () => {
            try {
              const read = await sharedStore!.read()
              if (cancelled || transition !== workspaceActivationRef.current) {
                return
              }
              const previousMetadata = new Map(catalog.map((chat) => [chat.tab.id, chat.tab]))
              const next = reconcileSyncedChatSnapshots(catalog, read)
              if (next === catalog) {
                return
              }
              catalog = next
              const nextIds = new Set(next.map((chat) => chat.tab.id))
              const removed = new Set([...known].filter((chatId) => !nextIds.has(chatId)))
              const added = next.filter((chat) => !known.has(chat.tab.id)).map((chat) => chat.tab.id)
              const visibleIds = new Set(tabsRef.current.map((tab) => tab.id))
              const replacement = removed.has(activeTabIdRef.current)
                ? (tabsRef.current.find((tab) => !removed.has(tab.id)) ?? next[0]?.tab ?? createTab())
                : undefined
              known = nextIds
              nextIds.forEach((chatId) => seededChatIdsRef.current.add(chatId))
              setSharedChats(next)
              setTabs((previous) => {
                const retained = previous.filter((tab) => !removed.has(tab.id))
                const metadata = new Map(next.map((chat) => [chat.tab.id, chat.tab]))
                const ids = new Set(retained.map((tab) => tab.id))
                const merged = [
                  ...retained.map((tab) => {
                    const updated = metadata.get(tab.id)
                    // A transcript-only update must not replace an unchanged
                    // tab or undo an optimistic local title/mode selection.
                    if (!updated || JSON.stringify(updated) === JSON.stringify(previousMetadata.get(tab.id))) {
                      return tab
                    }
                    return JSON.stringify(updated) === JSON.stringify(tab) ? tab : updated
                  }),
                  ...next.filter((chat) => !ids.has(chat.tab.id)).map((chat) => chat.tab),
                ]
                if (!merged.length) {
                  merged.push(replacement ?? createTab())
                }
                if (replacement) {
                  setActiveTabId(replacement.id)
                }
                return merged.length === previous.length && merged.every((tab, index) => tab === previous[index])
                  ? previous
                  : merged
              })
              // New remote chats appear in History without stealing focus.
              setClosedTabIds((previous) => {
                const closed = [
                  ...new Set([
                    ...previous.filter((chatId) => !removed.has(chatId) && chatId !== replacement?.id),
                    ...added.filter((chatId) => !visibleIds.has(chatId) && chatId !== replacement?.id),
                  ]),
                ]
                return closed.length === previous.length && closed.every((id, index) => id === previous[index])
                  ? previous
                  : closed
              })
            } catch {
              if (!cancelled && transition === workspaceActivationRef.current) {
                setWorkspacePersistenceNotice(
                  'Synced chats could not be refreshed. Your current conversation remains open; retry after storage is available.',
                )
              }
            }
          }
          const refresh = () => {
            refreshRequested = true
            if (refreshing) {
              return
            }
            refreshing = true
            void (async () => {
              while (refreshRequested) {
                if (cancelled || transition !== workspaceActivationRef.current) {
                  break
                }
                refreshRequested = false
                await refreshOnce()
              }
            })().finally(() => {
              refreshing = false
              // An event can arrive after the drain's final condition but
              // before this microtask. Do not lose that last invalidation.
              if (refreshRequested && !cancelled && transition === workspaceActivationRef.current) {
                refresh()
              }
            })
          }
          stopShared = sharedStore.subscribe(() => {
            refresh()
          })
          refresh()
          setTabs(restored)
          remote.forEach(({ tab }) => seededChatIdsRef.current.add(tab.id))
          setActiveTabId(restored[0].id)
          setClosedTabIds(restored.slice(1).map((tab) => tab.id))
          setSharedChats(remote)
          setSharedReady(true)
          setLoadedChatAccountScope(chatAccountScope)
          setWorkspacePersistence('durable')
          setWorkspacePersistenceNotice(
            incompleteImports
              ? 'Some older local chats could not be imported into synced history. Their existing local copies were kept.'
              : '',
          )
          setWorkspaceLocked(false)
          workspaceLockedRef.current = false
          setKeyEpoch((epoch) => epoch + 1)
        } catch {
          if (!cancelled && transition === workspaceActivationRef.current) {
            setLoadedChatAccountScope(chatAccountScope)
            setWorkspacePersistence('transient')
            setWorkspacePersistenceNotice(
              'Encrypted synced chat storage is unavailable. Retry when this account is loaded and unlocked.',
            )
            setWorkspaceLocked(false)
            workspaceLockedRef.current = false
          }
        }
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
      chatContextsRef.current.clear()
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
      stopShared?.()
      sharedStore?.dispose()
      if (sharedStoreRef.current === sharedStore) {
        sharedStoreRef.current = null
      }
      if (workspaceClaimRef.current === ownedClaim) {
        workspaceClaimRef.current = null
      }
      if (ownedClaim) {
        void releaseWorkspaceClaim(ownedClaim)
      }
    }
  }, [accountScope, application, chatAccountScope, releaseWorkspaceClaim, workspaceRevision])

  useEffect(() => {
    if (
      sharedReady ||
      workspaceLocked ||
      workspacePersistence !== 'transient' ||
      !application.sessions.getUser()?.uuid
    ) {
      return
    }
    return application.addEventObserver(async (event) => {
      if (
        event === ApplicationEvent.LocalDataLoaded ||
        event === ApplicationEvent.Launched ||
        event === ApplicationEvent.CompletedRestart
      ) {
        setWorkspaceRevision((revision) => revision + 1)
      }
    })
  }, [application, sharedReady, workspaceLocked, workspacePersistence])

  // A synced catalog can contain many historical chats. Mount a conversation
  // only when opened here; closing it still keeps local running work mounted.
  useEffect(() => {
    if (loadedChatAccountScope !== chatAccountScope || workspaceLocked || activeTabId === historyTabId) {
      return
    }
    setMountedTabIds((previous) => (previous.includes(activeTabId) ? previous : [...previous, activeTabId]))
  }, [loadedChatAccountScope, chatAccountScope, workspaceLocked, activeTabId, historyTabId])

  useEffect(() => {
    if (
      !receivesDirectives ||
      workspaceLocked ||
      workspacePersistence === 'pending' ||
      loadedChatAccountScope !== chatAccountScope
    ) {
      return
    }
    return subscribeAssistantDirectives(accountScope, (directive) => {
      if (workspaceLockedRef.current || directive.accountScope !== observedAccountScopeRef.current) {
        return
      }
      const current = tabsRef.current
      let target = current.find(
        (tab) =>
          tab.id === activeTabIdRef.current &&
          assistantDirectiveContextMatches(chatContextsRef.current.get(tab.id), directive),
      )
      if (!target) {
        if (current.filter((tab) => !closedTabIds.includes(tab.id)).length >= MAX_CHAT_TABS) {
          addToast({
            type: ToastType.Error,
            message: 'Close an Assistant chat tab before starting this action in a new context.',
          })
          return
        }
        target = createTab()
        checkpointMetadata(target)
        tabsRef.current = [...current, target]
        setTabs((previous) => [...previous, target!])
      }
      const targetTabId = target.id
      activeTabIdRef.current = targetTabId
      chatContextsRef.current.set(targetTabId, {
        noteUuids: directive.noteUuid ? [directive.noteUuid] : [],
        ...(directive.contextKind === 'note' ? {} : { selectedText: directive.selectedText }),
      })
      setClosedTabIds((previous) => previous.filter((id) => id !== targetTabId))
      setActiveTabId(targetTabId)
      setTabs((previous) =>
        previous.map((tab) => (tab.id === targetTabId ? { ...tab, lastActiveAt: Date.now() } : tab)),
      )
      setPendingDirectives((current) => {
        return current.some((item) => item.directive.id === directive.id)
          ? current
          : [...current, { directive, targetTabId }]
      })
    })
  }, [
    accountScope,
    chatAccountScope,
    loadedChatAccountScope,
    workspaceLocked,
    workspacePersistence,
    closedTabIds,
    checkpointMetadata,
    receivesDirectives,
  ])

  useEffect(() => {
    const requestKey = `${accountScope}:${focusChatId}:${focusRequestRevision ?? 0}`
    if (
      !editorTab ||
      !focusChatId ||
      appliedFocusRequest.current === requestKey ||
      workspaceLocked ||
      loadedChatAccountScope !== chatAccountScope ||
      !tabs.some((tab) => tab.id === focusChatId)
    ) {
      return
    }
    appliedFocusRequest.current = requestKey
    setClosedTabIds((previous) => previous.filter((id) => id !== focusChatId))
    setActiveTabId(focusChatId)
  }, [
    accountScope,
    editorTab,
    focusChatId,
    focusRequestRevision,
    workspaceLocked,
    loadedChatAccountScope,
    chatAccountScope,
    tabs,
  ])

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

  const addTab = useCallback(
    (kind: AssistantWorkTabKind = 'chat') => {
      if (tabs.filter((tab) => !closedTabIds.includes(tab.id)).length >= MAX_CHAT_TABS) {
        return
      }
      const tab = createTab(kind, tabs.filter((tab) => tab.kind === kind).length + 1)
      checkpointMetadata(tab)
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    },
    [tabs, closedTabIds, checkpointMetadata],
  )

  const visibleTabs = tabs.filter((tab) => !closedTabIds.includes(tab.id))
  const displayedTabs =
    loadedChatAccountScope === chatAccountScope && !workspaceLocked
      ? [
          ...visibleTabs,
          ...(historyOpen ? [{ id: historyTabId, title: 'History', userRenamed: true, kind: 'history' as const }] : []),
        ]
      : []
  const resumeTab = useCallback((tabId: string) => {
    if (workspaceLockedRef.current || !tabsRef.current.some((tab) => tab.id === tabId)) {
      return
    }
    closedTabIdsRef.current = closedTabIdsRef.current.filter((id) => id !== tabId)
    setClosedTabIds(closedTabIdsRef.current)
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
    setTabs((previous) => previous.map((tab) => (tab.id === tabId ? { ...tab, lastActiveAt: Date.now() } : tab)))
  }, [])

  const closeTab = useCallback(
    (tabId: string) => {
      const freshChat = () => {
        const next = createTab()
        checkpointMetadata(next)
        tabsRef.current = [...tabsRef.current, next]
        setTabs(tabsRef.current)
        setHistoryOpen(false)
        activeTabIdRef.current = next.id
        setActiveTabId(next.id)
      }
      const visible = tabsRef.current.filter((tab) => !closedTabIdsRef.current.includes(tab.id))
      if (tabId === historyTabId) {
        setHistoryOpen(false)
        if (visible[0]) {
          if (activeTabIdRef.current === historyTabId) {
            resumeTab(visible[0].id)
          }
        } else {
          freshChat()
        }
        return
      }
      if (!visible.some((tab) => tab.id === tabId)) {
        return
      }
      closedTabIdsRef.current = [...closedTabIdsRef.current, tabId]
      setClosedTabIds(closedTabIdsRef.current)
      if (visible.length <= 1) {
        freshChat()
        return
      }
      const index = visible.findIndex((tab) => tab.id === tabId)
      const remaining = visible.filter((tab) => tab.id !== tabId)
      if (activeTabIdRef.current === tabId) {
        resumeTab((remaining[index] ?? remaining[index - 1] ?? remaining[0]).id)
      }
    },
    [historyTabId, resumeTab, checkpointMetadata],
  )

  const restoreLastClosedTab = useCallback(() => {
    setClosedTabIds((prev) => {
      const tabId = prev.at(-1)
      if (!tabId) {
        return prev
      }
      setActiveTabId(tabId)
      setTabs((tabs) => tabs.map((tab) => (tab.id === tabId ? { ...tab, lastActiveAt: Date.now() } : tab)))
      return prev.slice(0, -1)
    })
  }, [])

  const deleteChat = useCallback(
    async (tabId: string) => {
      if (workspaceLockedRef.current || loadedChatAccountScope !== chatAccountScope) {
        return false
      }
      setMenu(null)
      const transition = sessionTransitionRef.current
      const activation = workspaceActivationRef.current
      const claim = workspaceClaimRef.current
      const sharedStore = sharedStoreRef.current
      if (sharedStore) {
        try {
          await sharedStore.delete(tabId)
        } catch {
          if (sharedStoreRef.current === sharedStore && !workspaceLockedRef.current) {
            setWorkspacePersistenceNotice(
              'The chat could not be deleted from encrypted storage. Try again; its saved history was kept.',
            )
          }
          return false
        }
      }
      let retainForCleanup = false
      if (claim?.durable && workspacePersistence === 'durable') {
        let deletionDurable = false
        let retired: boolean
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
      if (
        transition !== sessionTransitionRef.current ||
        activation !== workspaceActivationRef.current ||
        workspaceLockedRef.current ||
        loadedChatAccountScope !== chatAccountScope
      ) {
        return false
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
        // Storage can settle after the user changes focus or hides another tab.
        // Choose a replacement from the live UI intent, not the deletion click.
        if (activeTabIdRef.current === tabId) {
          const visibleNext = next.filter((tab) => !closedTabIdsRef.current.includes(tab.id))
          const replacement = visibleNext[index] ?? visibleNext[index - 1] ?? visibleNext[0] ?? next[0]
          setClosedTabIds((previous) => previous.filter((id) => id !== replacement.id))
          setActiveTabId(replacement.id)
        }
        return next
      })
      return !retainForCleanup
    },
    [application, loadedChatAccountScope, chatAccountScope, workspacePersistence],
  )

  const deleteHistoryChats = useCallback(
    async (ids: string[]): Promise<boolean> => {
      const transition = sessionTransitionRef.current
      const activation = workspaceActivationRef.current
      const current = () =>
        transition === sessionTransitionRef.current &&
        activation === workspaceActivationRef.current &&
        !workspaceLockedRef.current &&
        loadedChatAccountScope === chatAccountScope
      const targets = [...new Set(ids)].filter((id) => tabsRef.current.some((tab) => tab.id === id))
      if (!current() || !targets.length) {
        return false
      }
      const confirmed = await application.alerts.confirm(
        `Permanently delete ${targets.length} conversation${targets.length === 1 ? '' : 's'} and their saved messages? This cannot be undone.`,
        'Delete chat history?',
        'Delete',
        ButtonType.Danger,
      )
      if (!confirmed || !current()) {
        return false
      }
      for (const id of targets) {
        if (!current() || !(await deleteChat(id))) {
          return false
        }
      }
      return true
    },
    [application, chatAccountScope, loadedChatAccountScope, deleteChat],
  )

  // Auto-name from the first user message, but never clobber a user-chosen title.
  const autoNameTab = useCallback(
    (tabId: string, text: string) => {
      const current = tabsRef.current.find((tab) => tab.id === tabId)
      if (!current || current.userRenamed) {
        return
      }
      const next = { ...current, title: deriveTitleFromMessage(text) }
      checkpointMetadata(next)
      tabsRef.current = tabsRef.current.map((tab) => (tab.id === tabId ? next : tab))
      setTabs(tabsRef.current)
    },
    [checkpointMetadata],
  )

  const consumeDirective = useCallback((directiveId: string) => {
    setPendingDirectives((current) => current.filter((item) => item.directive.id !== directiveId))
  }, [])

  // Commit a manual rename: mark the tab userRenamed so auto-naming won't override.
  const renameTab = useCallback((tabId: string, rawTitle: string) => {
    const title = normalizeChatTabTitle(rawTitle)
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, title, userRenamed: true } : tab)))
    const current = tabsRef.current.find((tab) => tab.id === tabId)
    const store = sharedStoreRef.current
    if (current && store) {
      seededChatIdsRef.current.add(tabId)
      void store.updateMetadata({ ...current, title, userRenamed: true }).catch(() => {
        if (sharedStoreRef.current === store && !workspaceLockedRef.current) {
          setWorkspacePersistenceNotice(
            'The chat title could not be saved. Try renaming it again when storage is available.',
          )
        }
      })
    }
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
          <Icon type="assistant" className="text-info" />
          <span className="text-base font-bold">Assistant</span>
        </div>
        <div className="flex items-center gap-1">
          {!editorTab && (
            <button
              className="hover:bg-contrast rounded p-1"
              onClick={() => openAssistantEditorTab(application, activeTabId)}
              aria-label="Open Assistant in editor tab"
              title={
                application.sessions.getUser()?.uuid
                  ? 'Open the current conversation alongside note tabs'
                  : 'Sign in to open a synced conversation alongside note tabs'
              }
              disabled={
                workspaceLocked ||
                workspacePersistence === 'pending' ||
                activeTabId === historyTabId ||
                !application.sessions.getUser()?.uuid
              }
            >
              <Icon type="window" />
            </button>
          )}
          <button
            className={classNames(
              'hover:bg-contrast rounded p-1',
              activeTabId === historyTabId && 'bg-info-faded text-info',
            )}
            onClick={() => {
              setHistoryOpen(true)
              setActiveTabId(historyTabId)
            }}
            aria-label="Chat history"
            aria-pressed={activeTabId === historyTabId}
            title="Open chat history"
            disabled={workspaceLocked || workspacePersistence === 'pending'}
          >
            <Icon type="history" />
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
              onClick={() => {
                if (editorTab) {
                  application.paneController.closeViewTab(AppPaneId.Assistant)
                } else {
                  dismissLastPane()
                }
              }}
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

      <div
        role="tablist"
        aria-label="Assistant workspaces"
        className="border-border bg-contrast flex items-center gap-1 overflow-x-auto border-b px-2 py-1"
      >
        {displayedTabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isEditing = tab.id === editingTabId
          const isHistory = tab.kind === 'history'
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              aria-label={tab.title}
              onClick={() => (isHistory ? setActiveTabId(tab.id) : resumeTab(tab.id))}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                }
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  event.stopPropagation()
                  closeTab(tab.id)
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                if (!isHistory) {
                  openMenu(event, tab.id)
                }
              }}
              onKeyDown={(event) => {
                if (isEditing) {
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (isHistory) {
                    setActiveTabId(tab.id)
                  } else {
                    resumeTab(tab.id)
                  }
                } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const index = displayedTabs.findIndex((item) => item.id === tab.id)
                  const nextIndex =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? displayedTabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + displayedTabs.length) % displayedTabs.length
                  const next = displayedTabs[nextIndex]
                  if (next.id === historyTabId) {
                    setActiveTabId(next.id)
                  } else {
                    resumeTab(next.id)
                  }
                  const tabElements = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')
                  tabElements?.[nextIndex]?.focus()
                } else if (event.key === 'F2' && !isHistory) {
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
              <Icon
                type={isHistory ? 'history' : assistantWorkTabIcon(tab as ChatTab)}
                size="small"
                className="shrink-0"
              />
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
              {!isEditing && !isHistory && (
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
              {!isEditing && (
                <button
                  className="hover:bg-contrast rounded p-0.5"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                  aria-label={isHistory ? 'Close history' : 'Close chat'}
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
          onClick={() => addTab()}
          disabled={visibleTabs.length >= MAX_CHAT_TABS}
          aria-label="New chat"
          title={visibleTabs.length >= MAX_CHAT_TABS ? `Up to ${MAX_CHAT_TABS} chats can stay open` : 'New chat'}
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

      {(workspacePersistence === 'transient' || workspacePersistenceNotice) &&
        loadedChatAccountScope === chatAccountScope && (
          <div className="border-warning bg-warning-faded text-text border-b px-3 py-2 text-xs">
            {workspacePersistenceNotice ||
              'This Assistant workspace is private to this tab and will not be restored after it closes.'}
            {application.sessions.getUser()?.uuid && !sharedReady && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => setWorkspaceRevision((revision) => revision + 1)}
              >
                Retry chat storage
              </button>
            )}
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

      <div className={classNames('min-h-0 flex-1', historyOpen && activeTabId === historyTabId && 'hidden')}>
        {loadedChatAccountScope !== chatAccountScope ? (
          <div className="text-passive-0 p-4 text-sm">Loading conversations…</div>
        ) : (
          tabs
            .filter((tab) => mountedTabIds.includes(tab.id))
            .map((tab) => {
              const isActive = tab.id === activeTabId
              const workspaceClaim = workspaceClaimRef.current
              const sharedStore = sharedStoreRef.current
              return (
                <div
                  key={`${loadedChatAccountScope}:${keyEpoch}:${tab.id}`}
                  role="tabpanel"
                  aria-label={tab.title}
                  data-assistant-tab={tab.id}
                  className={isActive ? 'contents' : 'hidden'}
                >
                  <ConversationPanel
                    application={application}
                    tabId={tab.id}
                    conversationMode={
                      tab.conversationMode ??
                      (tab.kind === 'research' || tab.kind === 'deep-research' ? tab.kind : 'agent')
                    }
                    onModeChange={(conversationMode) => {
                      if (workspaceLockedRef.current) {
                        return
                      }
                      const current = tabsRef.current.find((entry) => entry.id === tab.id)
                      if (!current) {
                        return
                      }
                      const next = {
                        ...current,
                        conversationMode,
                        conversationModeUpdatedAt: Math.max(Date.now(), (current.conversationModeUpdatedAt ?? 0) + 1),
                      }
                      checkpointMetadata(next)
                      tabsRef.current = tabsRef.current.map((entry) => (entry.id === tab.id ? next : entry))
                      setTabs(tabsRef.current)
                    }}
                    sharedChat={
                      application.sessions.getUser()?.uuid
                        ? {
                            ready: sharedReady,
                            history: sharedChats.find((chat) => chat.tab.id === tab.id),
                            removeMessage: async (messageId) => {
                              if (
                                !sharedStore ||
                                sharedStoreRef.current !== sharedStore ||
                                application.sessions.getUser()?.uuid !== accountScope ||
                                workspaceLockedRef.current
                              ) {
                                throw new Error('Synced chat storage is unavailable.')
                              }
                              await sharedStore.removeMessage(tab.id, messageId)
                            },
                            refresh: async () => {
                              if (
                                !sharedStore ||
                                sharedStoreRef.current !== sharedStore ||
                                application.sessions.getUser()?.uuid !== accountScope ||
                                workspaceLockedRef.current
                              ) {
                                throw new Error('Synced chat storage is unavailable.')
                              }
                              await application.sync.sync({
                                sourceDescription: 'Refresh Assistant chat before generation',
                              })
                              const latest = await sharedStore.read()
                              if (sharedStoreRef.current !== sharedStore || workspaceLockedRef.current) {
                                throw new Error('Synced chat storage is unavailable.')
                              }
                              return latest.find((chat) => chat.tab.id === tab.id)
                            },
                            checkpoint: async (messages, deniedToolNames) => {
                              const store = sharedStore
                              const current = tabsRef.current.find((entry) => entry.id === tab.id)
                              if (
                                !store ||
                                sharedStoreRef.current !== store ||
                                application.sessions.getUser()?.uuid !== accountScope ||
                                !current ||
                                workspaceLockedRef.current
                              ) {
                                throw new Error('Synced chat storage is unavailable.')
                              }
                              if (
                                !seededChatIdsRef.current.has(tab.id) &&
                                !messages.some(
                                  (message) =>
                                    message.text.trim().length > 0 ||
                                    message.attachments?.length ||
                                    message.activities?.length,
                                )
                              ) {
                                return
                              }
                              seededChatIdsRef.current.add(tab.id)
                              await store.save(current, messages, deniedToolNames)
                              const canonical = await store.read()
                              if (
                                sharedStoreRef.current !== store ||
                                application.sessions.getUser()?.uuid !== accountScope ||
                                workspaceLockedRef.current
                              ) {
                                throw new Error('Synced chat storage is unavailable.')
                              }
                              return canonical.find((chat) => chat.tab.id === tab.id)
                            },
                          }
                        : undefined
                    }
                    accountScope={loadedChatAccountScope}
                    isActive={isActive}
                    persistenceAllowed={workspacePersistence === 'durable' && manifestTabIds.includes(tab.id)}
                    runPersistence={
                      workspaceClaim ? (operation) => workspaceClaim.runPersistence(operation, tab.id) : undefined
                    }
                    registerPersistenceFinalizer={workspaceClaim?.registerFinalizer}
                    onFirstUserMessage={(text) => autoNameTab(tab.id, text)}
                    directive={
                      pendingDirectives[0]?.targetTabId === tab.id ? pendingDirectives[0].directive : undefined
                    }
                    onDirectiveConsumed={consumeDirective}
                    onContextSnapshot={(snapshot) => {
                      if (
                        !workspaceLockedRef.current &&
                        loadedChatAccountScope === chatAccountScope &&
                        observedAccountScopeRef.current === accountScope
                      ) {
                        chatContextsRef.current.set(tab.id, snapshot)
                      }
                    }}
                    recentChats={<AssistantRecentChats tabs={tabs} currentTabId={tab.id} onResume={resumeTab} />}
                  />
                </div>
              )
            })
        )}
      </div>
      {historyOpen && loadedChatAccountScope === chatAccountScope && !workspaceLocked && (
        <div className={classNames('min-h-0 flex-1', activeTabId !== historyTabId && 'hidden')}>
          <AssistantHistoryPanel
            key={`${chatAccountScope}:${keyEpoch}`}
            tabs={tabs}
            closedTabIds={closedTabIds}
            onResume={resumeTab}
            onRename={renameTab}
            onDelete={deleteHistoryChats}
          />
        </div>
      )}
      {children}
    </div>
  )
})

AssistantView.displayName = 'AssistantView'

export default observer(AssistantView)
