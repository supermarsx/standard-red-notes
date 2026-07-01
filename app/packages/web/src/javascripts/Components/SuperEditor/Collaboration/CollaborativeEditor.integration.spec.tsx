/**
 * @jest-environment jsdom
 *
 * EDITOR-LEVEL end-to-end test for live co-editing. Unlike the provider unit
 * test (which asserts two Y.Docs converge), this mounts two REAL Lexical editors
 * wired with @lexical/react's CollaborationPlugin — the exact component the Super
 * editor uses — and proves that typing into one editor makes the text appear in
 * the OTHER editor. This exercises the actual @lexical/yjs binding
 * (editor -> Y.Doc -> relay -> Y.Doc -> editor), not just the transport.
 *
 * Transport here is an in-memory hub that mirrors the gateway's room semantics;
 * the separate collab-yjs.e2e.mjs proves the same flow over the LIVE gateway
 * with real encryption.
 */
import { createElement, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext'
import { $getRoot, $createParagraphNode, $createTextNode, LexicalEditor } from 'lexical'
import * as Y from 'yjs'
import type { Doc } from 'yjs'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createPlaintextCipher } from './RoomCrypto'
import type { CollabChannel, CollabFrame } from './CollabChannel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Gateway-mirroring loopback: frames go to every OTHER member of the room; a join
// prompts existing members to re-sync.
class LoopbackHub {
  private readonly handlers = new Map<symbol, (f: CollabFrame) => void>()
  private readonly rooms = new Map<string, Set<symbol>>()
  channel(): CollabChannel {
    const id = Symbol('chan')
    return {
      isConnected: () => true,
      subscribe: (h) => {
        this.handlers.set(id, h)
        return () => this.handlers.delete(id)
      },
      send: (f) => this.relay(id, f),
      authorize: () => Promise.resolve('test-capability'),
    }
  }
  private relay(from: symbol, frame: CollabFrame): void {
    if (frame.t === 'room-join') {
      const set = this.rooms.get(frame.room) ?? new Set<symbol>()
      set.add(from)
      this.rooms.set(frame.room, set)
      for (const m of set) if (m !== from) this.handlers.get(m)?.({ t: 'room-sync', room: frame.room })
      return
    }
    if (frame.t === 'room-leave') {
      this.rooms.get(frame.room)?.delete(from)
      return
    }
    const members = this.rooms.get(frame.room)
    if (!members) return
    for (const m of members) if (m !== from) this.handlers.get(m)?.(frame)
  }
}

type Captured = { editor: LexicalEditor; provider: EncryptedYjsProvider }

function CapturePlugin({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    onReady(editor)
  }, [editor, onReady])
  return null
}

function CollabEditor(props: { hub: LoopbackHub; room: string; bootstrap: boolean; capture: (c: Captured) => void }) {
  const { hub, room, bootstrap, capture } = props
  let provider: EncryptedYjsProvider
  const providerFactory = (id: string, docMap: Map<string, Doc>) => {
    let doc = docMap.get(id)
    if (!doc) {
      doc = new Y.Doc()
      docMap.set(id, doc)
    }
    provider = new EncryptedYjsProvider(doc, room, hub.channel(), createPlaintextCipher())
    return provider
  }
  return createElement(
    LexicalCollaboration,
    null,
    createElement(
      LexicalComposer,
      { initialConfig: { namespace: 'Test', editorState: null, onError: (e: Error) => { throw e } } },
      createElement(PlainTextPlugin, {
        contentEditable: createElement(ContentEditable, {}),
        placeholder: null,
        ErrorBoundary: LexicalErrorBoundary,
      }),
      createElement(CollaborationPlugin, {
        id: room,
        providerFactory,
        shouldBootstrap: bootstrap,
      }),
      createElement(CapturePlugin, { onReady: (editor: LexicalEditor) => capture({ editor, provider }) }),
    ),
  )
}

async function flush(...providers: EncryptedYjsProvider[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.all(providers.map((p) => p.flush()))
      await Promise.resolve()
    })
  }
}

function textOf(editor: LexicalEditor): string {
  let text = ''
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent()
  })
  return text
}

function typeInto(editor: LexicalEditor, content: string): void {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const p = $createParagraphNode()
      p.append($createTextNode(content))
      root.append(p)
    },
    { discrete: true },
  )
}

describe('Collaborative editor (editor-level e2e)', () => {
  jest.setTimeout(20000)

  it('text typed in editor A appears in editor B through the relay', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-1'
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.append(containerA, containerB)

    let capA: Captured | undefined
    let capB: Captured | undefined
    let rootA: Root
    let rootB: Root

    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(createElement(CollabEditor, { hub, room, bootstrap: true, capture: (c) => (capA = c) }))
    })
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(createElement(CollabEditor, { hub, room, bootstrap: false, capture: (c) => (capB = c) }))
    })
    expect(capA && capB).toBeTruthy()
    await flush(capA!.provider, capB!.provider)

    typeInto(capA!.editor, 'hello from A')
    await flush(capA!.provider, capB!.provider)

    expect(textOf(capA!.editor)).toContain('hello from A')
    expect(textOf(capB!.editor)).toContain('hello from A')

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })

  it('a late joiner sees content that already existed in the shared doc', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-2'
    const containerA = document.createElement('div')
    document.body.append(containerA)

    let capA: Captured | undefined
    let rootA: Root
    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(createElement(CollabEditor, { hub, room, bootstrap: true, capture: (c) => (capA = c) }))
    })
    await flush(capA!.provider)
    typeInto(capA!.editor, 'written before B joined')
    await flush(capA!.provider)

    // B joins late.
    const containerB = document.createElement('div')
    document.body.append(containerB)
    let capB: Captured | undefined
    let rootB: Root
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(createElement(CollabEditor, { hub, room, bootstrap: false, capture: (c) => (capB = c) }))
    })
    await flush(capA!.provider, capB!.provider)

    expect(textOf(capB!.editor)).toContain('written before B joined')

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })
})
