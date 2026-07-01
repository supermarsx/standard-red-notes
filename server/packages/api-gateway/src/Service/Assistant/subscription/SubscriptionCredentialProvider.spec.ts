import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ChatGptOAuthConfig } from './oauthConfig'
import { PairingStateStore, SubscriptionCredentialProvider } from './SubscriptionCredentialProvider'
import { SubscriptionTokenRecord, SubscriptionTokenStore } from './SubscriptionTokenStore'

const config: ChatGptOAuthConfig = {
  authorizeUrl: 'https://id.test/authorize',
  tokenUrl: 'https://id.test/token',
  clientId: 'client-x',
  redirectUri: 'https://notes.test/v1/assistant/subscription/callback',
  scopes: 'openid offline_access',
  accountIdClaimPath: 'https://api.openai.com/auth.chatgpt_account_id',
}

function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

function mockFetch(impl: () => { ok: boolean; status: number; body: unknown }): jest.Mock {
  const fetchMock = jest.fn().mockImplementation(async () => {
    const { ok, status, body } = impl()
    return { ok, status, json: async () => body }
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('SubscriptionCredentialProvider', () => {
  let dir: string
  let store: SubscriptionTokenStore
  const key = crypto.randomBytes(32).toString('hex')

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-provider-'))
    store = new SubscriptionTokenStore(path.join(dir, 'sub.json'), key)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  describe('beginPairing + completePairing', () => {
    it('issues an authorize URL with state and persists the exchanged credential', async () => {
      mockFetch(() => ({
        ok: true,
        status: 200,
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          id_token: makeIdToken({ 'https://api.openai.com/auth.chatgpt_account_id': 'acct-9' }),
          expires_in: 3600,
        },
      }))
      const provider = new SubscriptionCredentialProvider(store, config)

      const { authorizeUrl, state } = provider.beginPairing('admin-uuid')
      expect(state).toBeTruthy()
      const url = new URL(authorizeUrl)
      expect(url.searchParams.get('state')).toBe(state)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toBeTruthy()

      const record = await provider.completePairing(state, 'auth-code')
      expect(record.accessToken).toBe('access-1')
      expect(record.accountId).toBe('acct-9')

      const status = await provider.getStatus()
      expect(status.paired).toBe(true)
      expect(status.accountId).toBe('acct-9')
    })

    it('rejects an unknown / never-issued state', async () => {
      const provider = new SubscriptionCredentialProvider(store, config)
      await expect(provider.completePairing('nope', 'code')).rejects.toThrow(/Invalid, expired, or already-used/)
    })

    it('rejects a replayed (already-consumed) state', async () => {
      mockFetch(() => ({ ok: true, status: 200, body: { access_token: 'a', expires_in: 3600 } }))
      const provider = new SubscriptionCredentialProvider(store, config)
      const { state } = provider.beginPairing('admin-uuid')

      await provider.completePairing(state, 'code')
      await expect(provider.completePairing(state, 'code')).rejects.toThrow(/already-used/)
    })
  })

  describe('getFreshCredential', () => {
    it('returns null when unpaired', async () => {
      const provider = new SubscriptionCredentialProvider(store, config)
      expect(await provider.getFreshCredential()).toBeNull()
    })

    it('returns the stored token when it is comfortably valid (no refresh)', async () => {
      const record: SubscriptionTokenRecord = {
        accessToken: 'valid-access',
        refreshToken: 'r',
        expiresAt: Date.now() + 3600 * 1000,
        accountId: 'acct-1',
        pairedAt: Date.now(),
      }
      await store.save(record)
      const fetchMock = mockFetch(() => ({ ok: true, status: 200, body: {} }))

      const provider = new SubscriptionCredentialProvider(store, config)
      const credential = await provider.getFreshCredential()

      expect(credential).toEqual({ token: 'valid-access', accountId: 'acct-1' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refreshes and persists rotated tokens when near expiry', async () => {
      await store.save({
        accessToken: 'stale-access',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 1000, // within the skew window
        accountId: 'acct-1',
        pairedAt: Date.now(),
      })
      mockFetch(() => ({
        ok: true,
        status: 200,
        body: { access_token: 'fresh-access', refresh_token: 'refresh-new', expires_in: 3600 },
      }))

      const provider = new SubscriptionCredentialProvider(store, config)
      const credential = await provider.getFreshCredential()

      expect(credential?.token).toBe('fresh-access')
      const persisted = await store.load()
      expect(persisted?.accessToken).toBe('fresh-access')
      expect(persisted?.refreshToken).toBe('refresh-new')
      expect(persisted?.needsRepair).toBeFalsy()
    })

    it('marks the store needsRepair and returns null when the refresh fails', async () => {
      await store.save({
        accessToken: 'stale-access',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 1000,
        pairedAt: Date.now(),
      })
      mockFetch(() => ({ ok: false, status: 400, body: { error: 'invalid_grant' } }))

      const provider = new SubscriptionCredentialProvider(store, config)
      expect(await provider.getFreshCredential()).toBeNull()

      const status = await provider.getStatus()
      expect(status.needsRepair).toBe(true)
      // A subsequent call short-circuits on needsRepair without another refresh.
      expect(await provider.getFreshCredential()).toBeNull()
    })

    it('marks needsRepair when near expiry with no refresh token', async () => {
      await store.save({
        accessToken: 'stale-access',
        expiresAt: Date.now() + 1000,
        pairedAt: Date.now(),
      })
      const provider = new SubscriptionCredentialProvider(store, config)
      expect(await provider.getFreshCredential()).toBeNull()
      expect((await provider.getStatus()).needsRepair).toBe(true)
    })
  })

  describe('unpair', () => {
    it('clears the stored credential', async () => {
      await store.save({ accessToken: 'a', expiresAt: Date.now() + 3600 * 1000, pairedAt: Date.now() })
      const provider = new SubscriptionCredentialProvider(store, config)
      await provider.unpair()
      expect((await provider.getStatus()).paired).toBe(false)
    })
  })
})

describe('PairingStateStore', () => {
  it('consumes a state exactly once', () => {
    const s = new PairingStateStore()
    s.put('st', 'verifier', 'admin')
    expect(s.consume('st')).toMatchObject({ verifier: 'verifier', adminUuid: 'admin' })
    expect(s.consume('st')).toBeNull()
  })

  it('returns null for an expired state', () => {
    const s = new PairingStateStore(-1) // already expired
    s.put('st', 'verifier', 'admin')
    expect(s.consume('st')).toBeNull()
  })
})
