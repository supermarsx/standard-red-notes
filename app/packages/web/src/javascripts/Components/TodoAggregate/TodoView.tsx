import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { NoteTodos, TodoItem, totalTodoProgress } from './allTodos'
import { applyTodoPatch, TodoActionResult } from './todoActions'
import type { SuperChecklistTodoPatch, SuperChecklistTodoTarget } from './superChecklistDocument'
import { pruneTodoSelection, selectableTodoKey, todoSelectionKey } from './todoSelection'
import {
  CHECKLIST_DUE_TICK_MS,
  checklistDueAtFromLocalInput,
  formatChecklistDue,
} from '../SuperEditor/Checklist/checklistDueDate'
import { canDisplayTodoNote, canMutateSuperChecklistNote, collectAuthorizedTodoGroups } from './todoAuthorization'
import { createChecklistTodoId } from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import {
  revokeChecklistMutationBridge,
  waitForActiveChecklistMutationBridge,
  waitForReadyActiveChecklistMutationLease,
} from '../SuperEditor/Checklist/ChecklistMutationBridge'
import {
  clearTodoChecklistEditorOwner,
  getTodoChecklistEditorOwner,
  publishTodoChecklistEditorOwner,
  releaseTodoChecklistEditorOwnerAfter,
  TodoChecklistEditorOwnerState,
  waitForTodoChecklistEditorOwnerRelease,
} from './TodoChecklistEditorOwner'
import type { NoteViewController } from '../NoteView/Controller/NoteViewController'
import { clearTodoDueDraft, setTodoDueDraft, todoDueInputValue, TodoDueDrafts } from './todoDueDrafts'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

type ManagedTodo = {
  group: NoteTodos
  item: TodoItem
  key: string
}

const RECOMPUTE_THROTTLE_MS = 1500
const TODO_OWNER_BRIDGE_TIMEOUT_MS = 12_000
const TODO_OWNER_IDLE_RELEASE_MS = 15_000

type TodoViewLifetime = {
  application: WebApplication
  generation: number
  dataReady: boolean
}

type TodoViewLifetimeToken = Pick<TodoViewLifetime, 'application' | 'generation'>

type TodoOwnerResult =
  { ok: true; leaseId: string; detachedOwner?: TodoChecklistEditorOwnerState } | { ok: false; reason: string }

function captureLifetime(lifetime: TodoViewLifetime): TodoViewLifetimeToken {
  return { application: lifetime.application, generation: lifetime.generation }
}

function lifetimeIsCurrent(lifetime: TodoViewLifetime, token: TodoViewLifetimeToken): boolean {
  return lifetime.application === token.application && lifetime.generation === token.generation
}

const SOURCE_LABEL: Record<NoteTodos['source'], string> = {
  super: 'Super checklist',
  'advanced-checklist': 'Advanced Checklist',
}

const ProgressBar = ({ completed, total }: { completed: number; total: number }) => {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="bg-contrast h-1.5 w-24 overflow-hidden rounded-full">
        <div className="bg-info h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-passive-1 text-xs">
        {completed}/{total}
      </span>
    </div>
  )
}

function todoTarget(item: TodoItem): SuperChecklistTodoTarget | undefined {
  if (!item.locator) {
    return undefined
  }
  return {
    todoId: item.todoId,
    locator: item.locator,
    text: item.text,
    checked: item.checked,
  }
}

function canManageGroup(application: WebApplication, group: NoteTodos): boolean {
  return group.source === 'super' && canMutateSuperChecklistNote(application, group.note)
}

const TodoView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const readGroups = useCallback(
    () => collectAuthorizedTodoGroups(application, application.items.getItems<SNNote>(ContentType.TYPES.Note)),
    [application],
  )
  const [storedGroups, setStoredGroups] = useState<{
    application: WebApplication
    generation: number
    groups: NoteTodos[]
  }>(() => ({ application, generation: 0, groups: readGroups() }))
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [dueDrafts, setDueDrafts] = useState<TodoDueDrafts>(() => new Map())
  const [now, setNow] = useState(Date.now)
  const lifetimeRef = useRef<TodoViewLifetime>({ application, generation: 0, dataReady: true })
  const actionQueue = useRef<Promise<void>>(Promise.resolve())
  const ownerWaits = useRef(new Set<AbortController>())
  const ownerRef = useRef<TodoChecklistEditorOwnerState | undefined>(getTodoChecklistEditorOwner(application))
  const ownerIdleTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  if (lifetimeRef.current.application !== application) {
    lifetimeRef.current = {
      application,
      generation: lifetimeRef.current.generation + 1,
      dataReady: true,
    }
    ownerRef.current = getTodoChecklistEditorOwner(application)
  }

  const currentGeneration = lifetimeRef.current.generation
  const groups = useMemo(() => {
    return storedGroups.application === application && storedGroups.generation === currentGeneration
      ? storedGroups.groups
      : []
  }, [application, currentGeneration, storedGroups])

  const enqueueNoteAction = useCallback(function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const previous = actionQueue.current
    const running = previous.catch(() => undefined).then(action)
    const settled = running.then(
      () => undefined,
      () => undefined,
    )
    actionQueue.current = settled
    return running
  }, [])

  const clearOwnerIdleTimer = useCallback(() => {
    if (ownerIdleTimeout.current) {
      clearTimeout(ownerIdleTimeout.current)
      ownerIdleTimeout.current = undefined
    }
  }, [])

  const clearOwnedControllerState = useCallback((expected: TodoChecklistEditorOwnerState) => {
    if (ownerRef.current !== expected) {
      return
    }
    ownerRef.current = undefined
    clearTodoChecklistEditorOwner(expected.application, expected)
  }, [])

  const closeOwnerImmediately = useCallback(
    (expected?: TodoChecklistEditorOwnerState) => {
      clearOwnerIdleTimer()
      const current = ownerRef.current
      if (!current || (expected && current !== expected)) {
        return
      }
      clearOwnedControllerState(current)
      current.application.itemControllerGroup.closeDetachedNoteControllerImmediately(current.controller)
    },
    [clearOwnedControllerState, clearOwnerIdleTimer],
  )

  const ensureOwner = useCallback(
    async (noteUuid: string, lifetimeToken: TodoViewLifetimeToken, signal: AbortSignal): Promise<TodoOwnerResult> => {
      clearOwnerIdleTimer()
      if (signal.aborted || !lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
        return { ok: false, reason: 'The account changed before the action could run.' }
      }

      const previousOwnerReleased = await waitForTodoChecklistEditorOwnerRelease(application, {
        timeoutMs: TODO_OWNER_BRIDGE_TIMEOUT_MS,
        signal,
      })
      if (!previousOwnerReleased) {
        return { ok: false, reason: 'The previous todo update is still being saved.' }
      }
      if (signal.aborted || !lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
        return { ok: false, reason: 'The account changed before the action could run.' }
      }

      if (application.itemControllerGroup.hasVisibleChecklistController(noteUuid)) {
        const visibleLeaseId = await waitForReadyActiveChecklistMutationLease(application, noteUuid, {
          role: 'interactive',
          timeoutMs: TODO_OWNER_BRIDGE_TIMEOUT_MS,
          signal,
        })
        const visibleNote = application.items.findItem<SNNote>(noteUuid)
        return visibleLeaseId &&
          !signal.aborted &&
          lifetimeIsCurrent(lifetimeRef.current, lifetimeToken) &&
          canMutateSuperChecklistNote(application, visibleNote)
          ? { ok: true, leaseId: visibleLeaseId }
          : { ok: false, reason: 'The open source note editor is not ready for this action.' }
      }

      const registeredOwner = getTodoChecklistEditorOwner(application)
      if (registeredOwner && ownerRef.current !== registeredOwner) {
        ownerRef.current = registeredOwner
      }
      const current = ownerRef.current
      if (
        current &&
        current.application === application &&
        current.generation === lifetimeToken.generation &&
        current.noteUuid === noteUuid
      ) {
        const ready = await waitForActiveChecklistMutationBridge(application, noteUuid, {
          leaseId: current.leaseId,
          timeoutMs: TODO_OWNER_BRIDGE_TIMEOUT_MS,
          signal,
        })
        if (!ready || signal.aborted) {
          if (!current.retainOnFailure) {
            closeOwnerImmediately(current)
          }
          return { ok: false, reason: 'The source note editor did not become ready in time.' }
        }
        const note = application.items.findItem<SNNote>(noteUuid)
        return lifetimeIsCurrent(lifetimeRef.current, lifetimeToken) && canMutateSuperChecklistNote(application, note)
          ? { ok: true, leaseId: current.leaseId, detachedOwner: current }
          : { ok: false, reason: 'This todo is unavailable or read-only.' }
      }

      if (current) {
        try {
          // This strict close proves local persistence and the exact provider
          // flush before another note is allowed to own the detached editor.
          await current.application.itemControllerGroup.flushAndCloseDetachedNoteController(current.controller)
        } catch {
          current.retainOnFailure = true
          return { ok: false, reason: 'The previous todo update could not be saved safely.' }
        }
        clearOwnedControllerState(current)
      }

      if (signal.aborted || !lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
        return { ok: false, reason: 'The account changed before the action could run.' }
      }
      const note = application.items.findItem<SNNote>(noteUuid)
      if (!canMutateSuperChecklistNote(application, note)) {
        return { ok: false, reason: 'This todo is unavailable or read-only.' }
      }

      let detachedController: NoteViewController
      let created: TodoChecklistEditorOwnerState | undefined
      try {
        detachedController = await application.itemControllerGroup.createDetachedNoteController(note, (controller) => {
          const currentNote = application.items.findItem<SNNote>(noteUuid)
          if (!canMutateSuperChecklistNote(application, currentNote)) {
            throw new Error('The source note authorization changed while its editor was loading.')
          }
          created = {
            application,
            generation: lifetimeToken.generation,
            noteUuid,
            leaseId: createChecklistTodoId(),
            controller,
          }
          ownerRef.current = created
          try {
            publishTodoChecklistEditorOwner(created)
          } catch (error) {
            ownerRef.current = getTodoChecklistEditorOwner(application)
            created = undefined
            throw error
          }
          return () => {
            if (!created) {
              return
            }
            revokeChecklistMutationBridge(application, noteUuid, created.leaseId)
            if (ownerRef.current === created) {
              ownerRef.current = undefined
            }
            clearTodoChecklistEditorOwner(application, created)
          }
        })
      } catch {
        return { ok: false, reason: 'The source note editor could not be prepared for management.' }
      }
      if (signal.aborted || !lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
        application.itemControllerGroup.closeDetachedNoteControllerImmediately(detachedController)
        return { ok: false, reason: 'The account changed before the action could run.' }
      }

      if (!created) {
        application.itemControllerGroup.closeDetachedNoteControllerImmediately(detachedController)
        return { ok: false, reason: 'The source note editor could not claim exclusive ownership.' }
      }

      const ready = await waitForActiveChecklistMutationBridge(application, noteUuid, {
        leaseId: created.leaseId,
        timeoutMs: TODO_OWNER_BRIDGE_TIMEOUT_MS,
        signal,
      })
      if (!ready || signal.aborted) {
        // No mutation has run through a newly-created owner, so a cold-load
        // timeout has no unsent authoritative state to retain.
        closeOwnerImmediately(created)
        return { ok: false, reason: 'The source note editor did not become ready in time.' }
      }
      const currentNote = application.items.findItem<SNNote>(noteUuid)
      return ownerRef.current === created &&
        lifetimeIsCurrent(lifetimeRef.current, lifetimeToken) &&
        canMutateSuperChecklistNote(application, currentNote)
        ? { ok: true, leaseId: created.leaseId, detachedOwner: created }
        : { ok: false, reason: 'This todo is unavailable or read-only.' }
    },
    [application, clearOwnedControllerState, clearOwnerIdleTimer, closeOwnerImmediately],
  )

  const scheduleOwnerIdleRelease = useCallback(
    (expected: TodoChecklistEditorOwnerState) => {
      clearOwnerIdleTimer()
      ownerIdleTimeout.current = setTimeout(() => {
        ownerIdleTimeout.current = undefined
        void enqueueNoteAction(async () => {
          if (ownerRef.current !== expected) {
            return
          }
          try {
            await expected.application.itemControllerGroup.flushAndCloseDetachedNoteController(expected.controller)
            clearOwnedControllerState(expected)
          } catch {
            // Fail closed and keep the exact owner mounted for a later retry.
            expected.retainOnFailure = true
          }
        })
      }, TODO_OWNER_IDLE_RELEASE_MS)
    },
    [clearOwnedControllerState, clearOwnerIdleTimer, enqueueNoteAction],
  )

  const runThroughOwner = useCallback(
    async (
      noteUuid: string,
      target: SuperChecklistTodoTarget,
      patch: SuperChecklistTodoPatch,
      lifetimeToken: TodoViewLifetimeToken,
    ): Promise<TodoActionResult> => {
      if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
        return { ok: false, reason: 'The account changed before the action could run.' }
      }
      const controller = new AbortController()
      ownerWaits.current.add(controller)
      try {
        let ready = await ensureOwner(noteUuid, lifetimeToken, controller.signal)
        if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          return { ok: false, reason: 'The account changed before the action could run.' }
        }
        if (!ready.ok) {
          return ready
        }
        let result = await applyTodoPatch(application, noteUuid, ready.leaseId, target, patch)
        if (!result.ok && result.retryAcquire && !controller.signal.aborted) {
          if (ready.detachedOwner && ownerRef.current === ready.detachedOwner) {
            closeOwnerImmediately(ready.detachedOwner)
          }
          ready = await ensureOwner(noteUuid, lifetimeToken, controller.signal)
          if (!ready.ok) {
            return ready
          }
          result = await applyTodoPatch(application, noteUuid, ready.leaseId, target, patch)
        }
        if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          return { ok: false, reason: 'The account changed before the action could run.' }
        }
        if (result.ok && ready.detachedOwner && ownerRef.current === ready.detachedOwner) {
          scheduleOwnerIdleRelease(ready.detachedOwner)
        } else if (
          !result.ok &&
          result.retainOwner &&
          ready.detachedOwner &&
          ownerRef.current === ready.detachedOwner
        ) {
          ready.detachedOwner.retainOnFailure = true
        }
        return result
      } finally {
        ownerWaits.current.delete(controller)
      }
    },
    [application, closeOwnerImmediately, ensureOwner, scheduleOwnerIdleRelease],
  )

  const recompute = useCallback(() => {
    const lifetime = lifetimeRef.current
    if (lifetime.application === application && lifetime.dataReady) {
      setStoredGroups({ application, generation: lifetime.generation, groups: readGroups() })
    }
  }, [application, readGroups])

  // Reset all application-bound state immediately if the signed-in application
  // instance changes; selections must never bleed into another account/session.
  useEffect(() => {
    for (const controller of ownerWaits.current) {
      controller.abort()
    }
    ownerWaits.current.clear()
    actionQueue.current = Promise.resolve()
    lifetimeRef.current.dataReady = true
    setSelectedKeys(new Set())
    setBusyKeys(new Set())
    setBulkBusy(false)
    setActionError(undefined)
    recompute()
  }, [application, recompute])

  // Throttled recompute from local item state — no server polling.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const scheduleRecompute = () => {
      const lifetime = lifetimeRef.current
      if (lifetime.application !== application || !lifetime.dataReady) {
        return
      }
      const token = captureLifetime(lifetime)
      if (throttleTimeout) {
        pending = true
        return
      }
      if (lifetimeIsCurrent(lifetimeRef.current, token)) {
        recompute()
      }
      throttleTimeout = setTimeout(() => {
        throttleTimeout = undefined
        if (pending && lifetimeIsCurrent(lifetimeRef.current, token)) {
          pending = false
          recompute()
        }
      }, RECOMPUTE_THROTTLE_MS)
    }

    const invalidatePrincipal = (dataReady: boolean) => {
      const lifetime = lifetimeRef.current
      lifetime.generation += 1
      lifetime.dataReady = dataReady
      actionQueue.current = Promise.resolve()
      for (const controller of ownerWaits.current) {
        controller.abort()
      }
      ownerWaits.current.clear()
      closeOwnerImmediately()
      pending = false
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
        throttleTimeout = undefined
      }
      setStoredGroups({ application, generation: lifetime.generation, groups: [] })
      setSelectedKeys(new Set())
      setBusyKeys(new Set())
      setBulkBusy(false)
      setActionError(undefined)
      setDueDrafts(new Map())
    }

    const removeItemObserver = application.items.streamItems([ContentType.TYPES.Note], scheduleRecompute)
    const removeApplicationObserver = application.addEventObserver(async (event) => {
      if (event === ApplicationEvent.SignedIn || event === ApplicationEvent.SignedOut) {
        invalidatePrincipal(false)
        return
      }
      if (
        event === ApplicationEvent.KeyStatusChanged ||
        event === ApplicationEvent.UnprotectedSessionBegan ||
        event === ApplicationEvent.UnprotectedSessionExpired ||
        event === ApplicationEvent.UserRolesChanged ||
        event === ApplicationEvent.FeaturesAvailabilityChanged
      ) {
        invalidatePrincipal(true)
        scheduleRecompute()
        return
      }
      if (
        event === ApplicationEvent.Launched ||
        event === ApplicationEvent.LocalDataLoaded ||
        event === ApplicationEvent.MajorDataChange ||
        event === ApplicationEvent.CompletedFullSync
      ) {
        lifetimeRef.current.dataReady = true
        scheduleRecompute()
      }
    })

    return () => {
      removeItemObserver()
      removeApplicationObserver()
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
      }
    }
  }, [application, closeOwnerImmediately, recompute])

  useEffect(() => {
    setSelectedKeys((selected) =>
      pruneTodoSelection(
        selected,
        groups.filter((group) => canManageGroup(application, group)),
      ),
    )
  }, [application, groups])

  useEffect(() => {
    const waits = ownerWaits.current
    return () => {
      if (lifetimeRef.current.application === application) {
        lifetimeRef.current.generation += 1
        lifetimeRef.current.dataReady = false
      }
      clearOwnerIdleTimer()
      for (const controller of waits) {
        controller.abort()
      }
      waits.clear()
      ownerRef.current = undefined

      // The persistent host remains mounted above TodoView. Drain the already
      // serialized action queue, then release its exact controller only after
      // strict local persistence and provider flush have completed.
      const queuedActions = actionQueue.current
      void releaseTodoChecklistEditorOwnerAfter(application, queuedActions)
    }
  }, [application, clearOwnerIdleTimer])

  const hasDeadline = useMemo(() => groups.some((group) => group.items.some((item) => item.dueAt)), [groups])
  useEffect(() => {
    if (!hasDeadline) {
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), CHECKLIST_DUE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [hasDeadline])

  const total = useMemo(() => totalTodoProgress(groups), [groups])

  const selectedTodos = useMemo(() => {
    const selected: ManagedTodo[] = []
    for (const group of groups) {
      for (const item of group.items) {
        const key = selectableTodoKey(group, item)
        if (key && selectedKeys.has(key)) {
          selected.push({ group, item, key })
        }
      }
    }
    return selected
  }, [groups, selectedKeys])

  const openNote = useCallback(
    (uuid: string) => {
      const lifetimeToken = captureLifetime(lifetimeRef.current)
      void enqueueNoteAction(async () => {
        const currentOwner = ownerRef.current
        if (currentOwner) {
          try {
            await currentOwner.application.itemControllerGroup.flushAndCloseDetachedNoteController(
              currentOwner.controller,
            )
          } catch {
            if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
              setActionError('The current todo update could not be saved before opening its source note.')
            }
            return
          }
          clearOwnedControllerState(currentOwner)
        }
        if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          return
        }
        const note = application.items.findItem<SNNote>(uuid)
        if (!note || !canDisplayTodoNote(application, note)) {
          return
        }
        application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
        await application.itemListController.selectItemUsingInstance(note, true)
        if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          return
        }
        let sourceController = application.itemControllerGroup.itemControllers.find(
          (controller) => controller.item.uuid === uuid,
        )
        if (!sourceController) {
          await application.itemListController.openNote(uuid)
          sourceController = application.itemControllerGroup.itemControllers.find(
            (controller) => controller.item.uuid === uuid,
          )
        }
        if (sourceController) {
          application.itemControllerGroup.setActiveItemController(sourceController)
        }
        // selectItemUsingInstance is intentionally a no-op for an already
        // selected note, so explicitly hand the editor column back from Todos.
        application.paneController.setActiveViewTab(undefined)
        application.paneController.presentPane(AppPaneId.Editor)
      }).catch(() => {
        if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          setActionError('The source note could not be opened.')
        }
      })
    },
    [application, clearOwnedControllerState, enqueueNoteAction],
  )

  const closeTodos = useCallback(() => {
    const lifetimeToken = captureLifetime(lifetimeRef.current)
    void enqueueNoteAction(async () => {
      const current = ownerRef.current
      if (current) {
        try {
          await current.application.itemControllerGroup.flushAndCloseDetachedNoteController(current.controller)
        } catch {
          if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
            setActionError('The current todo update could not be saved before closing Todos.')
          }
          return
        }
        clearOwnedControllerState(current)
      }
      if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
        application.paneController.closeViewTab(AppPaneId.Todos)
      }
    })
  }, [application, clearOwnedControllerState, enqueueNoteAction])

  const applyOne = useCallback(
    async (group: NoteTodos, item: TodoItem, patch: SuperChecklistTodoPatch) => {
      const lifetimeToken = captureLifetime(lifetimeRef.current)
      const target = todoTarget(item)
      if (!target || !canManageGroup(application, group)) {
        setActionError('Open the source note to manage this todo.')
        return false
      }
      const busyKey = selectableTodoKey(group, item) ?? `${group.note.uuid}:${item.id}`
      setBusyKeys((current) => new Set(current).add(busyKey))
      setActionError(undefined)
      setDueDrafts(new Map())
      try {
        const result = await enqueueNoteAction(() => runThroughOwner(group.note.uuid, target, patch, lifetimeToken))
        if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          return false
        }
        if (!result.ok) {
          setActionError(result.reason)
          return false
        }
        recompute()
        return true
      } finally {
        if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          setBusyKeys((current) => {
            const next = new Set(current)
            next.delete(busyKey)
            return next
          })
        }
      }
    },
    [application, enqueueNoteAction, recompute, runThroughOwner],
  )

  const toggleSelection = useCallback(
    async (group: NoteTodos, item: TodoItem, selected: boolean) => {
      const lifetimeToken = captureLifetime(lifetimeRef.current)
      const existingKey = selectableTodoKey(group, item)
      if (!selected) {
        if (existingKey) {
          setSelectedKeys((current) => {
            const next = new Set(current)
            next.delete(existingKey)
            return next
          })
        }
        return
      }
      if (existingKey) {
        setSelectedKeys((current) => new Set(current).add(existingKey))
        return
      }

      const target = todoTarget(item)
      if (!target || !canManageGroup(application, group)) {
        setActionError('Open the source note to manage this todo.')
        return
      }
      const busyKey = `${group.note.uuid}:${item.id}`
      setBusyKeys((current) => new Set(current).add(busyKey))
      try {
        const result = await enqueueNoteAction(() => runThroughOwner(group.note.uuid, target, {}, lifetimeToken))
        if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          return
        }
        if (!result.ok || !result.todoId) {
          setActionError(result.ok ? 'The todo identity could not be saved.' : result.reason)
          return
        }
        setSelectedKeys((current) => new Set(current).add(todoSelectionKey(group.note.uuid, result.todoId!)))
        recompute()
      } finally {
        if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          setBusyKeys((current) => {
            const next = new Set(current)
            next.delete(busyKey)
            return next
          })
        }
      }
    },
    [application, enqueueNoteAction, recompute, runThroughOwner],
  )

  const applyBulk = useCallback(
    async (patch: SuperChecklistTodoPatch) => {
      if (selectedTodos.length === 0 || bulkBusy) {
        return
      }
      setBulkBusy(true)
      setActionError(undefined)
      const lifetimeToken = captureLifetime(lifetimeRef.current)
      const succeeded = new Set<string>()
      let firstError: string | undefined
      try {
        // Deliberately sequential: several selected tasks can share one live
        // editor, and ordered bridge mutations preserve the user's action order.
        for (const { group, item, key } of selectedTodos) {
          if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
            return
          }
          const target = todoTarget(item)
          if (!target || !canManageGroup(application, group)) {
            firstError ??= 'One or more selected todos became read-only.'
            continue
          }
          const result = await enqueueNoteAction(() => runThroughOwner(group.note.uuid, target, patch, lifetimeToken))
          if (!lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
            return
          }
          if (result.ok) {
            succeeded.add(key)
          } else {
            firstError ??= result.reason
          }
        }
        setSelectedKeys((current) => new Set([...current].filter((key) => !succeeded.has(key))))
        setActionError(firstError)
        recompute()
      } finally {
        if (lifetimeIsCurrent(lifetimeRef.current, lifetimeToken)) {
          setBulkBusy(false)
        }
      }
    },
    [application, bulkBusy, enqueueNoteAction, recompute, runThroughOwner, selectedTodos],
  )

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'border-border bg-default flex h-full flex-col overflow-hidden border-l')}
    >
      <div className="border-border bg-contrast flex items-center justify-between border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="tasks" className="text-info flex-shrink-0" />
          <span className="text-base font-bold">Todos</span>
          {total.total > 0 && (
            <span className="ml-2 hidden sm:block">
              <ProgressBar completed={total.completed} total={total.total} />
            </span>
          )}
        </div>
        <button className="hover:bg-default rounded p-1" onClick={closeTodos} aria-label="Close todos" title="Close">
          <Icon type="close" />
        </button>
      </div>

      {selectedTodos.length > 0 && (
        <div className="border-border bg-contrast flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <span className="text-xs font-semibold">{selectedTodos.length} selected</span>
          <button
            type="button"
            className="border-border hover:bg-default rounded border px-2 py-1 text-xs"
            disabled={bulkBusy}
            onClick={() => void applyBulk({ checked: true })}
          >
            Complete
          </button>
          <button
            type="button"
            className="border-border hover:bg-default rounded border px-2 py-1 text-xs"
            disabled={bulkBusy}
            onClick={() => void applyBulk({ checked: false })}
          >
            Reopen
          </button>
          <button
            type="button"
            className="border-border hover:bg-default rounded border px-2 py-1 text-xs"
            disabled={bulkBusy}
            onClick={() => void applyBulk({ dueAt: null })}
          >
            Clear dates
          </button>
          <button
            type="button"
            className="text-passive-1 hover:text-text ml-auto px-1 text-xs"
            disabled={bulkBusy}
            onClick={() => setSelectedKeys(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {actionError && (
        <div className="border-danger text-danger border-b px-4 py-2 text-xs" role="alert">
          {actionError}
        </div>
      )}

      <div className="flex-grow overflow-y-auto p-4">
        {groups.length === 0 ? (
          <div className="text-passive-1 px-4 py-10 text-center text-sm">
            No todos yet. Add a checklist in a Super note or an Advanced Checklist note.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => {
              const manageable = canManageGroup(application, group)
              return (
                <section
                  key={group.note.uuid}
                  className="border-border bg-default overflow-hidden rounded-md border"
                  aria-label={group.note.title?.trim() || 'Untitled'}
                >
                  <div className="border-border bg-contrast flex items-center justify-between gap-2 border-b px-4 py-2">
                    <button
                      className="hover:text-info flex min-w-0 flex-col text-left"
                      onClick={() => openNote(group.note.uuid)}
                      title="Open source note"
                    >
                      <span className="text-text truncate text-sm font-bold">
                        {group.note.title?.trim() || 'Untitled'}
                      </span>
                      <span className="text-passive-1 text-[0.625rem] tracking-wide uppercase">
                        {SOURCE_LABEL[group.source]}
                      </span>
                    </button>
                    <ProgressBar completed={group.completed} total={group.total} />
                  </div>
                  <ul className="divide-border divide-y px-4">
                    {group.items.map((item) => {
                      const selectionKey = selectableTodoKey(group, item)
                      const busyKey = selectionKey ?? `${group.note.uuid}:${item.id}`
                      const busy = bulkBusy || busyKeys.has(busyKey)
                      const due = item.dueAt ? formatChecklistDue(item.dueAt, item.checked, now) : undefined
                      return (
                        <li key={item.id} className="flex items-start gap-2 py-2">
                          {manageable ? (
                            <input
                              type="checkbox"
                              className="mt-1 flex-shrink-0"
                              checked={selectionKey ? selectedKeys.has(selectionKey) : false}
                              disabled={busy}
                              aria-label={`Select ${item.text}`}
                              onChange={(event) => void toggleSelection(group, item, event.currentTarget.checked)}
                            />
                          ) : (
                            <span className="w-3.5 flex-shrink-0" />
                          )}
                          {manageable ? (
                            <button
                              type="button"
                              className="mt-0.5 flex-shrink-0 rounded focus-visible:outline focus-visible:outline-2"
                              disabled={busy}
                              aria-label={item.checked ? `Reopen ${item.text}` : `Mark ${item.text} complete`}
                              onClick={() => void applyOne(group, item, { checked: !item.checked })}
                            >
                              <Icon
                                type={item.checked ? 'check-circle-filled' : 'check-circle'}
                                size="small"
                                className={item.checked ? 'text-success' : 'text-neutral'}
                              />
                            </button>
                          ) : (
                            <Icon
                              type={item.checked ? 'check-circle-filled' : 'check-circle'}
                              size="small"
                              className={classNames(
                                'mt-0.5 flex-shrink-0',
                                item.checked ? 'text-success' : 'text-neutral',
                              )}
                            />
                          )}
                          <div className="min-w-0 flex-grow">
                            <div
                              className={classNames(
                                'text-sm',
                                item.checked ? 'text-passive-1 line-through' : 'text-text',
                              )}
                            >
                              {item.text}
                            </div>
                            {due && (
                              <div
                                className={classNames(
                                  'mt-0.5 text-xs tabular-nums',
                                  due.state === 'overdue' ? 'text-danger' : 'text-passive-1',
                                )}
                                title={due.accessibleLabel}
                              >
                                Due {due.dateLabel} · {due.relativeLabel}
                              </div>
                            )}
                            {manageable && (
                              <div className="mt-1 flex flex-wrap items-center gap-1">
                                <input
                                  type="datetime-local"
                                  className="border-border bg-contrast text-text max-w-full rounded border px-1.5 py-0.5 text-xs"
                                  value={todoDueInputValue(dueDrafts, busyKey, item.dueAt)}
                                  disabled={busy}
                                  aria-busy={dueDrafts.has(busyKey)}
                                  aria-label={`Due date and time for ${item.text}`}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value
                                    const dueAt = value ? checklistDueAtFromLocalInput(value) : undefined
                                    if (value && !dueAt) {
                                      setActionError('Choose a valid due date and time.')
                                      return
                                    }
                                    setDueDrafts((current) => setTodoDueDraft(current, busyKey, value))
                                    void applyOne(group, item, { dueAt: dueAt ?? null }).finally(() => {
                                      setDueDrafts((current) => clearTodoDueDraft(current, busyKey))
                                    })
                                  }}
                                />
                                {dueDrafts.has(busyKey) && (
                                  <span className="text-passive-1 text-xs" role="status">
                                    Saving date…
                                  </span>
                                )}
                                {item.dueAt && (
                                  <button
                                    type="button"
                                    className="text-danger px-1 text-xs hover:underline disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => void applyOne(group, item, { dueAt: null })}
                                  >
                                    Clear date
                                  </button>
                                )}
                              </div>
                            )}
                            {!manageable && group.source === 'advanced-checklist' && (
                              <span className="text-passive-1 mt-1 block text-xs">
                                Managed by the Advanced Checklist editor
                              </span>
                            )}
                            {!manageable && group.source === 'super' && (
                              <span className="text-passive-1 mt-1 block text-xs">This todo is read-only</span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="text-passive-1 hover:text-info flex-shrink-0 rounded p-1"
                            aria-label={`Open source note for ${item.text}`}
                            title="Open source note"
                            onClick={() => openNote(group.note.uuid)}
                          >
                            <Icon type="open-in" size="small" />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>
      {children}
    </div>
  )
})

TodoView.displayName = 'TodoView'

export default observer(TodoView)
