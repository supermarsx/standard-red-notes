import snjs from '@standardnotes/snjs'
import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import type { HeadlessApp } from './bootstrap.js'

/**
 * Standard Red Notes: MCP scoped-token sign-in for the headless bridge.
 *
 * Instead of email + password + MFA (SRP -> root key -> decrypt items keys),
 * the bridge boots from a single revocable, scoped token. The token transports
 * the account's items keys, wrapped client-side under a secret the server never
 * sees. This module:
 *   1. POSTs the auth half of the token to `/v1/mcp-tokens/authenticate` to get
 *      a real session (minted server-side, bypassing SRP) plus the wrapped key
 *      material.
 *   2. Unwraps the items keys with the wrap half of the token, mirroring the web
 *      client's wrap algorithm byte-for-byte (see wrapKeys.ts).
 *   3. Injects the session + decrypted items keys into snjs WITHOUT a root key,
 *      so sync is authorized and incoming encrypted notes decrypt locally.
 */

const {
  // Session value objects (construct a Session from the raw `/authenticate` body).
  Session,
  SessionToken,
  // Payload/item primitives used to inject decrypted items keys.
  DecryptedPayload,
  PayloadEmitSource,
  ContentType,
  PayloadTimestampDefaults,
} = snjs as unknown as Record<string, any>

// Key-UNWRAP constants — MUST match app/.../McpTokens/wrapKeys.ts exactly.
const ITERATIONS = 5
const MEMORY_BYTES = 67108864
const KEY_LENGTH = 32

export interface McpScope {
  access: 'read' | 'write'
  tagUuids?: string[]
}

export interface McpTokenSignInResult {
  scope: McpScope
  /** true when the granted scope is read-only (write tools must be refused). */
  readOnly: boolean
  user: { uuid: string; email: string }
}

interface AuthenticateResponse {
  session: {
    access_token: string
    refresh_token: string
    access_expiration: number
    refresh_expiration: number
    readonly_access?: boolean
  }
  key_params: Record<string, unknown>
  user: { uuid: string; email: string }
  mcp_scope: { access: 'read' | 'write'; tagUuids?: string[] }
  mcp_key_material: { wrappedKeys: string; kdfSalt: string; kdfParams: string } | null
}

interface UnwrappedItemsKey {
  uuid: string
  itemsKey: string
  version: string
}

/** Split `<tokenUuid>.<authSecret>.<wrapSecret>` into its parts. */
export function parseFullToken(fullToken: string): {
  tokenUuid: string
  authSecret: string
  wrapSecret: string
  authToken: string
} {
  const parts = fullToken.split('.')
  if (parts.length !== 3) {
    throw new Error(
      `Invalid MCP token format: expected <tokenUuid>.<authSecret>.<wrapSecret>, got ${parts.length} parts.`,
    )
  }
  const [tokenUuid, authSecret, wrapSecret] = parts
  if (!tokenUuid || !authSecret || !wrapSecret) {
    throw new Error('Invalid MCP token: one or more segments are empty.')
  }
  return { tokenUuid, authSecret, wrapSecret, authToken: `${tokenUuid}.${authSecret}` }
}

async function authenticate(serverUrl: string, authToken: string): Promise<AuthenticateResponse> {
  const url = `${serverUrl.replace(/\/$/, '')}/v1/mcp-tokens/authenticate`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: authToken }),
  })
  const body = (await res.json().catch(() => ({}))) as { data?: AuthenticateResponse; error?: { message?: string } }
  if (res.status !== 200) {
    const message =
      (body as any)?.data?.error?.message ?? body?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`MCP token authentication failed: ${message}`)
  }
  // The gateway wraps the auth server's HttpResponse `data` payload in a top-level
  // `data` envelope ({ meta, data: { session, key_params, ... } }).
  const data = body.data
  if (!data || !data.session) {
    throw new Error('MCP token authentication returned no session.')
  }
  return data
}

/**
 * Unwrap the account's items keys from the wrapped key material using the
 * wrap-half of the token. Mirrors wrapItemsKeys()/unwrapItemsKeys() in the web
 * client; any deviation makes decryption fail.
 */
export function unwrapItemsKeys(
  keyMaterial: { wrappedKeys: string; kdfSalt: string; kdfParams: string },
  wrapSecret: string,
  crypto: any,
): UnwrappedItemsKey[] {
  const params = JSON.parse(keyMaterial.kdfParams) as {
    iterations: number
    bytes: number
    length: number
  }
  const iterations = params.iterations ?? ITERATIONS
  const bytes = params.bytes ?? MEMORY_BYTES
  const length = params.length ?? KEY_LENGTH

  const wrapKey: string = crypto.argon2(wrapSecret, keyMaterial.kdfSalt, iterations, bytes, length)

  const { nonce, ciphertext } = JSON.parse(keyMaterial.wrappedKeys) as {
    nonce: string
    ciphertext: string
  }
  const plaintext: string | null = crypto.xchacha20Decrypt(ciphertext, nonce, wrapKey)
  if (plaintext === null) {
    throw new Error('Failed to decrypt wrapped items keys (bad wrap secret or corrupt material).')
  }

  const payload = JSON.parse(plaintext) as { v: number; itemsKeys: UnwrappedItemsKey[] }
  if (!Array.isArray(payload.itemsKeys) || payload.itemsKeys.length === 0) {
    throw new Error('Unwrapped key material contained no items keys.')
  }
  return payload.itemsKeys
}

/**
 * Inject the decrypted items keys into snjs as ItemsKey items. Once present in
 * the items store, ItemsEncryption resolves them by `items_key_id` and decrypts
 * incoming notes WITHOUT a root key. EncryptionService also observes ItemsKey
 * inserts and re-runs decryptErroredItemPayloads(), so any note that arrived
 * before the keys were injected is decrypted automatically.
 *
 * The first injected key is marked isDefault so snjs has a default items key
 * (needed by some code paths); we never mark these dirty, so they are not
 * re-uploaded.
 */
async function injectItemsKeys(app: any, itemsKeys: UnwrappedItemsKey[]): Promise<void> {
  const payloads = itemsKeys.map((key, index) =>
    new DecryptedPayload({
      uuid: key.uuid,
      content_type: ContentType.TYPES.ItemsKey,
      content: {
        itemsKey: key.itemsKey,
        version: key.version,
        isDefault: index === 0,
      },
      // Not dirty: these mirror the server's existing items keys; do not re-upload.
      dirty: false,
      ...PayloadTimestampDefaults(),
    }),
  )
  await app.mutator.emitItemsFromPayloads(payloads, PayloadEmitSource.LocalInserted)
}

/**
 * Sign the headless app into the account using an MCP scoped token, without a
 * password or root key. Leaves the app authenticated, synced, and able to
 * decrypt notes.
 */
export async function signInWithMcpToken(
  app: any,
  serverUrl: string,
  fullToken: string,
): Promise<McpTokenSignInResult> {
  const { authToken, wrapSecret } = parseFullToken(fullToken)

  // 1. Authenticate the token -> real session + wrapped key material.
  const auth = await authenticate(serverUrl, authToken)

  // 2. Build a snjs Session from the raw session body and inject it. This is the
  //    same construction the normal sign-in path uses (SessionManager.createSession
  //    -> populateSession -> setSession). It authorizes all sync API calls.
  const accessTokenOrError = SessionToken.create(auth.session.access_token, auth.session.access_expiration)
  const refreshTokenOrError = SessionToken.create(auth.session.refresh_token, auth.session.refresh_expiration)
  if (accessTokenOrError.isFailed() || refreshTokenOrError.isFailed()) {
    throw new Error('Could not construct session tokens from MCP authenticate response.')
  }
  const readOnly = auth.session.readonly_access === true || auth.mcp_scope?.access === 'read'
  const sessionOrError = Session.create(
    accessTokenOrError.getValue(),
    refreshTokenOrError.getValue(),
    readOnly,
  )
  if (sessionOrError.isFailed()) {
    throw new Error('Could not construct session from MCP authenticate response.')
  }
  const session = sessionOrError.getValue()

  // Point the app at the host and remember the user, then set the session.
  await app.sessions.apiService.setHost(serverUrl)
  app.sessions.httpService.setHost(serverUrl)
  app.sessions.memoizeUser(auth.user)
  app.sessions.storage.setValue('user', auth.user)
  app.sessions.setSession(session, true)

  // The token bridge has NO root key, so it cannot decrypt the server's copies
  // of the account's items keys (they are root-key encrypted). When those arrive
  // during sync they would trigger snjs's KeyRecoveryService, which prompts for
  // the account password and dereferences account key params we never set
  // (crashing on `clientParams.identifier`). We inject the items keys ourselves
  // from the token, so recovery is neither needed nor possible — disable it by
  // deiniting the service (this removes its payload observer).
  try {
    const keyRecovery = app.dependencies?.get?.(Symbol.for('KeyRecoveryService'))
    keyRecovery?.deinit?.()
  } catch {
    // If the symbol/service shape ever changes, fall through; the worst case is
    // a harmless recovery attempt that our no-op alert/challenge services reject.
  }

  // 3. Unwrap the account's items keys with the wrap-half of the token.
  const crypto = new SNWebCrypto()
  await crypto.initialize()
  let itemsKeys: UnwrappedItemsKey[]
  try {
    if (!auth.mcp_key_material) {
      throw new Error('MCP authenticate returned no key material; cannot decrypt notes.')
    }
    itemsKeys = unwrapItemsKeys(auth.mcp_key_material, wrapSecret, crypto)
  } finally {
    crypto.deinit()
  }

  // 4. Inject the decrypted items keys BEFORE the first sync. Then, when the
  //    server's root-key-encrypted copies of those same items keys arrive, snjs
  //    already has a decrypted copy with that UUID and treats the incoming
  //    (undecryptable) copy as "ignored" instead of overwriting ours. Incoming
  //    encrypted notes resolve their items key by `items_key_id` from the store
  //    and decrypt locally — no root key required.
  await injectItemsKeys(app, itemsKeys)
  await app.sync.sync({ sourceDescription: 'mcp-token-initial' })
  // The ItemsKey insert observer runs decryptErroredItemPayloads() asynchronously;
  // give it a tick to drain, then sync once more so anything still errored at
  // injection time is re-evaluated and the local store is consistent.
  await new Promise((resolve) => setTimeout(resolve, 50))
  await app.sync.sync({ sourceDescription: 'mcp-token-post-inject' }).catch(() => {})

  return {
    scope: { access: auth.mcp_scope.access, tagUuids: auth.mcp_scope.tagUuids },
    readOnly,
    user: auth.user,
  }
}
