/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import { readFileSync } from 'fs'
import { join } from 'path'

import SharedView, { decryptFailureReason, readShareEnvelope } from './SharedView'

/**
 * THE BUG THESE TESTS EXIST FOR.
 *
 * Every share link the app produced rendered "Invalid link / This share link is
 * invalid or the key is missing." Nothing was wrong with the link, the key, the
 * crypto or the server: the api-gateway wraps EVERY service response as
 * `{ meta, data }` (`HttpServiceProxy.sendDecorated`,
 * `DirectCallServiceProxy.sendDecoratedResponse`, `GRPCServiceProxy`), and the
 * viewer read `body.encryptedPayload` from the TOP level, where it never is.
 *
 * Measured live against a share created through the real modal on a running
 * stack (`GET /v1/shares/<id>` → 200):
 *
 *   {"meta":{"auth":{},"server":{…}},
 *    "data":{"type":"note","encryptedPayload":"{\"v\":1,\"nonce\":…}",
 *            "oneTimeView":false,"viewExpiresMinutes":null}}
 *
 * The viewer is the ONLY share consumer that does a bare `fetch`: every authed
 * caller goes through snjs's `HttpService`, whose `HttpResponse` maps `data`
 * straight off that envelope, so the creator side never saw the wrapper. That
 * asymmetry is why `shareCrypto.spec.ts` stayed green while no link worked, and
 * it is why the first test below pins the REAL gateway body rather than a
 * hand-shaped one.
 *
 * The second thing pinned here is that the four unrelated ways a share can fail
 * no longer share one sentence.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Only `decryptShare` is used at runtime (the rest of the module's surface is
// types), so the factory deliberately does NOT `requireActual`: pulling in
// `@standardnotes/sncrypto-web` would drag libsodium into a test about response
// shapes. `decryptFailureReason` reads a duck-typed `reason`, so plain objects
// stand in for `ShareDecryptError` here — `shareCrypto.spec.ts` covers the real
// error's reasons against real libsodium.
jest.mock('./shareCrypto', () => ({
  decryptShare: jest.fn(),
}))

const { decryptShare } = jest.requireMock('./shareCrypto') as { decryptShare: jest.Mock }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHARE_ID = '002d6d3a-98e5-4e30-9765-36d8061f7843'
const KEY_HEX = 'bf2fabd7025c24d98b6ad3646582a1094539f5d3f25f22f256bcd017052f1bb6'
const CIPHERTEXT_ENVELOPE = '{"v":1,"nonce":"746d60b6a7d8c2a2","ciphertext":"98Dt7ApAM0rMyZiHTLNRkQ=="}'

/** The exact body the api-gateway returns for a public share read. */
const gatewayBody = (overrides: Record<string, unknown> = {}) => ({
  meta: { auth: {}, server: { filesServerUrl: 'http://127.0.0.1:3061/files' } },
  data: {
    type: 'note',
    encryptedPayload: CIPHERTEXT_ENVELOPE,
    oneTimeView: false,
    viewExpiresMinutes: null,
    ...overrides,
  },
})

type FetchStub = { status: number; body: unknown; jsonThrows?: boolean; networkError?: boolean }

const stubFetch = (stub: FetchStub) => {
  const fetchMock = jest.fn(async () => {
    if (stub.networkError) {
      throw new Error('network down')
    }
    return {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      json: async () => {
        if (stub.jsonThrows) {
          throw new Error('Unexpected token < in JSON')
        }
        return stub.body
      },
    }
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
  return fetchMock
}

const setLocation = (keyHex: string | null) => {
  window.history.replaceState(null, '', `/?shared=${SHARE_ID}${keyHex === null ? '' : `#${keyHex}`}`)
}

describe('SharedView', () => {
  let container: HTMLElement
  let root: Root
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(window as unknown as { defaultSyncServer?: string }).defaultSyncServer = 'http://127.0.0.1:3061'
    setLocation(KEY_HEX)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    errorSpy.mockRestore()
  })

  const render = async () => {
    await act(async () => {
      root.render(createElement(SharedView, { shareId: SHARE_ID }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const failureReason = () => container.querySelector('[data-failure-reason]')?.getAttribute('data-failure-reason')

  describe('the gateway response envelope', () => {
    it('renders the shared note from the api-gateway `{ meta, data }` envelope', async () => {
      decryptShare.mockResolvedValue({ kind: 'note', title: 'Quarterly plan', text: 'the secret body' })
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      // The regression: this used to render the one-size-fits-all invalid-link box.
      expect(failureReason()).toBeUndefined()
      expect(container.textContent).toContain('Quarterly plan')
      expect(container.textContent).toContain('the secret body')
      // …and the ciphertext from INSIDE `data` is what was handed to the crypto,
      // together with the fragment key.
      expect(decryptShare).toHaveBeenCalledWith(CIPHERTEXT_ENVELOPE, KEY_HEX)
    })

    it('still renders an unwrapped service response (a deployment pointed straight at auth)', async () => {
      decryptShare.mockResolvedValue({ kind: 'note', title: 'Flat body', text: 'no gateway here' })
      stubFetch({
        status: 200,
        body: { type: 'note', encryptedPayload: CIPHERTEXT_ENVELOPE, oneTimeView: false, viewExpiresMinutes: null },
      })

      await render()

      expect(container.textContent).toContain('Flat body')
      expect(decryptShare).toHaveBeenCalledWith(CIPHERTEXT_ENVELOPE, KEY_HEX)
    })

    it('reads the burn metadata from the same level as the payload, not the top level', async () => {
      decryptShare.mockResolvedValue({ kind: 'note', title: 'Burns', text: 'once' })
      stubFetch({ status: 200, body: gatewayBody({ oneTimeView: true, viewExpiresMinutes: 15 }) })

      await render()

      // Reading `oneTimeView` off the wrapper would quietly render a burn link as
      // an ordinary one — the reader would never learn it had been consumed.
      expect(container.textContent).toContain('selfDestructTitle')
      expect(container.textContent).toContain('oneTimeViewConsumed')
    })

    it('shows the time-limited banner for an expiring, non-burn share', async () => {
      decryptShare.mockResolvedValue({ kind: 'note', title: 'Expires', text: 'soon' })
      stubFetch({ status: 200, body: gatewayBody({ oneTimeView: false, viewExpiresMinutes: 30 }) })

      await render()

      expect(container.textContent).toContain('linkExpires')
      expect(container.textContent).not.toContain('selfDestructTitle')
    })

    it('renders a shared tag bundle out of the envelope', async () => {
      decryptShare.mockResolvedValue({
        kind: 'tag',
        title: 'Recipes',
        notes: [{ title: 'Bread', text: 'flour and water' }],
      })
      stubFetch({ status: 200, body: gatewayBody({ type: 'tag' }) })

      await render()

      expect(container.textContent).toContain('Recipes')
      expect(container.textContent).toContain('Bread')
      expect(container.textContent).toContain('flour and water')
    })
  })

  describe('the four unrelated failures that used to share one sentence', () => {
    it('says the KEY IS MISSING when the fragment was lost', async () => {
      setLocation(null)
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      expect(failureReason()).toBe('missing-key')
      expect(container.textContent).toContain('missingKeyTitle')
      expect(container.textContent).toContain('missingKeyMessage')
      // No request should even be attempted without a key.
      expect(decryptShare).not.toHaveBeenCalled()
    })

    it('blames the SERVER REPLY when no envelope is present at either level', async () => {
      stubFetch({ status: 200, body: { meta: {}, data: { type: 'note' } } })

      await render()

      expect(failureReason()).toBe('unreadable')
      expect(container.textContent).toContain('payloadUnreadableTitle')
      expect(decryptShare).not.toHaveBeenCalled()
    })

    it('blames the SERVER REPLY when the body is not JSON at all', async () => {
      stubFetch({ status: 200, body: null, jsonThrows: true })

      await render()

      expect(failureReason()).toBe('unreadable')
    })

    it('blames the SERVER SIDE of the share for a malformed envelope, not the reader’s link', async () => {
      decryptShare.mockRejectedValue({ reason: 'malformed-envelope', message: 'not our JSON' })
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      expect(failureReason()).toBe('unreadable')
      expect(container.textContent).toContain('payloadUnreadableTitle')
    })

    it('says the link COULD NOT BE DECRYPTED for a wrong or truncated key', async () => {
      decryptShare.mockRejectedValue({ reason: 'wrong-key', message: 'aead verification failed' })
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      expect(failureReason()).toBe('undecryptable')
      expect(container.textContent).toContain('undecryptableTitle')
      expect(container.textContent).toContain('undecryptableMessage')
    })

    it('says the BROWSER could not load the crypto library, and does not blame the link', async () => {
      decryptShare.mockRejectedValue({ reason: 'crypto-unavailable', message: 'wasm blocked' })
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      expect(failureReason()).toBe('crypto-unavailable')
      expect(container.textContent).toContain('cryptoUnavailableTitle')
      expect(container.textContent).not.toContain('undecryptableTitle')
    })

    it('reports an unrecognised failure as UNEXPECTED rather than guessing a class', async () => {
      decryptShare.mockRejectedValue(new Error('something else entirely'))
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      expect(failureReason()).toBe('unexpected')
      expect(container.textContent).toContain('unexpectedFailureTitle')
    })

    it('logs the underlying error instead of swallowing it in a bare catch', async () => {
      const underlying = { reason: 'wrong-key', message: 'aead verification failed' }
      decryptShare.mockRejectedValue(underlying)
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      const logged = errorSpy.mock.calls.filter((call) => String(call[0]).startsWith('[share]'))
      expect(logged).toHaveLength(1)
      expect(logged[0][0]).toContain('undecryptable')
      expect(logged[0][0]).toContain(SHARE_ID)
      expect(logged[0][1]).toBe(underlying)
    })

    it('never puts the fragment key on screen, whichever way it failed', async () => {
      decryptShare.mockRejectedValue({ reason: 'wrong-key' })
      stubFetch({ status: 200, body: gatewayBody() })

      await render()

      expect(container.textContent).not.toContain(KEY_HEX)
      expect(container.innerHTML).not.toContain(KEY_HEX)
    })
  })

  describe('a share that is genuinely gone', () => {
    it('reports 404 as unavailable, not as an invalid link', async () => {
      stubFetch({ status: 404, body: { meta: {}, data: { error: { message: 'Share not found' } } } })

      await render()

      expect(container.textContent).toContain('shareUnavailableTitle')
      expect(failureReason()).toBeUndefined()
    })

    it('reports a network failure as unavailable', async () => {
      stubFetch({ status: 0, body: null, networkError: true })

      await render()

      expect(container.textContent).toContain('shareUnavailableTitle')
    })

    it('reports a 500 as unavailable', async () => {
      stubFetch({ status: 500, body: { meta: {}, data: {} } })

      await render()

      expect(container.textContent).toContain('shareUnavailableTitle')
    })
  })
})

describe('readShareEnvelope', () => {
  const envelope = '{"v":1,"nonce":"aa","ciphertext":"bb"}'

  it('finds the payload inside the api-gateway `{ meta, data }` wrapper', () => {
    expect(
      readShareEnvelope({ meta: {}, data: { encryptedPayload: envelope, oneTimeView: true, viewExpiresMinutes: 5 } }),
    ).toEqual({ encryptedPayload: envelope, oneTimeView: true, viewExpiresMinutes: 5 })
  })

  it('finds the payload in an unwrapped service response', () => {
    expect(readShareEnvelope({ encryptedPayload: envelope, oneTimeView: false, viewExpiresMinutes: null })).toEqual({
      encryptedPayload: envelope,
      oneTimeView: false,
      viewExpiresMinutes: null,
    })
  })

  it('prefers the wrapped payload when the wrapper itself also carries one', () => {
    expect(
      readShareEnvelope({ encryptedPayload: 'outer', data: { encryptedPayload: 'inner' } })?.encryptedPayload,
    ).toBe('inner')
  })

  it('defaults the burn metadata rather than inventing it', () => {
    expect(readShareEnvelope({ data: { encryptedPayload: envelope } })).toEqual({
      encryptedPayload: envelope,
      oneTimeView: false,
      viewExpiresMinutes: null,
    })
  })

  it('returns null when neither level carries a payload', () => {
    expect(readShareEnvelope({ meta: {}, data: { type: 'note' } })).toBeNull()
  })

  it('treats an empty-string payload as absent', () => {
    expect(readShareEnvelope({ data: { encryptedPayload: '' } })).toBeNull()
  })

  it('returns null for a non-object body', () => {
    expect(readShareEnvelope(null)).toBeNull()
    expect(readShareEnvelope('a string')).toBeNull()
    expect(readShareEnvelope(undefined)).toBeNull()
  })
})

describe('decryptFailureReason', () => {
  it('maps each shareCrypto reason onto its own reader-facing class', () => {
    expect(decryptFailureReason({ reason: 'crypto-unavailable' })).toBe('crypto-unavailable')
    expect(decryptFailureReason({ reason: 'malformed-envelope' })).toBe('unreadable')
    expect(decryptFailureReason({ reason: 'wrong-key' })).toBe('undecryptable')
  })

  it('does not guess for anything else', () => {
    expect(decryptFailureReason(new Error('plain'))).toBe('unexpected')
    expect(decryptFailureReason({ reason: 'something-new' })).toBe('unexpected')
    expect(decryptFailureReason(null)).toBe('unexpected')
    expect(decryptFailureReason(undefined)).toBe('unexpected')
  })
})

/**
 * The viewer-side half of the note-type wiring, and the bundle shape the
 * public page depends on.
 *
 * `SharedView` reads `noteType` off the decrypted payload STRUCTURALLY
 * (`shareCrypto.ts` belongs to the embedded-assets work, so the viewer does
 * not require a change there) and hands it to `SharedNoteContent`. Without
 * this test a mutation that always returns `undefined` from that reader
 * survives: every current share envelope omits the field, so nothing else
 * would notice.
 */
describe('the declared note type reaches the renderer', () => {
  let container: HTMLElement
  let root: Root
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(window as unknown as { defaultSyncServer?: string }).defaultSyncServer = 'http://127.0.0.1:3061'
    window.history.replaceState(null, '', `/?shared=${SHARE_ID}#${KEY_HEX}`)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    errorSpy.mockRestore()
  })

  const renderShare = async () => {
    await act(async () => {
      root.render(createElement(SharedView, { shareId: SHARE_ID }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('renders a declared plaintext note verbatim rather than as markdown', async () => {
    decryptShare.mockResolvedValue({
      kind: 'note',
      title: 'Plain',
      text: '# NOT A HEADING\n\n**NOT BOLD**',
      noteType: 'plain-text',
    })
    stubFetch({ status: 200, body: gatewayBody() })

    await renderShare()

    const block = container.querySelector('[data-shared-note-format="plain"]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('# NOT A HEADING')
    expect(container.querySelector('article h1')?.textContent).toBe('Plain')
    expect(container.querySelectorAll('article h1')).toHaveLength(1)
  })

  it('renders a declared rich-text note as markup rather than printing it', async () => {
    decryptShare.mockResolvedValue({
      kind: 'note',
      title: 'Legacy',
      text: '<p>REAL PARAGRAPH</p>',
      noteType: 'rich-text',
    })
    stubFetch({ status: 200, body: gatewayBody() })

    await renderShare()

    expect(container.querySelector('[data-shared-note-format="html"] p')?.textContent).toBe('REAL PARAGRAPH')
    expect(container.textContent).not.toContain('<p>')
  })

  it('applies the declared note type to every note in a shared tag bundle', async () => {
    decryptShare.mockResolvedValue({
      kind: 'tag',
      title: 'Bundle',
      notes: [{ title: 'One', text: '# NOT A HEADING', noteType: 'plain-text' }],
    })
    stubFetch({ status: 200, body: gatewayBody() })

    await renderShare()

    expect(container.querySelector('[data-shared-note-format="plain"]')?.textContent).toContain('# NOT A HEADING')
  })
})

/**
 * The Super renderer must stay behind a DYNAMIC import. A plain `import` of it
 * type-checks, passes every test above, and silently moves Lexical plus the
 * whole node registry — mermaid, excalidraw, katex, prism, the chart nodes —
 * into the first bytes the public page downloads. Measured on a production
 * build: splitting the routes took the eagerly loaded `app.js` from 11 335 189
 * to 3 070 370 bytes, and the whole share page from 12 779 166 to 6 814 262.
 */
describe('the Super renderer stays out of the eagerly loaded bundle', () => {
  const source = readFileSync(join(__dirname, 'SharedNoteContent.tsx'), 'utf8')

  it('is reached through a dynamic import', () => {
    expect(source).toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/SharedSuperContent'\)\)/)
  })

  it('is not also imported statically', () => {
    expect(source).not.toMatch(/^import .*SharedSuperContent/m)
  })

  it('keeps the share route itself behind a dynamic import', () => {
    const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8')
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/Components\/SharedView\/SharedView'\)\)/)
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\('\.\/Components\/ApplicationGroupView\/ApplicationGroupView'\)\)/)
    expect(app).not.toMatch(/^import ApplicationGroupView from/m)
  })
})
