import { FunctionComponent, useMemo } from 'react'
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import type { InitialEditorStateType } from '@lexical/react/LexicalComposer'
import * as Y from 'yjs'
import type { Doc } from 'yjs'
import type { Provider } from '@lexical/yjs'
import { WebApplication } from '@/Application/WebApplication'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createGatewayCollabChannel } from './GatewayCollabChannel'
import { createPlaintextCipher, createRoomCipher, deriveRoomKey, RoomCipher } from './RoomCrypto'

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
  /** First client to open the note seeds the doc from its current content. */
  shouldBootstrap: boolean
  /** Content used to seed the shared doc on first bootstrap (the note text). */
  initialEditorState?: InitialEditorStateType
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

      return new EncryptedYjsProvider(doc, config.room, channel, cipher)
    }
  }, [channel, config.room, config.sharedSecret])

  return (
    <CollaborationPlugin
      id={config.room}
      providerFactory={providerFactory}
      shouldBootstrap={config.shouldBootstrap}
      initialEditorState={config.initialEditorState}
      username={config.username}
      cursorColor={config.cursorColor}
    />
  )
}
