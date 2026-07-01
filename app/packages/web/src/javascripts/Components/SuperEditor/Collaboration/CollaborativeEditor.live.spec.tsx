/**
 * @jest-environment jsdom
 *
 * DEFINITIVE end-to-end test: two REAL Lexical editors (the same
 * @lexical/react CollaborationPlugin the Super editor uses) co-editing through
 * the LIVE websocket-gateway, over REAL WebSockets, with REAL AES-256-GCM
 * encryption. Typing into editor A makes the text appear in editor B — proving
 * the entire chain in one process:
 *   editor A -> @lexical/yjs binding -> Y.Doc -> EncryptedYjsProvider (AES) ->
 *   ws -> gateway relay -> ws -> EncryptedYjsProvider (AES) -> Y.Doc -> editor B.
 *
 * STACK-GATED: skips when the gateway is not reachable, so it never breaks
 * offline CI. Run with the docker stack up.
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
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Under jsdom, the bare 'ws' specifier resolves to ws's browser shim (which
// throws). Resolve the package dir and load the concrete Node implementation by
// ABSOLUTE path, which the jest resolver loads without browser-field mapping.
const nodeRequire = createRequire(__filename)
const wsDir = dirname(nodeRequire.resolve('ws/package.json'))
const NodeWebSocket = nodeRequire(join(wsDir, 'lib', 'websocket.js')) as typeof import('ws').WebSocket
import { request as httpRequest } from 'node:http'
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util'
import * as Y from 'yjs'
import type { Doc } from 'yjs'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createRoomCipher, deriveRoomKey } from './RoomCrypto'
import type { CollabChannel, CollabFrame } from './CollabChannel'

// jsdom lacks WebSocket + WebCrypto; supply Node's so the REAL provider/crypto
// run unchanged.
;(globalThis as { WebSocket?: unknown }).WebSocket = NodeWebSocket as unknown
if (!(globalThis as { crypto?: Crypto }).crypto?.subtle) {
  // jsdom installs a crypto global without `subtle` and marks it non-writable,
  // so force-replace it with Node's full WebCrypto.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
}
if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
  ;(globalThis as { TextEncoder?: unknown }).TextEncoder = NodeTextEncoder
  ;(globalThis as { TextDecoder?: unknown }).TextDecoder = NodeTextDecoder
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3106'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3106'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'
// Same secret the gateway verifies connection tokens AND room capabilities with.
const CONNECTION_TOKEN_SECRET =
  process.env.WEB_SOCKET_CONNECTION_TOKEN_SECRET ?? 'dev-ws-connection-token-secret-change-me'

// jsdom's fetch can't reach localhost; use node:http directly.
function nodeHttp(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpRequest(
      { method, hostname: u.hostname, port: u.port, path: u.pathname, headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function gatewayReachable(): Promise<boolean> {
  try {
    return (await nodeHttp('GET', `${GATEWAY_HTTP}/health`, {})).status === 200
  } catch {
    return false
  }
}

async function mint(userUuid: string, sessionUuid: string): Promise<string> {
  const body = JSON.stringify({ userUuid, sessionUuid })
  const res = await nodeHttp('POST', `${GATEWAY_HTTP}/sockets/tokens`, {
    'content-type': 'application/json',
    'x-internal-secret': INTERNAL_SECRET,
    'content-length': String(Buffer.byteLength(body)),
  }, body)
  return JSON.parse(res.text).token
}

function liveChannel(token: string, userUuid: string): Promise<CollabChannel & { close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(`${GATEWAY_WS}/?authToken=${token}`)
    const handlers = new Set<(f: CollabFrame) => void>()
    ws.on('message', (data) => {
      const raw = data.toString()
      if (raw === 'pong') return
      let frame: CollabFrame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      handlers.forEach((h) => h(frame))
    })
    ws.on('open', () =>
      resolve({
        isConnected: () => ws.readyState === NodeWebSocket.OPEN,
        send: (f) => ws.readyState === NodeWebSocket.OPEN && ws.send(JSON.stringify(f)),
        subscribe: (h) => {
          handlers.add(h)
          return () => handlers.delete(h)
        },
        // The api-gateway is not in this live harness; mint the room capability
        // directly with the gateway's connection-token secret (the same secret it
        // verifies with), mirroring what the api-gateway does after an access check.
        authorize: (room: string) =>
          Promise.resolve(
            nodeRequire('jsonwebtoken').sign({ purpose: 'collab-room', userUuid, room }, CONNECTION_TOKEN_SECRET, {
              algorithm: 'HS256',
              expiresIn: 300,
            }) as string,
          ),
        close: () => ws.close(),
      }),
    )
    ws.on('error', reject)
    setTimeout(() => reject(new Error('ws open timeout')), 8000)
  })
}

type Captured = { editor: LexicalEditor; provider: EncryptedYjsProvider }

function CapturePlugin({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    onReady(editor)
  }, [editor, onReady])
  return null
}

function makeEditorTree(room: string, channel: CollabChannel, cipher: ReturnType<typeof createRoomCipher>, bootstrap: boolean, capture: (c: Captured) => void) {
  let provider: EncryptedYjsProvider
  const providerFactory = (id: string, docMap: Map<string, Doc>) => {
    let doc = docMap.get(id)
    if (!doc) {
      doc = new Y.Doc()
      docMap.set(id, doc)
    }
    provider = new EncryptedYjsProvider(doc, room, channel, cipher)
    return provider
  }
  return createElement(
    LexicalCollaboration,
    null,
    createElement(
      LexicalComposer,
      { initialConfig: { namespace: 'Live', editorState: null, onError: (e: Error) => { throw e } } },
      createElement(PlainTextPlugin, {
        contentEditable: createElement(ContentEditable, {}),
        placeholder: null,
        ErrorBoundary: LexicalErrorBoundary,
      }),
      createElement(CollaborationPlugin, { id: room, providerFactory, shouldBootstrap: bootstrap }),
      createElement(CapturePlugin, { onReady: (editor: LexicalEditor) => capture({ editor, provider }) }),
    ),
  )
}

const settle = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })

function textOf(editor: LexicalEditor): string {
  let text = ''
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent()
  })
  return text
}

describe('Collaborative editor over the LIVE gateway (definitive e2e)', () => {
  jest.setTimeout(40000)
  let up = false
  beforeAll(async () => {
    up = await gatewayReachable()
    if (!up) console.warn('SKIP: gateway not reachable on', GATEWAY_HTTP)
  })

  it('typing in editor A appears in editor B through the real encrypted gateway', async () => {
    if (!up) return

    const room = 'note-live-' + Date.now()
    const secret = 'shared-vault-secret'
    const [keyA, keyB] = await Promise.all([deriveRoomKey(secret, room), deriveRoomKey(secret, room)])
    const userA = 'live-a-' + Date.now()
    const userB = 'live-b-' + Date.now()
    const chA = await liveChannel(await mint(userA, 'sa'), userA)
    const chB = await liveChannel(await mint(userB, 'sb'), userB)

    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.append(containerA, containerB)
    let capA: Captured | undefined
    let capB: Captured | undefined
    let rootA: Root
    let rootB: Root

    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(makeEditorTree(room, chA, createRoomCipher(keyA), true, (c) => (capA = c)))
    })
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(makeEditorTree(room, chB, createRoomCipher(keyB), false, (c) => (capB = c)))
    })
    await settle(800)

    capA!.editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const p = $createParagraphNode()
        p.append($createTextNode('typed over the wire'))
        root.append(p)
      },
      { discrete: true },
    )
    await settle(1200)

    expect(textOf(capA!.editor)).toContain('typed over the wire')
    expect(textOf(capB!.editor)).toContain('typed over the wire')

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
    chA.close()
    chB.close()
  })
})
