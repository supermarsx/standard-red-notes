import { WebApplication } from '@/Application/WebApplication'
import {
  ApplicationEvent,
  isLitePayload,
  isPayloadSourceRetrieved,
  NativeFeatureIdentifier,
  FeatureStatus,
  EditorLineHeightValues,
  WebAppEvent,
  LocalPrefKey,
  MutationType,
  NoteContent,
  NoteMutator,
  SNNote,
  PayloadEmitSource,
} from '@standardnotes/snjs'
import {
  CSSProperties,
  FocusEvent,
  FunctionComponent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { BlocksEditor } from './BlocksEditor'
import { BlocksEditorComposer } from './BlocksEditorComposer'
import { ItemSelectionPlugin } from './Plugins/ItemSelectionPlugin/ItemSelectionPlugin'
import FilePlugin from './Plugins/EncryptedFilePlugin/FilePlugin'
import { ErrorBoundary } from '@/Utils/ErrorBoundary'
import { LinkingController } from '@/Controllers/LinkingController'
import LinkingControllerProvider from '../../Controllers/LinkingControllerProvider'
import ItemBubblePlugin from './Plugins/ItemBubblePlugin/ItemBubblePlugin'
import { EditorReferenceChanges, NodeObserverPlugin } from './Plugins/NodeObserverPlugin/NodeObserverPlugin'
import { FilesController } from '@/Controllers/FilesController'
import FilesControllerProvider from '@/Controllers/FilesControllerProvider'
import { NoteViewController } from '../NoteView/Controller/NoteViewController'
import {
  ChangeContentCallbackPlugin,
  ChangeEditorFunction,
  registerLatestChangeEditorFunction,
} from './Plugins/ChangeContentCallback/ChangeContentCallback'
import { SUPER_SHOW_MARKDOWN_PREVIEW, getPrimaryModifier } from '@standardnotes/ui-services'
import { SuperNoteMarkdownPreview } from './SuperNoteMarkdownPreview'
import GetMarkdownPlugin, { GetMarkdownPluginInterface } from './Plugins/GetMarkdownPlugin/GetMarkdownPlugin'
import { useResponsiveEditorFontSize } from '@/Utils/getPlaintextFontSize'
import ReadonlyPlugin from './Plugins/ReadonlyPlugin/ReadonlyPlugin'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import AutoFocusPlugin from './Plugins/AutoFocusPlugin'
import { useLocalPreference } from '@/Hooks/usePreference'
import BlockPickerMenuPlugin from './Plugins/BlockPickerPlugin/BlockPickerPlugin'
import { EditorEventSource } from '@/Types/EditorEventSource'
import { ElementIds } from '@/Constants/ElementIDs'
import { NoteFromSelectionPlugin } from './Plugins/NoteFromSelectionPlugin'
import { useCollaborationRoomAccess } from './Collaboration/useCollaborationRoomAccess'
import { CollaborationRoomStatus, CollaborationStatusRegistry } from './Collaboration/CollaborationStatusRegistry'
import { flushChecklistMutationDurability } from './Checklist/ChecklistMutationBridge'
import { createChecklistTodoId } from './Lexical/Nodes/ChecklistItemNode'
import { isInteractiveChecklistEditorOwner } from './Checklist/ChecklistOwnerMode'
import { collaboratorColor } from './Collaboration/collaboratorColor'
import {
  matchesNoteEncryptionIdentity,
  resolveNoteEncryptionIdentity,
} from './Collaboration/CollaborationKeyDerivation'
import {
  authorizedRetrievedEditorSurfaceNote,
  applyRetrievedEditorContent,
  bindRetrievedReconciliationLifetime,
  buildRetrievedEditorFallbackContent,
  commitRetrievedEditorSurfaceForLifetime,
  flushAuthorizedRetrievedEditorSurfaceBeforeTransition,
  ownsRetrievedEditorBody,
  reconcileRetrievedNoteContent,
  persistAndVerifyRetrievedPayloadPair,
  persistedPayloadEnvelopesEqual,
  RetrievedEditorSurfaceState,
  RetrievedEditorUpdateToken,
  RetrievedReconciliationLifetime,
  retrievedEditorComposerLifetimeKey,
  scheduleRetrievedSyncAfterPreservation,
  serializeRetrievedConflictPreservation,
} from './Collaboration/RetrievedNoteReconciliation'

export const SuperNotePreviewCharLimit = 160

function cloneJsonValue<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

const AbortRetrievedConflictMutation = Symbol('abort-retrieved-conflict-mutation')
const surfaceKeyEpochs = new WeakMap<object, number>()
let nextSurfaceKeyEpoch = 1

function surfaceKeyEpoch(value: object): number {
  const existing = surfaceKeyEpochs.get(value)
  if (existing !== undefined) {
    return existing
  }
  const created = nextSurfaceKeyEpoch
  nextSurfaceKeyEpoch += 1
  surfaceKeyEpochs.set(value, created)
  return created
}

function currentSurfacePrincipal(application: WebApplication): string {
  try {
    const user = application.sessions.isSignedIn() ? application.sessions.getUser() : undefined
    return user ? `user:${user.uuid}` : 'anonymous'
  } catch {
    return 'unavailable'
  }
}

function isRetrievedConflictWriteAuthorized(
  application: WebApplication,
  expectedIdentity: NonNullable<ReturnType<typeof resolveNoteEncryptionIdentity>>,
  candidate: SNNote | undefined,
): candidate is SNNote {
  if (!candidate || candidate.locked || isLitePayload(candidate.payload)) {
    return false
  }
  try {
    const vault = application.vaults.getItemVault(candidate)
    const ownsOrdinaryItem =
      expectedIdentity.keySystemIdentifier !== null ||
      expectedIdentity.sharedVaultUuid !== null ||
      candidate.user_uuid === expectedIdentity.userUuid
    return (
      ownsOrdinaryItem &&
      !application.sessions.isCurrentSessionReadOnly() &&
      !(vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)) &&
      application.isAuthorizedToRenderItem(candidate) &&
      matchesNoteEncryptionIdentity(application, expectedIdentity, candidate)
    )
  } catch {
    return false
  }
}

function resolveRetrievedLifetimeIdentity(
  application: WebApplication,
  candidate: SNNote,
  ownerMatchesCurrentPrincipal: boolean,
) {
  if (!ownerMatchesCurrentPrincipal) {
    return undefined
  }
  try {
    const identity = resolveNoteEncryptionIdentity(application, candidate)
    if (identity) {
      return identity
    }

    // Templates and unsynced local notes have no server user_uuid yet. Give
    // their solo editor a local-only identity bound to the exact session/root
    // object; it can authorize rendering but can never match a relay lease.
    if (
      candidate.locked ||
      isLitePayload(candidate.payload) ||
      candidate.key_system_identifier !== undefined ||
      candidate.shared_vault_uuid !== undefined ||
      !application.isAuthorizedToRenderItem(candidate)
    ) {
      return undefined
    }
    const user = application.sessions.isSignedIn() ? application.sessions.getUser() : undefined
    if (!user) {
      return candidate.user_uuid === undefined
        ? {
            noteUuid: candidate.uuid,
            userUuid: 'local-anonymous',
            sessionUser: application,
            sourceId: `local-anonymous:${surfaceKeyEpoch(application)}:${candidate.uuid}`,
            keySystemIdentifier: null,
            sharedVaultUuid: null,
          }
        : undefined
    }
    if (candidate.user_uuid !== undefined && candidate.user_uuid !== user.uuid) {
      return undefined
    }
    const rootKey = application.encryption.getRootKey()
    if (!rootKey?.masterKey) {
      return undefined
    }
    return {
      noteUuid: candidate.uuid,
      userUuid: user.uuid,
      sessionUser: user,
      sourceId: `local-unsynced:${surfaceKeyEpoch(rootKey)}:${candidate.uuid}`,
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
  } catch {
    return undefined
  }
}

type Props = {
  application: WebApplication
  controller: NoteViewController
  linkingController: LinkingController
  filesController: FilesController
  spellcheck: boolean
  readonly?: boolean
  onFocus?: (event: FocusEvent) => void
  onBlur?: (event: FocusEvent) => void
  customBackgroundColor?: string
  customTextColor?: string
  /** Exact editor lifetime used by detached Todo management and provider flushes. */
  checklistOwnerLeaseId?: string
  /** Mount only persistence/collaboration; suppress visible and global editor behavior. */
  backgroundOwner?: boolean
}

type RetrievedEditorSurfaceOwner = {
  controller: NoteViewController
  principal: string
}

type RetrievedEditorSurface = RetrievedEditorSurfaceState<RetrievedEditorSurfaceOwner, SNNote>

export const SuperEditor: FunctionComponent<Props> = ({
  application,
  linkingController,
  filesController,
  spellcheck,
  controller,
  readonly,
  onFocus,
  onBlur,
  customBackgroundColor,
  customTextColor,
  checklistOwnerLeaseId,
  backgroundOwner = false,
}) => {
  const [generatedChecklistOwnerLeaseId] = useState(createChecklistTodoId)
  const effectiveChecklistOwnerLeaseId = checklistOwnerLeaseId ?? generatedChecklistOwnerLeaseId
  const interactiveOwner = isInteractiveChecklistEditorOwner(backgroundOwner)
  const isChecklistOwnerActive = useCallback(
    () => backgroundOwner || application.itemControllerGroup.activeItemViewController === controller,
    [application.itemControllerGroup, backgroundOwner, controller],
  )
  const handleChecklistOwnerReady = useCallback(() => {
    if (!backgroundOwner) {
      application.itemControllerGroup.markVisibleChecklistControllerReady(controller)
    }
  }, [application.itemControllerGroup, backgroundOwner, controller])
  const [initialEditorSurface] = useState<RetrievedEditorSurface>(() => {
    const principal = currentSurfacePrincipal(application)
    const authoritativeNote = application.items.findItem<SNNote>(controller.item.uuid)
    const initialNote = authoritativeNote ?? controller.item
    const identity = resolveRetrievedLifetimeIdentity(application, initialNote, true)
    return {
      owner: { controller, principal },
      lifetime: bindRetrievedReconciliationLifetime(undefined, {
        identity,
        noteUuid: initialNote.uuid,
        serverUpdatedAtTimestamp: initialNote.serverUpdatedAtTimestamp ?? 0,
        text: initialNote.text,
        previewPlain: initialNote.preview_plain,
        previewHtml: initialNote.preview_html || undefined,
      }),
      generation: 1,
      note: initialNote,
    }
  })
  const committedEditorSurface = useRef(initialEditorSurface)
  const note = useRef(initialEditorSurface.note)
  const surfaceOwner = useRef(initialEditorSurface.owner)
  const surfaceGeneration = useRef(initialEditorSurface.generation)
  const retrievedLifetimeRef = useRef<RetrievedReconciliationLifetime>(initialEditorSurface.lifetime)
  const changeEditorFunction = useRef<ChangeEditorFunction | undefined>(undefined)
  const ignoreNextChange = useRef<RetrievedEditorUpdateToken | undefined>(undefined)
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false)
  const getMarkdownPlugin = useRef<GetMarkdownPluginInterface | null>(null)
  const [featureStatus, setFeatureStatus] = useState<FeatureStatus>(FeatureStatus.Entitled)
  const [, requestSurfaceReconciliation] = useState(0)

  const activeSurfacePrincipal = currentSurfacePrincipal(application)
  const committedSurfaceAtRender = committedEditorSurface.current
  const controllerChanged = committedSurfaceAtRender.owner.controller !== controller
  const nextSurfaceOwner = useMemo(
    () => (controllerChanged ? { controller, principal: activeSurfacePrincipal } : committedSurfaceAtRender.owner),
    [activeSurfacePrincipal, committedSurfaceAtRender.owner, controller, controllerChanged],
  )
  const authoritativeControllerNote = application.items.findItem<SNNote>(controller.item.uuid)
  const lifetimeNote = authoritativeControllerNote ?? controller.item
  const lifetimeIdentity = resolveRetrievedLifetimeIdentity(
    application,
    lifetimeNote,
    nextSurfaceOwner.principal === activeSurfacePrincipal,
  )
  const retrievedLifetime = bindRetrievedReconciliationLifetime(committedSurfaceAtRender.lifetime, {
    identity: lifetimeIdentity,
    noteUuid: lifetimeNote.uuid,
    serverUpdatedAtTimestamp: lifetimeNote.serverUpdatedAtTimestamp ?? 0,
    text: lifetimeNote.text,
    previewPlain: lifetimeNote.preview_plain,
    previewHtml: lifetimeNote.preview_html || undefined,
  })
  const resetEditorSurface = controllerChanged || committedSurfaceAtRender.lifetime !== retrievedLifetime
  const plannedEditorSurface = useMemo<RetrievedEditorSurface>(
    () => ({
      owner: nextSurfaceOwner,
      lifetime: retrievedLifetime,
      generation: committedSurfaceAtRender.generation + (resetEditorSurface ? 1 : 0),
      note: lifetimeNote,
    }),
    [committedSurfaceAtRender.generation, lifetimeNote, nextSurfaceOwner, resetEditorSurface, retrievedLifetime],
  )

  useLayoutEffect(() => {
    const expectedOwner = nextSurfaceOwner
    const expectedLifetime = retrievedLifetime
    return () => {
      flushAuthorizedRetrievedEditorSurfaceBeforeTransition({
        expectedOwner,
        expectedLifetime,
        ownerRef: surfaceOwner,
        lifetimeRef: retrievedLifetimeRef,
        validateAuthorization: () => {
          if (expectedOwner.principal !== currentSurfacePrincipal(application)) {
            return false
          }
          const candidate = application.items.findItem<SNNote>(expectedLifetime.noteUuid)
          if (!candidate) {
            return false
          }
          const liveIdentity = resolveRetrievedLifetimeIdentity(application, candidate, true)
          return Boolean(
            authorizedRetrievedEditorSurfaceNote({
              lifetime: expectedLifetime,
              identity: liveIdentity,
              note: candidate,
            }),
          )
        },
        hasPendingChanges: () => controller.editorHasPendingChanges(),
        flushPendingChanges: () => controller.flushEditorSerialize(),
      })
    }
  }, [application, controller, nextSurfaceOwner, retrievedLifetime])

  useLayoutEffect(() => {
    const committed = commitRetrievedEditorSurfaceForLifetime({
      expectedPrevious: committedSurfaceAtRender,
      next: plannedEditorSurface,
      committedSurfaceRef: committedEditorSurface,
      ownerRef: surfaceOwner,
      lifetimeRef: retrievedLifetimeRef,
      generationRef: surfaceGeneration,
      noteRef: note,
      changeEditorFunctionRef: changeEditorFunction,
      ignoreNextChangeRef: ignoreNextChange,
    })
    if (!committed) {
      // A newer commit won the race. Re-plan synchronously before the browser
      // can dispatch input against a render whose handlers have stale ownership.
      requestSurfaceReconciliation((version) => version + 1)
      return
    }
    if (resetEditorSurface) {
      getMarkdownPlugin.current = null
    }
  }, [committedSurfaceAtRender, plannedEditorSurface, resetEditorSurface])

  const { latestEditorText, latestEditorPreview, durableState: retrievedDurableState } = retrievedLifetime
  const { conflictPreservationQueue } = retrievedLifetime
  const authorizedEditorNote = authorizedRetrievedEditorSurfaceNote({
    lifetime: retrievedLifetime,
    identity: lifetimeIdentity,
    note: lifetimeNote,
  })

  useEffect(() => {
    if (!authorizedEditorNote) {
      return
    }
    const noteUuid = authorizedEditorNote.uuid
    return controller.registerEditorDurabilityFlush(() =>
      flushChecklistMutationDurability(application, noteUuid, effectiveChecklistOwnerLeaseId),
    )
  }, [application, authorizedEditorNote, controller, effectiveChecklistOwnerLeaseId])

  const reloadFeatureStatus = useCallback(() => {
    setFeatureStatus(
      application.features.getFeatureStatus(
        NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue(),
        {
          inContextOfItem: note.current,
        },
      ),
    )
  }, [application.features])

  useEffect(() => {
    reloadFeatureStatus()
  }, [reloadFeatureStatus])

  useEffect(() => {
    return application.addEventObserver(async (event) => {
      switch (event) {
        case ApplicationEvent.FeaturesAvailabilityChanged:
        case ApplicationEvent.UserRolesChanged:
        case ApplicationEvent.LocalDataLoaded:
          reloadFeatureStatus()
          break
      }
    })
  }, [application, reloadFeatureStatus])

  const keyboardService = application.keyboardService
  const isEditorReadonly =
    !authorizedEditorNote ||
    authorizedEditorNote.locked ||
    Boolean(readonly) ||
    featureStatus !== FeatureStatus.Entitled
  const collaborationAccess = useCollaborationRoomAccess(application, lifetimeNote, true)
  const editorLease = collaborationAccess.status === 'ready' ? collaborationAccess.editorLease : undefined
  const collaborationIdentity =
    collaborationAccess.status === 'ready' &&
    retrievedLifetime.identity &&
    collaborationAccess.sourceId === retrievedLifetime.identity.sourceId &&
    collaborationAccess.userUuid === retrievedLifetime.identity.userUuid &&
    collaborationAccess.sessionUser === retrievedLifetime.identity.sessionUser
      ? retrievedLifetime.identity
      : undefined
  // The elected bootstrapper may seed only the clean, revision-matched body
  // returned by the freshness barrier; never fall back to a render-time note.
  const collaboration =
    authorizedEditorNote &&
    collaborationIdentity &&
    collaborationAccess.status === 'ready' &&
    editorLease &&
    typeof collaborationAccess.initialEditorState === 'string'
      ? {
          room: authorizedEditorNote.uuid,
          roomKey: collaborationAccess.roomKey,
          roomEpoch: collaborationAccess.roomEpoch,
          username: collaborationAccess.username,
          userUuid: collaborationAccess.userUuid,
          cursorColor: collaboratorColor(collaborationAccess.userUuid),
          shouldBootstrap: editorLease.shouldBootstrap,
          editorLease,
          initialEditorState: collaborationAccess.initialEditorState,
        }
      : undefined

  /**
   * Publish collaboration state for the title-bar status chip.
   *
   * Collaboration state must never take the editing surface away, so it is
   * reported in the status row instead. This mount is the one that already knows
   * the answer; the chip reads it rather than mounting the (expensive,
   * traffic-generating) room-access hook a second time.
   *
   * "Active" deliberately tracks the real `collaboration` object rather than
   * `status === 'ready'`: an authorized room that has not produced a usable lease
   * and initial state is still settling, not live.
   */
  const collaborationRoom = lifetimeNote.uuid
  const collaborationIsLive = Boolean(collaboration)
  const collaborationUnavailableReason =
    collaborationAccess.status === 'disabled' ? collaborationAccess.reason : undefined
  const publishedCollaborationStatus = useMemo<CollaborationRoomStatus>(() => {
    if (collaborationIsLive) {
      return { kind: 'active' }
    }
    if (collaborationUnavailableReason !== undefined) {
      return { kind: 'unavailable', reason: collaborationUnavailableReason }
    }
    return { kind: 'preparing' }
  }, [collaborationIsLive, collaborationUnavailableReason])

  useEffect(() => {
    if (!interactiveOwner) {
      return
    }
    CollaborationStatusRegistry.setStatus(collaborationRoom, publishedCollaborationStatus)
  }, [collaborationRoom, interactiveOwner, publishedCollaborationStatus])

  // Separate from the publish effect so a status change does not momentarily
  // deregister the room (which would also forget that it had ever been live).
  useEffect(() => {
    if (!interactiveOwner) {
      return
    }
    return () => {
      CollaborationStatusRegistry.clearRoom(collaborationRoom)
    }
  }, [collaborationRoom, interactiveOwner])

  useEffect(() => {
    if (!interactiveOwner) {
      return
    }
    return application.commands.addWithShortcut(
      SUPER_SHOW_MARKDOWN_PREVIEW,
      'Super notes',
      'Show markdown preview for current note',
      () => setShowMarkdownPreview((s) => !s),
      'markdown',
    )
  }, [application.commands, interactiveOwner])

  useEffect(() => {
    if (!interactiveOwner) {
      return
    }
    const platform = application.platform
    const primaryModifier = getPrimaryModifier(application.platform)

    return keyboardService.registerExternalKeyboardShortcutHelpItems([
      {
        key: 'b',
        modifiers: [primaryModifier],
        description: 'Bold',
        category: 'Formatting',
        platform: platform,
      },
      {
        key: 'i',
        modifiers: [primaryModifier],
        description: 'Italic',
        category: 'Formatting',
        platform: platform,
      },
      {
        key: 'u',
        modifiers: [primaryModifier],
        description: 'Underline',
        category: 'Formatting',
        platform: platform,
      },
      {
        key: 'k',
        modifiers: [primaryModifier],
        description: 'Link',
        category: 'Formatting',
        platform: platform,
      },
    ])
  }, [application.platform, interactiveOwner, keyboardService])

  const closeMarkdownPreview = useCallback(() => {
    setShowMarkdownPreview(false)
  }, [])

  useEffect(() => {
    if (!interactiveOwner) {
      return
    }
    return application.actions.addPayloadRequestHandler((uuid) => {
      const candidate = note.current
      const lifetime = retrievedLifetimeRef.current
      const liveIdentity = resolveRetrievedLifetimeIdentity(
        application,
        candidate,
        surfaceOwner.current.principal === currentSurfacePrincipal(application),
      )
      const authorized = lifetime
        ? authorizedRetrievedEditorSurfaceNote({ lifetime, identity: liveIdentity, note: candidate })
        : undefined
      if (uuid === authorized?.uuid) {
        const basePayload = authorized.payload.ejected()
        return {
          ...basePayload,
          content: {
            ...basePayload.content,
            text: getMarkdownPlugin.current?.getMarkdown() ?? basePayload.content.text,
          },
        }
      }
    })
  }, [application, interactiveOwner])

  const handleChange = useCallback(
    async (value: string, preview: string, bypassDebounce?: boolean) => {
      if (
        surfaceOwner.current !== nextSurfaceOwner ||
        retrievedLifetimeRef.current !== retrievedLifetime ||
        !retrievedLifetime.identity
      ) {
        return
      }
      // This ref is updated synchronously, including when a retrieved payload
      // flushes the editor's pending serialize. It is therefore the exact
      // retained Y.Doc body used for divergent durable-state reconciliation.
      latestEditorText.current = value
      latestEditorPreview.current = { previewPlain: preview, previewHtml: undefined }
      if (ignoreNextChange.current !== undefined) {
        ignoreNextChange.current = undefined
        return
      }
      if (isEditorReadonly) {
        return
      }

      void controller.saveAndAwaitLocalPropagation({
        text: value,
        isUserModified: true,
        // Standard Red Notes (last-edit-loss fix): a lifecycle flush
        // (note-switch/blur/unmount/logout/unload) forwards bypassDebounce=true so the
        // edit is dirtied + persisted immediately instead of waiting out the 700ms sync
        // debounce, which a close/logout/clearAllData could otherwise pre-empt.
        bypassDebouncer: bypassDebounce,
        previews: {
          previewPlain: preview,
          previewHtml: undefined,
        },
      })
    },
    [controller, isEditorReadonly, latestEditorPreview, latestEditorText, nextSurfaceOwner, retrievedLifetime],
  )

  /**
   * Standard Red Notes (last-edit-loss fix): register the editor's debounce control
   * (flush + hasPending) with the controller so lifecycle code (ItemGroupController
   * note-switch, ConfirmSignoutModal, beforeunload) can force a pending edit through
   * the save path before this editor/controller is torn down. Stable identity so the
   * BlocksEditor effect registers once.
   */
  const registerDebounceControl = useCallback(
    (control: { flush: () => void; hasPending: () => boolean }) => {
      return controller.registerEditorFlush(control.flush, control.hasPending)
    },
    [controller],
  )

  const handleEditorReferenceChanges = useCallback(
    (changes: EditorReferenceChanges) => {
      void (async () => {
        if (surfaceOwner.current !== nextSurfaceOwner || retrievedLifetimeRef.current !== retrievedLifetime) {
          return
        }
        // A new-note editor starts from a non-persisted template item. Insert it
        // before resolving newly added references, then carry this editor's own
        // controller item through reconciliation (never the later UI selection).
        if (changes.added.length > 0 && controller.isTemplateNote) {
          await controller.insertTemplatedNote()
        }

        if (surfaceOwner.current !== nextSurfaceOwner || retrievedLifetimeRef.current !== retrievedLifetime) {
          return
        }
        await linkingController.reconcileEditorReferenceChanges(controller.item, changes)
      })().catch(console.error)
    },
    [controller, linkingController, nextSurfaceOwner, retrievedLifetime],
  )

  const registerChangeEditorFunction = useCallback((callback: ChangeEditorFunction) => {
    return registerLatestChangeEditorFunction(changeEditorFunction, callback)
  }, [])

  useEffect(() => {
    // Bind this observer lifetime to the exact session/root-key lease that
    // mounted it. A later same-UUID account/vault render must never substitute
    // its lease or key source into already-queued plaintext work.
    const expectedIdentity = collaborationIdentity
    const receiptLease = editorLease
    const expectedSurfaceOwner = nextSurfaceOwner
    const disposer = controller.addNoteInnerValueChangeObserver((updatedNote, source) => {
      if (surfaceOwner.current !== expectedSurfaceOwner || retrievedLifetimeRef.current !== retrievedLifetime) {
        return
      }
      const liveIdentity = resolveRetrievedLifetimeIdentity(
        application,
        updatedNote,
        surfaceOwner.current.principal === currentSurfacePrincipal(application),
      )
      if (
        !authorizedRetrievedEditorSurfaceNote({
          lifetime: retrievedLifetime,
          identity: liveIdentity,
          note: updatedNote,
        })
      ) {
        return
      }
      if (updatedNote.uuid !== note.current.uuid) {
        throw Error('Editor received changes for non-current note')
      }

      if (source === PayloadEmitSource.AssistantChanged && updatedNote.text !== note.current.text) {
        const applied = changeEditorFunction.current
          ? applyRetrievedEditorContent({
              text: updatedNote.text,
              changeEditor: changeEditorFunction.current,
              ignoreNextChangeRef: ignoreNextChange,
              isLifetimeCurrent: () =>
                surfaceOwner.current === expectedSurfaceOwner && retrievedLifetimeRef.current === retrievedLifetime,
              flushEditorSerialize: () => controller.flushEditorSerialize(),
              history: 'push',
            })
          : false
        if (applied) {
          retrievedDurableState.text = updatedNote.text
          latestEditorText.current = updatedNote.text
          latestEditorPreview.current = {
            previewPlain: updatedNote.preview_plain,
            previewHtml: updatedNote.preview_html || undefined,
          }
        }
      }

      if (isPayloadSourceRetrieved(source)) {
        const authoritativeIncoming = expectedIdentity
          ? application.items.findItem<SNNote>(expectedIdentity.noteUuid)
          : undefined
        let incomingContentSnapshot: NoteContent | undefined
        try {
          const receiptIsValid = Boolean(
            expectedIdentity &&
            receiptLease &&
            ownsRetrievedEditorBody({
              committedLifetime: retrievedLifetimeRef.current,
              expectedLifetime: retrievedLifetime,
              expectedIdentity,
              liveIdentity,
              ownerMatchesCurrentPrincipal: surfaceOwner.current.principal === currentSurfacePrincipal(application),
              collaboration: receiptLease,
              latestEditorText: latestEditorText.current,
              durableText: retrievedDurableState.text,
            }) &&
            authoritativeIncoming &&
            isRetrievedConflictWriteAuthorized(application, expectedIdentity, updatedNote) &&
            isRetrievedConflictWriteAuthorized(application, expectedIdentity, authoritativeIncoming) &&
            authoritativeIncoming.serverUpdatedAtTimestamp === updatedNote.serverUpdatedAtTimestamp &&
            authoritativeIncoming.text === updatedNote.text,
          )
          if (receiptIsValid) {
            // Eject and deep-copy only after proving this is the full payload
            // from the exact mounted session/root-key identity.
            incomingContentSnapshot = cloneJsonValue(updatedNote.payload.ejected().content)
          }
        } catch {
          incomingContentSnapshot = undefined
        }
        /**
         * Standard Red Notes (last-edit-loss fix): a retrieved sync payload is about
         * to REPLACE the editor contents. If a local keystroke is still sitting in the
         * serialize debounce (not yet dirty), applying the retrieved state here would
         * swallow that pending edit with no conflict copy. Flush the pending local
         * serialize FIRST so it dirties the item and the conflict system preserves it
         * as a conflicted copy, instead of silently discarding it. No-op when there is
         * no pending local edit, so the normal retrieved-update path is unchanged.
         */
        reconcileRetrievedNoteContent({
          text: updatedNote.text,
          serverUpdatedAtTimestamp: updatedNote.serverUpdatedAtTimestamp,
          collaboration: receiptLease,
          collaborationHasLocalDivergence: () =>
            Boolean(receiptLease && latestEditorText.current !== retrievedDurableState.text),
          currentCollaborativeText: () => latestEditorText.current,
          durableState: retrievedDurableState,
          editorHasPendingChanges: () => controller.editorHasPendingChanges(),
          flushEditorSerialize: () => controller.flushEditorSerialize(),
          changeEditor: changeEditorFunction.current,
          ignoreNextChangeRef: ignoreNextChange,
          isEditorLifetimeCurrent: () =>
            surfaceOwner.current === expectedSurfaceOwner && retrievedLifetimeRef.current === retrievedLifetime,
          preserveDivergentRetrieved:
            expectedIdentity && receiptLease && incomingContentSnapshot
              ? () => {
                  const capturedIncomingContent = incomingContentSnapshot
                  let incomingConflict: SNNote | undefined
                  const currentOriginal = () => application.items.findItem<SNNote>(expectedIdentity.noteUuid)
                  const originalIsWritable = () =>
                    isRetrievedConflictWriteAuthorized(application, expectedIdentity, currentOriginal())
                  const stillOwnsCollaborativeBody = () => {
                    if (surfaceOwner.current !== expectedSurfaceOwner) {
                      return false
                    }
                    const current = currentOriginal()
                    const currentIdentity = current
                      ? resolveRetrievedLifetimeIdentity(
                          application,
                          current,
                          surfaceOwner.current.principal === currentSurfacePrincipal(application),
                        )
                      : undefined
                    return ownsRetrievedEditorBody({
                      committedLifetime: retrievedLifetimeRef.current,
                      expectedLifetime: retrievedLifetime,
                      expectedIdentity,
                      liveIdentity: currentIdentity,
                      ownerMatchesCurrentPrincipal:
                        surfaceOwner.current.principal === currentSurfacePrincipal(application),
                      collaboration: receiptLease,
                      latestEditorText: latestEditorText.current,
                      durableText: retrievedDurableState.text,
                    })
                  }
                  const livePayloadMatches = (uuid: string, expected: SNNote['payload']): boolean => {
                    const live = application.items.findItem<SNNote>(uuid)
                    return Boolean(
                      live &&
                      !isLitePayload(live.payload) &&
                      persistedPayloadEnvelopesEqual(live.payloadRepresentation(), expected),
                    )
                  }
                  const persistPair = async (first: SNNote, second: SNNote, validate: () => boolean): Promise<void> => {
                    const firstPayload = first.payloadRepresentation()
                    const secondPayload = second.payloadRepresentation()
                    await persistAndVerifyRetrievedPayloadPair({
                      first: firstPayload,
                      second: secondPayload,
                      validate: () =>
                        validate() &&
                        livePayloadMatches(first.uuid, firstPayload) &&
                        livePayloadMatches(second.uuid, secondPayload),
                      persist: (payloads) => application.sync.persistPayloads(payloads),
                      read: (uuid) => application.sync.getFullContentPayload(uuid),
                    })
                  }

                  const serialized = serializeRetrievedConflictPreservation({
                    previous: conflictPreservationQueue.current,
                    validateBeforeDuplicate: () => {
                      return originalIsWritable() && stillOwnsCollaborativeBody()
                    },
                    duplicate: async () => {
                      const current = currentOriginal()
                      if (!isRetrievedConflictWriteAuthorized(application, expectedIdentity, current)) {
                        throw AbortRetrievedConflictMutation
                      }
                      // Keep the genuinely newer retrieved body as a normal
                      // conflicted copy. Never inject divergent HTTP JSON into an
                      // actively-owned Y.Doc, which would emit CRDT deletions.
                      const duplicated = await application.mutator.duplicateItem(current, true, capturedIncomingContent)
                      if (
                        !originalIsWritable() ||
                        isLitePayload(duplicated.payload) ||
                        duplicated.duplicate_of !== expectedIdentity.noteUuid ||
                        duplicated.conflictOf !== expectedIdentity.noteUuid
                      ) {
                        throw AbortRetrievedConflictMutation
                      }
                      incomingConflict = duplicated
                    },
                    validateBeforeSave: () => originalIsWritable() && Boolean(incomingConflict),
                    getLatestValue: () => ({
                      text: latestEditorText.current,
                      previews: { ...latestEditorPreview.current },
                    }),
                    save: async ({ text, previews }) => {
                      const conflict = incomingConflict
                      const saveTarget = currentOriginal()
                      if (
                        !conflict ||
                        !isRetrievedConflictWriteAuthorized(application, expectedIdentity, saveTarget) ||
                        !stillOwnsCollaborativeBody()
                      ) {
                        throw AbortRetrievedConflictMutation
                      }

                      // Mutate directly so the conflict copy and restored E3 can
                      // be submitted to storage together. NoteSyncController's
                      // save promise resolves before its unawaited sync and cannot
                      // serve as a durability acknowledgement here.
                      await application.mutator.changeItem<NoteMutator>(
                        saveTarget,
                        (mutator) => {
                          const boundary = currentOriginal()
                          if (
                            !isRetrievedConflictWriteAuthorized(application, expectedIdentity, boundary) ||
                            !stillOwnsCollaborativeBody()
                          ) {
                            throw AbortRetrievedConflictMutation
                          }
                          mutator.text = text
                          mutator.preview_plain = previews.previewPlain
                          mutator.preview_html = previews.previewHtml
                        },
                        MutationType.UpdateUserTimestamps,
                      )

                      const restored = currentOriginal()
                      const latestValueStillMatches = () =>
                        latestEditorText.current === text &&
                        latestEditorPreview.current.previewPlain === previews.previewPlain &&
                        latestEditorPreview.current.previewHtml === previews.previewHtml
                      if (
                        !isRetrievedConflictWriteAuthorized(application, expectedIdentity, restored) ||
                        !stillOwnsCollaborativeBody() ||
                        !latestValueStillMatches() ||
                        restored.text !== text ||
                        restored.preview_plain !== previews.previewPlain ||
                        (restored.preview_html || undefined) !== previews.previewHtml
                      ) {
                        throw AbortRetrievedConflictMutation
                      }

                      await persistPair(conflict, restored, () => {
                        return originalIsWritable() && stillOwnsCollaborativeBody() && latestValueStillMatches()
                      })
                    },
                    preserveLatestFallback: async ({ text, previews }) => {
                      const conflict = incomingConflict
                      const current = currentOriginal()
                      const latestValueStillMatches = () =>
                        latestEditorText.current === text &&
                        latestEditorPreview.current.previewPlain === previews.previewPlain &&
                        latestEditorPreview.current.previewHtml === previews.previewHtml
                      if (
                        !conflict ||
                        !isRetrievedConflictWriteAuthorized(application, expectedIdentity, current) ||
                        !latestValueStillMatches()
                      ) {
                        throw AbortRetrievedConflictMutation
                      }
                      const currentPayloadSnapshot = current.payloadRepresentation()
                      const fallbackContent = buildRetrievedEditorFallbackContent({
                        currentContent: current.payload.ejected().content,
                        text,
                        previewPlain: previews.previewPlain,
                        previewHtml: previews.previewHtml,
                      })
                      // If the provider/editor lifetime ended after the incoming
                      // copy, never let the stale controller overwrite the primary.
                      // Preserve the latest editor body plus every independently
                      // copied live metadata field as a second conflict copy.
                      const fallback = await application.mutator.duplicateItem(current, true, fallbackContent)
                      if (
                        !originalIsWritable() ||
                        !livePayloadMatches(current.uuid, currentPayloadSnapshot) ||
                        !latestValueStillMatches() ||
                        isLitePayload(fallback.payload) ||
                        fallback.duplicate_of !== expectedIdentity.noteUuid ||
                        fallback.conflictOf !== expectedIdentity.noteUuid
                      ) {
                        throw AbortRetrievedConflictMutation
                      }
                      await persistPair(
                        conflict,
                        fallback,
                        () =>
                          originalIsWritable() &&
                          livePayloadMatches(current.uuid, currentPayloadSnapshot) &&
                          latestValueStillMatches(),
                      )
                    },
                  })
                  const work = scheduleRetrievedSyncAfterPreservation({
                    work: serialized.work,
                    validate: originalIsWritable,
                    schedule: () => {
                      void application.sync.sync().catch(console.error)
                    },
                  })
                  conflictPreservationQueue.current = work.then(
                    () => undefined,
                    () => undefined,
                  )
                  return work
                }
              : undefined,
        })
      }

      note.current = updatedNote
    })

    return disposer
  }, [
    application,
    collaborationIdentity,
    conflictPreservationQueue,
    controller,
    controller.item.uuid,
    editorLease,
    latestEditorPreview,
    latestEditorText,
    nextSurfaceOwner,
    retrievedDurableState,
    retrievedLifetime,
  ])

  const [lineHeight] = useLocalPreference(LocalPrefKey.EditorLineHeight)
  const [fontSize] = useLocalPreference(LocalPrefKey.EditorFontSize)
  const responsiveFontSize = useResponsiveEditorFontSize(fontSize, false)

  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!interactiveOwner) {
      return
    }
    const invalidURLClickFix = (event: MouseEvent) => {
      if ((event.target as HTMLElement).tagName !== 'A') {
        return
      }
      const isAbsoluteLink = (event.target as HTMLAnchorElement).getAttribute('href')?.startsWith('http')
      if (!isAbsoluteLink) {
        event.preventDefault()
      }
    }

    const element = ref.current

    if (element) {
      element.addEventListener('click', invalidURLClickFix)
    }

    return () => {
      if (element) {
        element.removeEventListener('click', invalidURLClickFix)
      }
    }
  }, [interactiveOwner])

  const handleFocus = useCallback(
    (event: FocusEvent) => {
      application.notifyWebEvent(WebAppEvent.EditorDidFocus, { eventSource: EditorEventSource.UserInteraction })
      onFocus?.(event)
    },
    [application, onFocus],
  )

  return (
    <div
      id={interactiveOwner ? ElementIds.SuperEditor : undefined}
      className="font-editor relative flex h-full w-full flex-col"
      style={
        {
          '--line-height': EditorLineHeightValues[lineHeight],
          '--font-size': responsiveFontSize,
          // Standard Red Notes: per-note custom appearance. Omitted (undefined)
          // when the note has no override so the theme controls the surface.
          backgroundColor: customBackgroundColor,
          color: customTextColor,
        } as CSSProperties
      }
      ref={ref}
    >
      <ErrorBoundary>
        <LinkingControllerProvider controller={linkingController}>
          <FilesControllerProvider controller={filesController}>
            {!authorizedEditorNote ? (
              <div className="text-passive-1 flex h-full items-center justify-center text-sm">
                Editor unavailable while encrypted note access is changing…
              </div>
            ) : (
              <BlocksEditorComposer
                key={retrievedEditorComposerLifetimeKey({
                  noteUuid: authorizedEditorNote.uuid,
                  generation: plannedEditorSurface.generation,
                  ...(collaborationAccess.status === 'ready' && editorLease
                    ? { leaseRequestId: editorLease.requestId }
                    : {}),
                })}
                readonly={isEditorReadonly}
                initialValue={authorizedEditorNote.text}
                collaborating={Boolean(collaboration)}
              >
                <BlocksEditor
                  noteUuid={authorizedEditorNote.uuid}
                  onChange={handleChange}
                  className="blocks-editor h-full resize-none"
                  previewLength={SuperNotePreviewCharLimit}
                  spellcheck={spellcheck}
                  readonly={isEditorReadonly}
                  onFocus={handleFocus}
                  onBlur={onBlur}
                  application={application}
                  collaboration={collaboration}
                  registerDebounceControl={registerDebounceControl}
                  checklistOwnerLeaseId={effectiveChecklistOwnerLeaseId}
                  persistChanges={() => controller.flushAndAwaitPendingSaveStrict()}
                  backgroundOwner={backgroundOwner}
                  isChecklistOwnerActive={isChecklistOwnerActive}
                  onChecklistOwnerReady={handleChecklistOwnerReady}
                >
                  {interactiveOwner && <ItemSelectionPlugin currentNote={authorizedEditorNote} />}
                  {interactiveOwner && <FilePlugin currentNote={authorizedEditorNote} />}
                  {interactiveOwner && <ItemBubblePlugin />}
                  {interactiveOwner && <GetMarkdownPlugin ref={getMarkdownPlugin} />}
                  <ChangeContentCallbackPlugin providerCallback={registerChangeEditorFunction} />
                  {interactiveOwner && <NodeObserverPlugin onChange={handleEditorReferenceChanges} />}
                  {readonly === undefined && (
                    <ReadonlyPlugin
                      note={authorizedEditorNote}
                      forceReadonly={featureStatus !== FeatureStatus.Entitled}
                    />
                  )}
                  {interactiveOwner && <AutoFocusPlugin isEnabled={controller.isTemplateNote} />}
                  {interactiveOwner && <BlockPickerMenuPlugin />}
                  {interactiveOwner && <NoteFromSelectionPlugin currentNote={authorizedEditorNote} />}
                </BlocksEditor>
              </BlocksEditorComposer>
            )}
          </FilesControllerProvider>
        </LinkingControllerProvider>
        {authorizedEditorNote && (
          <ModalOverlay isOpen={showMarkdownPreview} close={closeMarkdownPreview}>
            <SuperNoteMarkdownPreview note={authorizedEditorNote} closeDialog={closeMarkdownPreview} />
          </ModalOverlay>
        )}
      </ErrorBoundary>
    </div>
  )
}
