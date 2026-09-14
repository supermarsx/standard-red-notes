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
 * OPT-IN: the whole suite is skipped unless SRN_LIVE_GATEWAY=1. It used to
 * gate itself on reachability and return early, which reported a PASS whenever
 * the stack was down — a green that proved nothing. Now an explicit opt-in run
 * FAILS if the gateway is unreachable, and an ordinary run skips out loud.
 *
 * Run it with the docker stack up:
 *   SRN_LIVE_GATEWAY=1 yarn workspace @standardnotes/web jest --config jest.config.js CollaborativeEditor.live
 */
import { act, createElement, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext'
import { $getRoot, $createParagraphNode, $createTextNode, LexicalEditor } from 'lexical'
import { webcrypto, randomBytes } from 'node:crypto'
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
import { createRoomCipher } from './RoomCrypto'
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

const LIVE = process.env.SRN_LIVE_GATEWAY === '1'
// The public front door (the app nginx), which is the only origin a browser
// uses, and where the socket must be reachable.
const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? 'http://localhost:3001'
const GATEWAY_WS = process.env.GATEWAY_WS ?? 'ws://localhost:3001/sockets'
const GATEWAY_HEALTH_PATH = process.env.GATEWAY_HEALTH_PATH ?? '/healthcheck/readiness'
// The internal mint is a different origin on purpose: nginx blanks
// `X-Internal-Secret` on `/sockets`, and the gateway refuses an internal mint
// whenever `x-forwarded-for` is present or the peer is not loopback. So the
// token has to be minted against the gateway's own port, from this machine.
const GATEWAY_INTERNAL_HTTP = process.env.GATEWAY_INTERNAL_HTTP ?? 'http://localhost:3106'
const INTERNAL_SECRET = process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ?? 'dev-ws-internal-secret-change-me'
// Collaboration protocol v3 binds every room membership to a room epoch and a
// security epoch; the capability must pin the identical pair the join carries.
// Hex, not base64url: epochs are echoed through identifier validation and a
// leading `-`/`_` would fail a fraction of runs.
const COLLABORATION_PROTOCOL_VERSION = 3
const ROOM_EPOCH = randomBytes(16).toString('hex')
const COLLABORATION_SECURITY_EPOCH = randomBytes(16).toString('hex')
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
    const req = httpRequest({ method, hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.on('error', reject)
    if (body) {
      req.write(body)
    }
    req.end()
  })
}

async function gatewayReachable(): Promise<boolean> {
  try {
    return (await nodeHttp('GET', `${GATEWAY_HTTP}${GATEWAY_HEALTH_PATH}`, {})).status === 200
  } catch {
    return false
  }
}

async function mint(userUuid: string, sessionUuid: string): Promise<string> {
  const body = JSON.stringify({ userUuid, sessionUuid })
  const res = await nodeHttp(
    'POST',
    `${GATEWAY_INTERNAL_HTTP}/sockets/tokens`,
    {
      'content-type': 'application/json',
      'x-internal-secret': INTERNAL_SECRET,
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  )
  return JSON.parse(res.text).token
}

/** A protocol-v3 room capability, pinned to the epoch pair the join carries. */
function roomCapability(
  userUuid: string,
  room: string,
  leaseRequestId: string | undefined,
  roomEpoch: string,
  bootstrapChallenge?: string,
): string {
  return nodeRequire('jsonwebtoken').sign(
    {
      purpose: 'collab-room',
      userUuid,
      room,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      collaborationAuthorizationIssuedAt: 1,
      serverUpdatedAtTimestamp: 1,
      roomEpoch,
      collaborationSecurityEpoch: COLLABORATION_SECURITY_EPOCH,
      ...(leaseRequestId ? { leaseRequestId } : {}),
      ...(bootstrapChallenge ? { bootstrapChallenge } : {}),
    },
    CONNECTION_TOKEN_SECRET,
    { algorithm: 'HS256', expiresIn: 300 },
  ) as string
}

function liveChannel(token: string, userUuid: string): Promise<CollabChannel & { close: () => void }> {
  return new Promise((resolve, reject) => {
    // GATEWAY_WS already ends in the pinned `/sockets` pathname (contract C13);
    // the legacy lane closes 1008 `unknown path` on anything else.
    const ws = new NodeWebSocket(`${GATEWAY_WS}?authToken=${token}`)
    const handlers = new Set<(f: CollabFrame) => void>()
    ws.on('message', (data) => {
      const raw = data.toString()
      if (raw === 'pong') {
        return
      }
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
        authorize: (room: string, leaseRequestId?: string, bootstrapChallenge?: string) =>
          Promise.resolve(roomCapability(userUuid, room, leaseRequestId, ROOM_EPOCH, bootstrapChallenge)),
        authorizeEpochBound: (
          room: string,
          expectedRoomEpoch: string,
          leaseRequestId?: string,
          bootstrapChallenge?: string,
        ) =>
          Promise.resolve({
            capability: roomCapability(userUuid, room, leaseRequestId, expectedRoomEpoch, bootstrapChallenge),
            roomEpoch: expectedRoomEpoch,
            collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION as 3,
          }),
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

function makeEditorTree(
  room: string,
  channel: CollabChannel,
  cipher: ReturnType<typeof createRoomCipher>,
  bootstrap: boolean,
  capture: (c: Captured) => void,
) {
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
      {
        initialConfig: {
          namespace: 'Live',
          editorState: null,
          onError: (e: Error) => {
            throw e
          },
        },
      },
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

// Opt-in only. Without SRN_LIVE_GATEWAY=1 the suite is skipped rather than
// passed, so an offline run can never be mistaken for a proven one.
;(LIVE ? describe : describe.skip)('Collaborative editor over the LIVE gateway (definitive e2e)', () => {
  jest.setTimeout(40000)
  beforeAll(async () => {
    // An explicit live run that cannot reach the gateway is a failure. The old
    // early-return turned exactly this case into a green test.
    if (!(await gatewayReachable())) {
      throw new Error(`SRN_LIVE_GATEWAY=1 but the gateway is unreachable on ${GATEWAY_HTTP}${GATEWAY_HEALTH_PATH}`)
    }
  })

  it('typing in editor A appears in editor B through the real encrypted gateway', async () => {
    const room = 'note-live-' + Date.now()
    const roomKey = (await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey
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
      rootA.render(makeEditorTree(room, chA, createRoomCipher(roomKey), true, (c) => (capA = c)))
    })
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(makeEditorTree(room, chB, createRoomCipher(roomKey), false, (c) => (capB = c)))
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
