import { FunctionComponent, useEffect, useMemo, useRef } from 'react'
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import type { InitialEditorStateType } from '@lexical/react/LexicalComposer'
import * as Y from 'yjs'
import type { Doc } from 'yjs'
import type { Provider } from '@lexical/yjs'
import { WebApplication } from '@/Application/WebApplication'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { createPlaintextCipher, createRoomCipher, deriveRoomKey, RoomCipher } from './RoomCrypto'
import { PresenceRegistry, PresentPeer } from './PresenceRegistry'

export type CollaborationConfig = {
  /** Room id — the note uuid. All collaborators on this note share it. */
  room: string
  /**
   * Shared secret all collaborators hold (e.g. the vault key). Used to derive
   * the per-room AES key. When undefined, frames are relayed WITHOUT encryption
   * (only acceptable on a fully-trusted self-hosted gateway).
   */
  sharedSecret?: string
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
}

/**
 * Wraps a not-yet-resolved RoomCipher so the provider can start relaying
 * immediately; the real AES key derives asynchronously. yjs updates are
 * idempotent, so any frames sent before the key is ready are re-synced.
 */
function deferredCipher(keyReady: Promise<RoomCipher>): RoomCipher {
  return {
    encrypt: async (b) => (await keyReady).encrypt(b),
    decrypt: async (p) => (await keyReady).decrypt(p),
  }
}

/**
 * Live co-editing for the Super editor. Mounts @lexical/react's
 * CollaborationPlugin backed by an EncryptedYjsProvider over the gateway relay.
 *
 * OPT-IN: only mounted for notes explicitly marked collaborative (shared vault
 * notes). The single-user editing path never instantiates this, so it cannot
 * affect solo notes.
 */
export const SuperCollaborationPlugin: FunctionComponent<Props> = ({ application, config }) => {
  const channel = useMemo(() => createGatewayCollabChannel(application), [application])

  // The CollaborationPlugin owns the provider lifecycle; we capture the live
  // instance here so a sibling effect can mirror its awareness into the
  // app-wide PresenceRegistry that the sidebar reads.
  const providerRef = useRef<EncryptedYjsProvider | null>(null)

  const providerFactory = useMemo(() => {
    return (id: string, yjsDocMap: Map<string, Doc>): Provider => {
      let doc = yjsDocMap.get(id)
      if (!doc) {
        doc = new Y.Doc()
        yjsDocMap.set(id, doc)
      }

      const cipher = config.sharedSecret
        ? deferredCipher(deriveRoomKey(config.sharedSecret, config.room).then(createRoomCipher))
        : createPlaintextCipher()

      const provider = new EncryptedYjsProvider(doc, config.room, channel, cipher)
      providerRef.current = provider
      return provider
    }
  }, [channel, config.room, config.sharedSecret])

  const awarenessData = useMemo(
    () => (config.userUuid ? { userUuid: config.userUuid } : undefined),
    [config.userUuid],
  )

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
