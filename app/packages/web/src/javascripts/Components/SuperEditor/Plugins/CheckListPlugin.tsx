import {
  $insertList,
  $isListItemNode,
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  ListItemNode,
  ListNode,
} from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { calculateZoomLevel, isHTMLElement, mergeRegister } from '@lexical/utils'
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  type LexicalNode,
} from 'lexical'
import { useEffect } from 'react'
import { useApplication } from '../../ApplicationProvider'
import { getPrimaryModifier } from '@standardnotes/ui-services'
import { $reorderCheckListForItem } from './CheckListAutoMovePlugin/reorderCheckList'
import { getChecklistAutoMoveEnabled } from './CheckListAutoMovePlugin/autoMoveSetting'
import { ApplicationEvent, SNNote } from '@standardnotes/snjs'
import {
  CHECKLIST_DUE_ACTION_ATTR,
  CHECKLIST_DUE_INPUT_ATTR,
  CHECKLIST_DUE_SHELL_ATTR,
  CHECKLIST_RECURRENCE_PRESET_ATTR,
  readChecklistScheduleControl,
  removeChecklistDueShell,
  setActiveChecklistItemElement,
  setChecklistSchedulePanelOpen,
  setChecklistScheduleStatus,
  syncChecklistDueShell,
  syncChecklistRecurrenceCustomVisibility,
} from '../Checklist/ChecklistDueControls'
import { CHECKLIST_DUE_TICK_MS, normalizeChecklistDueAt } from '../Checklist/checklistDueDate'
import {
  createChecklistRecurrence,
  normalizeChecklistRecurrence,
  type ChecklistRecurrence,
} from '../Checklist/checklistRecurrence'
import {
  $applyChecklistEditorMutation,
  $getChecklistScheduleSnapshot,
  $getChecklistItems,
  $setChecklistItemScheduleIfCurrent,
  $toggleChecklistItemChecked,
  canAttemptRecurringChecklistCompletion,
  type ChecklistScheduleSnapshot,
} from '../Checklist/ChecklistEditorMutations'
import {
  ChecklistEditorRole,
  isChecklistMutationDurabilityReady,
  notifyChecklistMutationBridgeReadiness,
  persistChecklistMutationExactlyOnce,
  registerChecklistMutationBridge,
} from '../Checklist/ChecklistMutationBridge'
import {
  $activateChecklistRecurringSchedule,
  $ensureChecklistTodoId,
  $getChecklistDueAt,
  $getChecklistRecurrence,
  $getChecklistTodoId,
  $isChecklistItemNode,
  $normalizeChecklistItemMetadata,
} from '../Lexical/Nodes/ChecklistItemNode'
import { resolveNoteEncryptionIdentity } from '../Collaboration/CollaborationKeyDerivation'
import { canMutateSuperChecklistNote } from '../../TodoAggregate/todoAuthorization'
import {
  captureChecklistSessionPrincipal,
  checklistEncryptionIdentityMatches,
  checklistSessionPrincipalMatches,
} from '../Checklist/checklistSessionPrincipal'

type CheckListPluginProps = {
  noteUuid?: string
  ownerLeaseId?: string
  flushChanges?: () => void
  persistChanges?: () => Promise<void>
  ownerRole?: ChecklistEditorRole
  isOwnerActive?: () => boolean
  onOwnerReady?: () => void
}

export function CheckListPlugin({
  noteUuid,
  ownerLeaseId,
  flushChanges,
  persistChanges,
  ownerRole = 'interactive',
  isOwnerActive,
  onOwnerReady,
}: CheckListPluginProps): null {
  const application = useApplication()
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    let disposed = false
    let recurringActivationQueued = false
    const pendingRecurringActivationKeys = new Set<string>()

    const normalizeIfEditable = () => {
      if (!editor.isEditable()) {
        return
      }
      let changed = false
      editor.update(
        () => {
          changed = $normalizeChecklistItemMetadata() > 0
        },
        { discrete: true },
      )
      if (changed) {
        flushChanges?.()
      }
    }

    const flushPendingRecurringActivations = () => {
      recurringActivationQueued = false
      if (disposed || !editor.isEditable() || pendingRecurringActivationKeys.size === 0) {
        pendingRecurringActivationKeys.clear()
        return
      }
      const keys = [...pendingRecurringActivationKeys]
      pendingRecurringActivationKeys.clear()
      let changed = false
      editor.update(
        () => {
          for (const key of keys) {
            const item = $getNodeByKey<ListItemNode>(key)
            if ($isChecklistItemNode(item)) {
              changed = $activateChecklistRecurringSchedule(item) || changed
            }
          }
        },
        { discrete: true },
      )
      if (changed) {
        flushChanges?.()
      }
    }

    const queueDirtyRecurringActivations = (
      editorState: Parameters<Parameters<typeof editor.registerUpdateListener>[0]>[0]['editorState'],
      dirtyElements: Parameters<Parameters<typeof editor.registerUpdateListener>[0]>[0]['dirtyElements'],
    ) => {
      editorState.read(
        () => {
          for (const key of dirtyElements.keys()) {
            const item = $getNodeByKey<ListItemNode>(key)
            if ($isChecklistItemNode(item) && item.getChecked() && $getChecklistRecurrence(item)) {
              pendingRecurringActivationKeys.add(key)
            }
          }
        },
        { editor },
      )
      if (pendingRecurringActivationKeys.size > 0 && !recurringActivationQueued) {
        recurringActivationQueued = true
        queueMicrotask(flushPendingRecurringActivations)
      }
    }

    normalizeIfEditable()

    return mergeRegister(
      () => {
        disposed = true
        pendingRecurringActivationKeys.clear()
      },
      editor.registerUpdateListener(({ editorState, dirtyElements }) =>
        queueDirtyRecurringActivations(editorState, dirtyElements),
      ),
      editor.registerNodeTransform(ListItemNode, (item) => {
        if (editor.isEditable() && $isChecklistItemNode(item)) {
          if (!$getChecklistTodoId(item)) {
            $ensureChecklistTodoId(item)
          }
          $activateChecklistRecurringSchedule(item)
        }
      }),
      editor.registerNodeTransform(ListNode, (list) => {
        if (!editor.isEditable() || list.getListType() !== 'check') {
          return
        }
        for (const child of list.getChildren()) {
          if ($isChecklistItemNode(child) && !$getChecklistTodoId(child)) {
            $ensureChecklistTodoId(child)
          }
          if ($isChecklistItemNode(child)) {
            $activateChecklistRecurringSchedule(child)
          }
        }
      }),
      editor.registerEditableListener((editable) => {
        notifyChecklistMutationBridgeReadiness(application)
        if (editable) {
          normalizeIfEditable()
        }
      }),
    )
  }, [application, editor, flushChanges])

  useEffect(() => {
    if (!noteUuid || !ownerLeaseId) {
      return
    }
    const mountedNote = application.items.findItem<SNNote>(noteUuid)
    const mountedSession = captureChecklistSessionPrincipal(application.sessions)
    let mountedIdentity: ReturnType<typeof resolveNoteEncryptionIdentity>
    try {
      mountedIdentity = mountedNote ? resolveNoteEncryptionIdentity(application, mountedNote) : undefined
    } catch {
      mountedIdentity = undefined
    }
    let authorizationBoundaryChanged = false
    const removeAuthorizationBoundaryObserver = application.addEventObserver(async (event) => {
      if (
        event === ApplicationEvent.SignedIn ||
        event === ApplicationEvent.SignedOut ||
        event === ApplicationEvent.KeyStatusChanged
      ) {
        authorizationBoundaryChanged = true
      }
    })

    const isExactOwnerAuthorizedAndActive = () => {
      try {
        const currentNote = application.items.findItem<SNNote>(noteUuid)
        const currentSession = captureChecklistSessionPrincipal(application.sessions)
        const currentIdentity = currentNote ? resolveNoteEncryptionIdentity(application, currentNote) : undefined
        return (
          !authorizationBoundaryChanged &&
          (isOwnerActive?.() ?? true) &&
          editor.isEditable() &&
          typeof persistChanges === 'function' &&
          canMutateSuperChecklistNote(application, currentNote) &&
          checklistSessionPrincipalMatches(mountedSession, currentSession) &&
          (!mountedSession.signedIn || Boolean(mountedIdentity)) &&
          (!mountedIdentity || checklistEncryptionIdentityMatches(mountedIdentity, currentIdentity))
        )
      } catch {
        return false
      }
    }
    const isExactOwnerReady = () => {
      const ready =
        isExactOwnerAuthorizedAndActive() && isChecklistMutationDurabilityReady(application, noteUuid, ownerLeaseId)
      if (ready) {
        onOwnerReady?.()
      }
      return ready
    }

    const removeMutationBridge = registerChecklistMutationBridge(
      application,
      noteUuid,
      ownerLeaseId,
      async ({ target, patch }) => {
        if (!isExactOwnerReady()) {
          return { status: 'rejected', reason: 'This todo is unavailable or read-only.' }
        }
        if (typeof patch.dueAt === 'string' && !normalizeChecklistDueAt(patch.dueAt)) {
          return { status: 'rejected', reason: 'Choose a valid due date and time.' }
        }
        if (patch.recurrence && !normalizeChecklistRecurrence(patch.recurrence)) {
          return { status: 'rejected', reason: 'Choose a valid recurrence.' }
        }

        let result: ReturnType<typeof $applyChecklistEditorMutation> = { matched: false, changed: false }
        editor.update(
          () => {
            result = $applyChecklistEditorMutation(target, patch)
          },
          { discrete: true },
        )
        if (!result.matched) {
          return { status: 'rejected', reason: 'This todo changed before the action could be applied.' }
        }
        try {
          // A discrete update has synchronously notified OnChangePlugin by this
          // point; force its exact post-mutation state through the serialize path.
          flushChanges?.()
          const stillAuthorizedAndActive = await persistChecklistMutationExactlyOnce(
            persistChanges as () => Promise<void>,
            isExactOwnerAuthorizedAndActive,
          )
          if (!stillAuthorizedAndActive) {
            return {
              status: 'rejected',
              reason: 'The source note editor changed while the update was being saved.',
              retryAcquire: true,
            }
          }
        } catch {
          return {
            status: 'rejected',
            reason: 'The checklist update could not be saved safely.',
            retainOwner: true,
          }
        }
        return { status: 'updated', todoId: result.todoId, changed: result.changed }
      },
      isExactOwnerReady,
      { role: ownerRole, isActive: isOwnerActive },
    )
    return () => {
      removeMutationBridge()
      removeAuthorizationBoundaryObserver()
    }
  }, [
    application,
    editor,
    flushChanges,
    isOwnerActive,
    noteUuid,
    onOwnerReady,
    ownerLeaseId,
    ownerRole,
    persistChanges,
  ])

  useEffect(() => {
    const openScheduleSnapshots = new WeakMap<HTMLElement, ChecklistScheduleSnapshot>()

    const refreshDueControls = (dirtyEntries?: Iterable<[string, boolean]>) => {
      const liveElements = new Set<HTMLElement>()
      editor.read(() => {
        const items = new Set(dirtyEntries ? [] : $getChecklistItems())
        if (dirtyEntries) {
          for (const [key, intentionallyDirty] of dirtyEntries) {
            if (!intentionallyDirty) {
              continue
            }
            const node = $getNodeByKey(key)
            if ($isChecklistItemNode(node)) {
              items.add(node)
            } else if ($isListNode(node)) {
              if (node.getListType() === 'check') {
                for (const child of node.getChildren()) {
                  if ($isChecklistItemNode(child)) {
                    items.add(child)
                  }
                }
              } else {
                editor
                  .getElementByKey(key)
                  ?.querySelectorAll<HTMLElement>(`:scope > li > [${CHECKLIST_DUE_SHELL_ATTR}]`)
                  .forEach((shell) => shell.parentElement && removeChecklistDueShell(shell.parentElement))
              }
            }
          }
        }
        for (const item of items) {
          const element = editor.getElementByKey(item.getKey())
          if (!element) {
            continue
          }
          liveElements.add(element)
          syncChecklistDueShell(
            element,
            $getChecklistDueAt(item),
            Boolean(item.getChecked()),
            editor.isEditable(),
            $getChecklistRecurrence(item),
          )
        }
      })
      if (!dirtyEntries) {
        const root = editor.getRootElement()
        root?.querySelectorAll<HTMLElement>(`[${CHECKLIST_DUE_SHELL_ATTR}]`).forEach((shell) => {
          const item = shell.parentElement
          if (item && !liveElements.has(item)) {
            removeChecklistDueShell(item)
          }
        })
      }
    }

    /**
     * Standard Red Notes: the schedule affordance is revealed only for the row
     * the user is "on". The caret is the primary trigger — it is the one signal
     * that works for keyboard users, who have no hover — so we mark the row
     * holding the selection anchor and let ChecklistDueControls re-derive every
     * shell's reveal state. (CSS layers hover/:focus-within on top for mouse
     * users; it is never the only path.) The whole selection is not used: with
     * a multi-row selection there is no single row you are "on", so we follow
     * the anchor, which is where the caret visually sits.
     */
    const refreshActiveChecklistItem = () => {
      const root = editor.getRootElement()
      if (!root) {
        return
      }
      let activeElement: HTMLElement | null = null
      editor.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) {
          return
        }
        let node: LexicalNode | null = selection.anchor.getNode()
        while (node) {
          if ($isChecklistItemNode(node)) {
            activeElement = editor.getElementByKey(node.getKey())
            return
          }
          node = node.getParent()
        }
      })
      setActiveChecklistItemElement(root, activeElement)
    }

    const readScheduleSnapshot = (itemElement: HTMLElement): ChecklistScheduleSnapshot | undefined =>
      editor.read(() => {
        const node = $getNearestNodeFromDOMNode(itemElement)
        return $isChecklistItemNode(node) ? $getChecklistScheduleSnapshot(node) : undefined
      })

    const updateSchedule = (
      itemElement: HTMLElement,
      expected: ChecklistScheduleSnapshot,
      dueAt: string | undefined,
      recurrence?: ChecklistRecurrence,
    ): boolean => {
      if (!editor.isEditable()) {
        return false
      }
      let matched = false
      let changed = false
      editor.update(
        () => {
          const node = $getNearestNodeFromDOMNode(itemElement)
          if ($isChecklistItemNode(node)) {
            const result = $setChecklistItemScheduleIfCurrent(node, expected, dueAt, recurrence)
            matched = result.matched
            changed = result.changed
            if (matched && !$getChecklistTodoId(node)) {
              $ensureChecklistTodoId(node)
              changed = true
            }
          }
        },
        { discrete: true },
      )
      if (matched && changed) {
        flushChanges?.()
      }
      return matched
    }

    const refreshAfterScheduleConflict = (shell: HTMLElement, itemElement: HTMLElement) => {
      setChecklistSchedulePanelOpen(shell, false)
      refreshDueControls()
      const latest = readScheduleSnapshot(itemElement)
      if (latest) {
        openScheduleSnapshots.set(shell, latest)
      }
      setChecklistSchedulePanelOpen(shell, true)
      setChecklistScheduleStatus(shell, 'Schedule changed elsewhere. Review the latest values and try again.')
      shell.querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_INPUT_ATTR}]`)?.focus()
    }

    const focusScheduleTrigger = (shell: HTMLElement) =>
      shell.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="edit-schedule"]`)?.focus()

    const handleClick = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      const action = target.closest<HTMLElement>(`[${CHECKLIST_DUE_ACTION_ATTR}]`)
      if (!action) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const shell = action.closest<HTMLElement>(`[${CHECKLIST_DUE_SHELL_ATTR}]`)
      const itemElement = shell?.parentElement
      if (!shell || !itemElement) {
        return
      }
      const actionName = action.getAttribute(CHECKLIST_DUE_ACTION_ATTR)
      if (actionName === 'edit-schedule') {
        if (action.getAttribute('aria-expanded') === 'true') {
          return
        }
        const snapshot = readScheduleSnapshot(itemElement)
        if (!snapshot) {
          return
        }
        openScheduleSnapshots.set(shell, snapshot)
        setChecklistScheduleStatus(shell)
        setChecklistSchedulePanelOpen(shell, true)
        shell.querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_INPUT_ATTR}]`)?.focus()
      } else if (actionName === 'cancel-schedule') {
        openScheduleSnapshots.delete(shell)
        setChecklistSchedulePanelOpen(shell, false)
        setChecklistScheduleStatus(shell)
        refreshDueControls()
        focusScheduleTrigger(shell)
      } else if (actionName === 'clear-schedule') {
        const expected = openScheduleSnapshots.get(shell)
        if (!expected || !updateSchedule(itemElement, expected, undefined)) {
          refreshAfterScheduleConflict(shell, itemElement)
          return
        }
        openScheduleSnapshots.delete(shell)
        setChecklistSchedulePanelOpen(shell, false)
        setChecklistScheduleStatus(shell)
        refreshDueControls()
        focusScheduleTrigger(shell)
      } else if (actionName === 'save-schedule') {
        const expected = openScheduleSnapshots.get(shell)
        if (!expected) {
          refreshAfterScheduleConflict(shell, itemElement)
          return
        }
        const schedule = readChecklistScheduleControl(shell, expected.dueAt)
        if (!schedule.ok) {
          setChecklistScheduleStatus(shell, schedule.reason)
          return
        }
        const recurrence = schedule.recurrenceChoice
          ? createChecklistRecurrence(schedule.recurrenceChoice, schedule.dueAt, expected.recurrence?.anchor.timeZone)
          : undefined
        if (schedule.recurrenceChoice && !recurrence) {
          setChecklistScheduleStatus(shell, 'This recurrence could not be created in the current time zone.')
          return
        }
        if (!updateSchedule(itemElement, expected, schedule.dueAt, recurrence)) {
          refreshAfterScheduleConflict(shell, itemElement)
          return
        }
        openScheduleSnapshots.delete(shell)
        setChecklistSchedulePanelOpen(shell, false)
        setChecklistScheduleStatus(shell)
        refreshDueControls()
        focusScheduleTrigger(shell)
      }
    }
    const handleChange = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.hasAttribute(CHECKLIST_RECURRENCE_PRESET_ATTR)) {
        return
      }
      event.stopPropagation()
      const shell = target.closest<HTMLElement>(`[${CHECKLIST_DUE_SHELL_ATTR}]`)
      if (shell) {
        syncChecklistRecurrenceCustomVisibility(shell)
      }
    }
    const stopDuePointer = (event: Event) => {
      const target = event.target
      if (target instanceof HTMLElement && target.closest(`[${CHECKLIST_DUE_SHELL_ATTR}]`)) {
        event.stopPropagation()
      }
    }

    const rootDisposer = editor.registerRootListener((rootElement, previousElement) => {
      if (previousElement) {
        previousElement.removeEventListener('click', handleClick)
        previousElement.removeEventListener('change', handleChange)
        previousElement.removeEventListener('pointerdown', stopDuePointer)
      }
      if (rootElement) {
        rootElement.addEventListener('click', handleClick)
        rootElement.addEventListener('change', handleChange)
        rootElement.addEventListener('pointerdown', stopDuePointer)
        refreshDueControls()
        refreshActiveChecklistItem()
      }
    })
    // Selection-only changes (arrow keys, clicking into another row) still
    // commit an editor state, so this listener is what moves the affordance
    // with the caret.
    const updateDisposer = editor.registerUpdateListener(({ dirtyElements }) => {
      refreshDueControls(dirtyElements.entries())
      refreshActiveChecklistItem()
    })
    const editableDisposer = editor.registerEditableListener(() => {
      refreshDueControls()
      refreshActiveChecklistItem()
    })
    const tick = window.setInterval(refreshDueControls, CHECKLIST_DUE_TICK_MS)

    return () => {
      rootDisposer()
      updateDisposer()
      editableDisposer()
      window.clearInterval(tick)
    }
  }, [editor, flushChanges])

  useEffect(() => {
    const primaryModifier = getPrimaryModifier(application.platform)
    const recentRecurringCompletions = new Map<string, number>()

    const $toggleWithRapidCompletionGuard = (node: ListItemNode, repeatedKeyboardEvent = false): boolean => {
      const attemptedAt = Date.now()
      const todoId = $ensureChecklistTodoId(node)
      const dueAt = $getChecklistDueAt(node)
      const recurrence = $getChecklistRecurrence(node)
      const isRecurringCompletion = !node.getChecked() && Boolean(dueAt && recurrence)
      if (
        !canAttemptRecurringChecklistCompletion(
          recentRecurringCompletions.get(todoId),
          attemptedAt,
          undefined,
          repeatedKeyboardEvent,
        )
      ) {
        return false
      }
      const changed = $toggleChecklistItemChecked(node, attemptedAt)
      if (isRecurringCompletion && changed) {
        recentRecurringCompletions.set(todoId, attemptedAt)
      }
      return changed
    }

    return mergeRegister(
      editor.registerCommand(
        INSERT_CHECK_LIST_COMMAND,
        () => {
          $insertList('check')
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerRootListener((rootElement, prevElement) => {
        function handleCheckItemEvent(event: PointerEvent, callback: () => void) {
          const target = event.target

          if (target === null || !isHTMLElement(target)) {
            return
          }

          if (target.closest(`[${CHECKLIST_DUE_SHELL_ATTR}]`)) {
            return
          }

          // Ignore clicks on LI that have nested lists
          const firstChild = target.firstChild

          if (
            firstChild != null &&
            isHTMLElement(firstChild) &&
            (firstChild.tagName === 'UL' || firstChild.tagName === 'OL')
          ) {
            return
          }

          const parentNode = target.parentNode
          // @ts-expect-error internal field
          if (!parentNode || parentNode.__lexicalListType !== 'check') {
            return
          }

          const rect = target.getBoundingClientRect()

          const listItemElementStyles = getComputedStyle(target)
          const paddingLeft = parseFloat(listItemElementStyles.paddingLeft) || 0
          const paddingRight = parseFloat(listItemElementStyles.paddingRight) || 0
          const lineHeight = parseFloat(listItemElementStyles.lineHeight) || 0

          const checkStyles = getComputedStyle(target, ':before')
          const checkWidth = parseFloat(checkStyles.width) || 0

          const pageX = event.pageX / calculateZoomLevel(target)

          const isWithinHorizontalThreshold =
            target.dir === 'rtl'
              ? pageX < rect.right && pageX > rect.right - paddingRight
              : pageX > rect.left && pageX < rect.left + (checkWidth || paddingLeft)

          const isWithinVerticalThreshold = event.clientY > rect.top && event.clientY < rect.top + lineHeight

          if (isWithinHorizontalThreshold && isWithinVerticalThreshold) {
            callback()
          }
        }

        function handleClick(event: Event) {
          handleCheckItemEvent(event as PointerEvent, () => {
            const isTouchEvent = (event as PointerEvent).pointerType === 'touch'
            if (!editor.isEditable()) {
              return
            }

            editor.update(
              () => {
                const domNode = event.target
                if (!(domNode instanceof HTMLElement)) {
                  return
                }

                const node = $getNearestNodeFromDOMNode(domNode)

                if (!$isListItemNode(node)) {
                  return
                }

                if ($isChecklistItemNode(node)) {
                  $ensureChecklistTodoId(node)
                }

                const isFocusWithinEditor = editor.getRootElement()?.contains(document.activeElement)
                if (!isTouchEvent && !isFocusWithinEditor) {
                  // on desktop, we want to focus & select the list item so that if you then press the up or down arrow keys,
                  // the caret moves in the editor instead of triggering the note navigation shortcuts.
                  // however on mobile, focusing the editor brings up the keyboard even if you just want to quickly toggle
                  // an item. the keyboard also causes a layout shift which might end up leading to an incorrect toggle.
                  node.selectStart()
                }

                const changed = $toggleWithRapidCompletionGuard(node)

                // Issue 3928: optionally relocate the just-toggled item so
                // completed tasks sink to the bottom and active ones bubble up.
                // Opt-in (default off) so existing behavior is unchanged. Done
                // here (on the toggle) rather than on every change so we never
                // fight the caret while the user types.
                if (changed && getChecklistAutoMoveEnabled()) {
                  $reorderCheckListForItem(node)
                }
              },
              {
                // without this lexical will reconcile the new selection to the dom and focus the editor causing the keyboard to show up
                tag: isTouchEvent ? SKIP_DOM_SELECTION_TAG : undefined,
              },
            )
          })
        }

        function handlePointerDown(event: PointerEvent) {
          handleCheckItemEvent(event, () => {
            // Prevents caret moving when clicking on check mark
            event.preventDefault()
          })
        }

        if (prevElement !== null) {
          prevElement.removeEventListener('click', handleClick)
          prevElement.removeEventListener('pointerdown', handlePointerDown)
        }

        if (rootElement !== null) {
          rootElement.addEventListener('click', handleClick)
          rootElement.addEventListener('pointerdown', handlePointerDown)
        }
      }),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!application.keyboardService.activeModifiers.has(primaryModifier)) {
            return false
          }
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return false
          }
          const focusNode = selection.focus.getNode()
          const parent = focusNode.getParent()
          const node = $isListItemNode(parent) ? parent : focusNode
          if (!$isListItemNode(node) || node.getParent<ListNode>()?.getListType() !== 'check') {
            return false
          }
          $ensureChecklistTodoId(node)
          const changed = $toggleWithRapidCompletionGuard(node, event?.repeat === true)
          if (changed && getChecklistAutoMoveEnabled()) {
            $reorderCheckListForItem(node)
          }
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
      application.keyboardService.registerExternalKeyboardShortcutHelpItem({
        platform: application.platform,
        modifiers: [primaryModifier],
        key: 'Enter',
        category: 'Super notes',
        description: 'Toggle checklist item',
      }),
    )
  }, [application.keyboardService, application.platform, editor])

  return null
}
