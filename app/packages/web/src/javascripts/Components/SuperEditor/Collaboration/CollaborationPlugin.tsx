import { FunctionComponent, ReactNode, useEffect, useMemo, useRef } from 'react'
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import { LexicalCollaboration, useCollaborationContext } from '@lexical/react/LexicalCollaborationContext'
import type { InitialEditorStateType } from '@lexical/react/LexicalComposer'
import * as Y from 'yjs'
import type { Doc } from 'yjs'
import type { Provider } from '@lexical/yjs'
import { WebApplication } from '@/Application/WebApplication'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { createRoomCipher } from './RoomCrypto'
import { MAX_PRESENT_PEERS_PER_ROOM, PresenceRegistry, PresentPeer } from './PresenceRegistry'
import { getSuperCollaborationAvailability } from './CollaborationAvailability'
import type { EditorCollaborationLease } from './useCollaborationRoomAccess'
import {
  notifyChecklistMutationBridgeReadiness,
  registerChecklistMutationDurabilityFlusher,
} from '../Checklist/ChecklistMutationBridge'

export type CollaborationConfig = {
  /** Room id — the note uuid. All collaborators on this note share it. */
  room: string
  /** A non-extractable room key derived exclusively from client-only vault key material. */
  roomKey: CryptoKey
  /** Display name + cursor color for presence. */
  username: string
  cursorColor: string
  /**
   * Stable account id of the local user. Broadcast over awareness so peers can
   * match a live cursor/presence to a known vault member by uuid (not just name).
   */
  userUuid?: string
  /** First client to open the note seeds the doc from its current content. */
  shouldBootstrap: boolean
  /** Already-active request-bound lease; the provider attaches without replaying room-join. */
  editorLease: EditorCollaborationLease
  /** Content used to seed the shared doc on first bootstrap (the note text). */
  initialEditorState?: InitialEditorStateType
}

/** Shape of the awareness localState each @lexical/yjs client publishes. */
type AwarenessUserState = {
  name?: string
  color?: string
  awarenessData?: { userUuid?: string }
}

type AwarenessLike = {
  clientID: number
  getStates(): Map<number, AwarenessUserState>
  on(event: 'change', cb: () => void): void
  off(event: 'change', cb: () => void): void
}

type Props = {
  application: WebApplication
  config: CollaborationConfig
  checklistOwnerLeaseId?: string
  onCanonicalReadyChange?(ready: boolean): void
}

const CollaborationDocumentLifetime: FunctionComponent<{ children: ReactNode }> = ({ children }) => {
  const { yjsDocMap } = useCollaborationContext()
  const pendingDestroyRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (pendingDestroyRef.current !== undefined) {
      clearTimeout(pendingDestroyRef.current)
      pendingDestroyRef.current = undefined
    }
    return () => {
      // Lexical tears down its binding and provider in sibling passive effects.
      // Dispose the documents only after those cleanups have completed. The
      // next setup cancels this timeout during a React StrictMode effect replay.
      pendingDestroyRef.current = setTimeout(() => {
        pendingDestroyRef.current = undefined
        const documents = [...yjsDocMap.values()]
        yjsDocMap.clear()
        for (const document of documents) {
          document.destroy()
        }
      }, 0)
    }
  }, [yjsDocMap])

  return <>{children}</>
}

/**
 * Gives one mounted editor lifetime a private Y.Doc map. The key deliberately
 * changes for a new room/key/lease preparation but remains stable across an
 * ordinary transport reconnect so retained CRDT state can merge after rejoin.
 */
export const EphemeralLexicalCollaboration: FunctionComponent<{
  lifetimeKey: string
  children?: ReactNode
}> = ({ lifetimeKey, children }) => (
  <LexicalCollaboration key={lifetimeKey}>
    <CollaborationDocumentLifetime>{children}</CollaborationDocumentLifetime>
  </LexicalCollaboration>
)

/**
 * Mounted only after SuperCollaborationPlugin receives an exact-note capability,
 * a request-bound editor lease, and a non-extractable room key derived from
 * client-only shared-vault material. Other states retain ordinary encrypted
 * persistence/sync without mounting a relay provider.
 */
const AvailableSuperCollaborationPlugin: FunctionComponent<Props> = ({
  application,
  config,
  checklistOwnerLeaseId,
  onCanonicalReadyChange,
}) => {
  const effectiveChecklistOwnerLeaseId = checklistOwnerLeaseId ?? config.editorLease.requestId
  const channel = useMemo(() => createGatewayCollabChannel(application), [application])

  // The CollaborationPlugin owns the provider lifecycle; we capture the live
  // instance here so a sibling effect can mirror its awareness into the
  // app-wide PresenceRegistry that the sidebar reads.
  const providerRef = useRef<EncryptedYjsProvider | null>(null)
  const providerReadinessDisposerRef = useRef<(() => void) | null>(null)
  const providerDurabilityDisposerRef = useRef<(() => void) | null>(null)
  const pendingProviderDestroyRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (pendingProviderDestroyRef.current !== undefined) {
      clearTimeout(pendingProviderDestroyRef.current)
      pendingProviderDestroyRef.current = undefined
    }
    return () => {
      // Lexical's own cleanup calls reconnectable disconnect(). Defer the
      // irreversible destroy until sibling cleanups complete. A StrictMode
      // setup replay cancels this terminal path before the next macrotask.
      pendingProviderDestroyRef.current = setTimeout(() => {
        pendingProviderDestroyRef.current = undefined
        providerReadinessDisposerRef.current?.()
        providerReadinessDisposerRef.current = null
        providerDurabilityDisposerRef.current?.()
        providerDurabilityDisposerRef.current = null
        onCanonicalReadyChange?.(false)
        providerRef.current?.destroy()
        providerRef.current = null
      }, 0)
    }
  }, [onCanonicalReadyChange])

  const providerFactory = useMemo(() => {
    return (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      let doc = yjsDocMap.get(id)
      if (!doc) {
        doc = new Y.Doc()
        yjsDocMap.set(id, doc)
      }

      const cipher = createRoomCipher(config.roomKey)

      const provider = new EncryptedYjsProvider(
        doc,
        config.room,
        channel,
        cipher,
        undefined,
        config.editorLease.requestId,
        {
          activeLease: config.editorLease,
          shouldBootstrap: config.shouldBootstrap,
          validateAttachment: config.editorLease.validateAttachment,
          reactivate: config.editorLease.reactivate,
          onFatal: config.editorLease.fail,
          onBootstrapRetry: config.editorLease.retryBootstrap,
          ...(config.editorLease.setProviderCanonicalOwnership
            ? { setCanonicalOwnership: config.editorLease.setProviderCanonicalOwnership }
            : {}),
        },
      )
      providerReadinessDisposerRef.current?.()
      providerReadinessDisposerRef.current = provider.onCanonicalReadyChange((ready) => {
        onCanonicalReadyChange?.(ready)
        notifyChecklistMutationBridgeReadiness(application)
      })
      providerDurabilityDisposerRef.current?.()
      providerDurabilityDisposerRef.current = registerChecklistMutationDurabilityFlusher(
        application,
        config.room,
        effectiveChecklistOwnerLeaseId,
        async () => {
          if (!provider.isCanonicalReady() || !provider.isRoomJoined()) {
            throw new Error('The collaboration provider is not mutation-ready.')
          }
          await provider.flush()
          if (!provider.isCanonicalReady() || !provider.isRoomJoined() || provider.getLastSyncFailure()) {
            throw new Error('The collaboration provider could not flush this checklist update.')
          }
        },
        () => provider.isCanonicalReady() && provider.isRoomJoined(),
      )
      providerRef.current = provider
      return provider
    }
  }, [
    application,
    channel,
    config.editorLease,
    config.room,
    config.roomKey,
    config.shouldBootstrap,
    effectiveChecklistOwnerLeaseId,
    onCanonicalReadyChange,
  ])

  const awarenessData = useMemo(() => (config.userUuid ? { userUuid: config.userUuid } : undefined), [config.userUuid])

  // Mirror live awareness (who else has this note open) into the registry so the
  // presence sidebar can show genuinely-online collaborators. Excludes the local
  // client; clears the room on unmount.
  useEffect(() => {
    const provider = providerRef.current
    if (!provider) {
      return
    }
    const awareness = provider.awareness as unknown as AwarenessLike
    const room = config.room

    const publish = (): void => {
      const peers: PresentPeer[] = []
      awareness.getStates().forEach((state, clientId) => {
        if (peers.length >= MAX_PRESENT_PEERS_PER_ROOM) {
          return
        }
        if (clientId === awareness.clientID) {
          return
        }
        if (!state || (!state.name && !state.awarenessData?.userUuid)) {
          return
        }
        peers.push({
          userUuid: state.awarenessData?.userUuid,
          name: state.name ?? 'Collaborator',
          color: state.color ?? '#888888',
          clientId,
        })
      })
      PresenceRegistry.setPeers(room, peers)
    }

    awareness.on('change', publish)
    publish()

    return () => {
      awareness.off('change', publish)
      PresenceRegistry.clearRoom(room)
    }
    // Re-bind when the room changes (a new provider is created per room).
  }, [config.room])

  return (
    <CollaborationPlugin
      id={config.room}
      providerFactory={providerFactory}
      shouldBootstrap={config.shouldBootstrap}
      initialEditorState={config.initialEditorState}
      username={config.username}
      cursorColor={config.cursorColor}
      awarenessData={awarenessData}
    />
  )
}

/**
 * Fail-closed entry point. The note-level caller supplies a freshly prepared
 * non-extractable room key and exact-note capability; this final runtime check
 * prevents construction where WebCrypto itself is unavailable.
 */
export const SuperCollaborationPlugin: FunctionComponent<Props> = (props) => {
  if (!getSuperCollaborationAvailability().available) {
    return null
  }

  const lifetimeKey = `${props.config.room}:${props.config.editorLease.requestId}`
  return (
    <EphemeralLexicalCollaboration lifetimeKey={lifetimeKey}>
      <AvailableSuperCollaborationPlugin {...props} />
    </EphemeralLexicalCollaboration>
  )
}
