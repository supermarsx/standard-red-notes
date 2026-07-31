import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ChatGptOAuthConfig } from './oauthConfig'
import { PairingStateStore, SubscriptionCredentialProvider } from './SubscriptionCredentialProvider'
import { SubscriptionTokenRecord, SubscriptionTokenStore } from './SubscriptionTokenStore'

const ADMIN_A = '11111111-1111-4111-8111-111111111111'
const ADMIN_B = '22222222-2222-4222-8222-222222222222'
const START = 2_000_000_000_000

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

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockFetch(body: unknown, status = 200, headers?: Record<string, string>): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse(body, status, headers))
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function record(overrides: Partial<SubscriptionTokenRecord> = {}): SubscriptionTokenRecord {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: START + 1_000,
    pairedAt: START - 1_000,
    ...overrides,
  }
}

function state(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64url')
}

function verifier(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64url')
}

describe('SubscriptionCredentialProvider', () => {
  let dir: string
  let filePath: string
  let store: SubscriptionTokenStore
  let now: number
  const key = crypto.randomBytes(32).toString('hex')

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-provider-'))
    filePath = path.join(dir, 'sub.json')
    store = new SubscriptionTokenStore(filePath, key)
    now = START
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  describe('durable PKCE pairing lifecycle', () => {
    it('survives a provider/store restart and persists only the exchanged credential', async () => {
      mockFetch({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        id_token: makeIdToken({ 'https://api.openai.com/auth.chatgpt_account_id': 'acct-9' }),
        expires_in: 3600,
      })
      const firstProcess = new SubscriptionCredentialProvider(store, config, undefined, () => now)
      const { authorizeUrl, state: issuedState } = await firstProcess.beginPairing(ADMIN_A, 'team-a')

      const url = new URL(authorizeUrl)
      expect(url.searchParams.get('state')).toBe(issuedState)
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')

      const restartedStore = new SubscriptionTokenStore(filePath, key)
      const restartedProvider = new SubscriptionCredentialProvider(restartedStore, config, undefined, () => now)
      const authorizationCode = 'AUTH_CODE_SENTINEL'
      const paired = await restartedProvider.completePairing(issuedState, authorizationCode)

      expect(paired.accessToken).toBe('access-1')
      expect(paired.accountId).toBe('acct-9')
      expect(paired.pairedAt).toBe(now)
      expect(await restartedProvider.getStatus('team-a')).toMatchObject({ paired: true, accountId: 'acct-9' })
      const raw = await fs.readFile(filePath, 'utf8')
      for (const sentinel of [issuedState, authorizationCode, ADMIN_A, 'access-1', 'refresh-1']) {
        expect(raw).not.toContain(sentinel)
      }
    })

    it('binds authenticated manual completion to the administrator who started it', async () => {
      mockFetch({ access_token: 'access-1', expires_in: 3600 })
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)
      const attempt = await provider.beginPairing(ADMIN_A, 'team-a')

      await expect(provider.completePairing(attempt.state, 'auth-code', ADMIN_B)).rejects.toThrow(/already-used/)
      expect(global.fetch).not.toHaveBeenCalled()
      await expect(provider.completePairing(attempt.state, 'auth-code', ADMIN_A)).resolves.toMatchObject({
        accessToken: 'access-1',
      })
    })

    it('keeps the public callback contract as one-time state possession', async () => {
      mockFetch({ access_token: 'callback-access', expires_in: 3600 })
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)
      const attempt = await provider.beginPairing(ADMIN_A)

      await expect(provider.completePairing(attempt.state, 'callback-code')).resolves.toMatchObject({
        accessToken: 'callback-access',
      })
    })

    it('allows only one concurrent process to claim and exchange a state', async () => {
      const fetchMock = mockFetch({ access_token: 'only-once', expires_in: 3600 })
      const first = new SubscriptionCredentialProvider(store, config, undefined, () => now)
      const attempt = await first.beginPairing(ADMIN_A)
      const second = new SubscriptionCredentialProvider(
        new SubscriptionTokenStore(filePath, key),
        config,
        undefined,
        () => now,
      )

      const results = await Promise.allSettled([
        first.completePairing(attempt.state, 'code-one'),
        second.completePairing(attempt.state, 'code-two'),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rejects replay without allowing an older successful state to overwrite a newer pairing', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'first-access', expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ access_token: 'second-access', expires_in: 3600 }))
      global.fetch = fetchMock as unknown as typeof fetch
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      const first = await provider.beginPairing(ADMIN_A, 'team-a')
      await provider.completePairing(first.state, 'first-code')
      const second = await provider.beginPairing(ADMIN_A, 'team-a')
      await provider.completePairing(second.state, 'second-code')

      await expect(provider.completePairing(first.state, 'first-code')).rejects.toThrow(/already-used/)
      expect((await store.loadRecord('team-a'))?.accessToken).toBe('second-access')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not expose code, verifier, token, or upstream error-description sentinels', async () => {
      const secret = 'UPSTREAM_SECRET_SENTINEL'
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'invalid_request', error_description: `echo ${secret}` }, 400),
        ) as unknown as typeof fetch
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)
      const attempt = await provider.beginPairing(ADMIN_A)

      let failure = ''
      try {
        await provider.completePairing(attempt.state, `CODE_${secret}`)
      } catch (error) {
        failure = (error as Error).message
      }
      expect(failure).not.toContain(secret)
      expect(failure).not.toContain('CODE_')
    })
  })

  describe('fresh credential refresh linearization', () => {
    it('singleflights concurrent refreshes for one id', async () => {
      await store.save(record())
      const fetchMock = mockFetch({
        access_token: 'fresh-access',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      })
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      const credentials = await Promise.all([
        provider.getFreshCredential(),
        provider.getFreshCredential(),
        provider.getFreshCredential(),
      ])

      expect(credentials).toEqual([
        { token: 'fresh-access', accountId: undefined },
        { token: 'fresh-access', accountId: undefined },
        { token: 'fresh-access', accountId: undefined },
      ])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('uses store CAS so a refresh loser cannot mark a newer rotation needsRepair', async () => {
      await store.save(record())
      let resolveSuccess!: (response: Response) => void
      let resolveFailure!: (response: Response) => void
      const success = new Promise<Response>((resolve) => (resolveSuccess = resolve))
      const failure = new Promise<Response>((resolve) => (resolveFailure = resolve))
      const fetchMock = jest.fn().mockReturnValueOnce(success).mockReturnValueOnce(failure)
      global.fetch = fetchMock as unknown as typeof fetch

      const winner = new SubscriptionCredentialProvider(store, config, undefined, () => now)
      const loser = new SubscriptionCredentialProvider(
        new SubscriptionTokenStore(filePath, key),
        config,
        undefined,
        () => now,
      )
      const winnerResult = winner.getFreshCredential()
      const loserResult = loser.getFreshCredential()
      for (let attempt = 0; attempt < 100 && fetchMock.mock.calls.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(fetchMock).toHaveBeenCalledTimes(2)

      resolveSuccess(jsonResponse({ access_token: 'fresh-winner', refresh_token: 'rotated', expires_in: 3600 }))
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if ((await store.load())?.accessToken === 'fresh-winner') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect((await store.load())?.accessToken).toBe('fresh-winner')
      resolveFailure(jsonResponse({ error: 'invalid_grant' }, 400))

      await expect(winnerResult).resolves.toEqual({ token: 'fresh-winner', accountId: undefined })
      await expect(loserResult).resolves.toEqual({ token: 'fresh-winner', accountId: undefined })
      expect(await store.getStatus()).toMatchObject({ paired: true, needsRepair: false })
      expect((await store.load())?.accessToken).toBe('fresh-winner')
    }, 40_000)

    it.each([
      {
        label: 'permanent repair',
        failureResponse: jsonResponse({ error: 'invalid_grant' }, 400),
        failureWritten: async () => (await store.getStatus()).needsRepair === true,
      },
      {
        label: 'transient backoff',
        failureResponse: jsonResponse({ error: 'temporarily_unavailable' }, 503),
        failureWritten: async () => (await store.getStatus()).refreshFailureCode === 'provider-unavailable',
      },
    ])(
      'lets a successful rotation of the same credential generation clear a concurrently-written $label',
      async ({ failureResponse, failureWritten }) => {
        await store.save(record())
        let resolveSuccess!: (response: Response) => void
        let resolveFailure!: (response: Response) => void
        const success = new Promise<Response>((resolve) => (resolveSuccess = resolve))
        const failure = new Promise<Response>((resolve) => (resolveFailure = resolve))
        const fetchMock = jest.fn().mockReturnValueOnce(success).mockReturnValueOnce(failure)
        global.fetch = fetchMock as unknown as typeof fetch

        const successfulProcess = new SubscriptionCredentialProvider(store, config, undefined, () => now)
        const failingProcess = new SubscriptionCredentialProvider(
          new SubscriptionTokenStore(filePath, key),
          config,
          undefined,
          () => now,
        )

        const successfulResult = successfulProcess.getFreshCredential()
        for (let attempt = 0; attempt < 100 && fetchMock.mock.calls.length < 1; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        expect(fetchMock).toHaveBeenCalledTimes(1)

        const failingResult = failingProcess.getFreshCredential()
        for (let attempt = 0; attempt < 100 && fetchMock.mock.calls.length < 2; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        expect(fetchMock).toHaveBeenCalledTimes(2)

        resolveFailure(failureResponse)
        await expect(failingResult).resolves.toBeNull()
        expect(await failureWritten()).toBe(true)

        resolveSuccess(
          jsonResponse({
            access_token: 'fresh-after-failure',
            refresh_token: 'rotated-after-failure',
            expires_in: 3600,
          }),
        )

        await expect(successfulResult).resolves.toEqual({ token: 'fresh-after-failure', accountId: undefined })
        expect(await store.load()).toMatchObject({
          accessToken: 'fresh-after-failure',
          refreshToken: 'rotated-after-failure',
          needsRepair: false,
        })
        const finalStatus = await store.getStatus()
        expect(finalStatus.needsRepair).toBe(false)
        expect(finalStatus.refreshRetryAt).toBeUndefined()
        expect(finalStatus.refreshFailureCode).toBeUndefined()
      },
      40_000,
    )

    it('never lets a late successful refresh overwrite a newly re-paired credential generation', async () => {
      await store.save(record())
      let resolveRefresh!: (response: Response) => void
      const refresh = new Promise<Response>((resolve) => (resolveRefresh = resolve))
      const fetchMock = jest.fn().mockReturnValue(refresh)
      global.fetch = fetchMock as unknown as typeof fetch
      const oldProcess = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      const oldRefreshResult = oldProcess.getFreshCredential()
      for (let attempt = 0; attempt < 100 && fetchMock.mock.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const rePaired = record({
        accessToken: 'new-pairing-access',
        refreshToken: 'new-pairing-refresh',
        expiresAt: now + 3_600_000,
        pairedAt: now + 1,
      })
      await new SubscriptionTokenStore(filePath, key).saveRecord('default', rePaired)
      resolveRefresh(jsonResponse({ access_token: 'late-old-refresh', expires_in: 3600 }))

      await expect(oldRefreshResult).resolves.toEqual({ token: 'new-pairing-access', accountId: undefined })
      expect(await store.load()).toEqual(rePaired)
    })

    it('marks invalid_grant as permanent repair but does not persist upstream text', async () => {
      await store.save(record())
      mockFetch({ error: 'invalid_grant', error_description: 'refresh-old should never be persisted as an error' }, 400)
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      await expect(provider.getFreshCredential()).resolves.toBeNull()
      expect(await provider.getStatus()).toMatchObject({
        needsRepair: true,
        needsRepairReason: 'refresh-token-rejected',
      })
    })

    it('marks a missing refresh token as permanent repair', async () => {
      await store.save(record({ refreshToken: undefined }))
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      await expect(provider.getFreshCredential()).resolves.toBeNull()
      expect(await provider.getStatus()).toMatchObject({
        needsRepair: true,
        needsRepairReason: 'refresh-token-missing',
      })
    })

    it('records transient provider backoff without repair or inside-skew token reuse', async () => {
      await store.save(record())
      const fetchMock = mockFetch({ error: 'temporarily_unavailable' }, 503)
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      await expect(provider.getFreshCredential()).resolves.toBeNull()
      const status = await provider.getStatus()
      expect(status).toMatchObject({
        paired: true,
        needsRepair: false,
        refreshFailureCode: 'provider-unavailable',
      })
      expect(status.refreshRetryAt).toBeGreaterThan(now)

      await expect(provider.getFreshCredential()).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      now = (status.refreshRetryAt as number) + 1
      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'recovered', expires_in: 3600 }))
      await expect(provider.getFreshCredential()).resolves.toEqual({ token: 'recovered', accountId: undefined })
      expect(await provider.getStatus()).toMatchObject({ paired: true, needsRepair: false })
      expect((await provider.getStatus()).refreshRetryAt).toBeUndefined()
    })

    it('honors bounded rate-limit retry-after without turning it into repair', async () => {
      await store.save(record())
      mockFetch({ error: 'rate_limit_exceeded' }, 429, { 'retry-after': '999999' })
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      await provider.getFreshCredential()
      const status = await provider.getStatus()
      expect(status.refreshFailureCode).toBe('rate-limited')
      expect((status.refreshRetryAt as number) - now).toBe(15 * 60 * 1000)
      expect(status.needsRepair).toBe(false)
    })
  })

  describe('explicit unpair semantics', () => {
    it('unpairs only the default id when no id is supplied and clears all only through unpairAll', async () => {
      await store.saveRecord('default', record({ accessToken: 'default-token' }))
      await store.saveRecord('team-a', record({ accessToken: 'team-token' }))
      const provider = new SubscriptionCredentialProvider(store, config, undefined, () => now)

      await provider.unpair()
      expect(await store.loadRecord('default')).toBeNull()
      expect((await store.loadRecord('team-a'))?.accessToken).toBe('team-token')

      await provider.unpairAll()
      expect(await store.listStatuses()).toEqual([])
    })
  })
})

describe('PairingStateStore durable bounds and claim leases', () => {
  let dir: string
  let filePath: string
  let store: SubscriptionTokenStore
  let now: number
  const key = crypto.randomBytes(32).toString('hex')

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pairing-state-'))
    filePath = path.join(dir, 'pairing.json')
    store = new SubscriptionTokenStore(filePath, key)
    now = START
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('expires pending state and never restores it for retry', async () => {
    const lifecycle = new PairingStateStore(store, 100, 50, () => now)
    await lifecycle.put(state(1), verifier(1), ADMIN_A, 'team-a')
    now += 101

    expect(await lifecycle.claim(state(1))).toBeNull()
    expect(await lifecycle.claim(state(1))).toBeNull()
  })

  it('expires stale claim leases so they do not wedge a target forever', async () => {
    const lifecycle = new PairingStateStore(store, 1_000, 50, () => now)
    await lifecycle.put(state(1), verifier(1), ADMIN_A, 'team-a')
    const staleClaim = await lifecycle.claim(state(1))
    expect(staleClaim).not.toBeNull()
    now += 51
    expect(await lifecycle.commit(staleClaim!.claimId, record())).toBe(false)

    await lifecycle.put(state(2), verifier(2), ADMIN_A, 'team-a')
    const nextClaim = await lifecycle.claim(state(2))
    expect(nextClaim).not.toBeNull()
    expect(await lifecycle.commit(nextClaim!.claimId, record({ accessToken: 'newer' }))).toBe(true)
    expect((await store.loadRecord('team-a'))?.accessToken).toBe('newer')
  })

  it('newer pairing and unpair operations invalidate in-flight claims', async () => {
    const lifecycle = new PairingStateStore(store, 1_000, 500, () => now)
    await lifecycle.put(state(1), verifier(1), ADMIN_A, 'team-a')
    const oldClaim = await lifecycle.claim(state(1))
    await lifecycle.put(state(2), verifier(2), ADMIN_A, 'team-a')
    expect(await lifecycle.commit(oldClaim!.claimId, record({ accessToken: 'old' }))).toBe(false)

    const newClaim = await lifecycle.claim(state(2))
    await store.removeRecord('team-a')
    expect(await lifecycle.commit(newClaim!.claimId, record({ accessToken: 'resurrected' }))).toBe(false)
    expect(await store.loadRecord('team-a')).toBeNull()
  })

  it('keeps at most one pending or claimed attempt per target', async () => {
    const lifecycle = new PairingStateStore(store, 1_000, 500, () => now)
    await lifecycle.put(state(1), verifier(1), ADMIN_A, 'team-a')
    await lifecycle.put(state(2), verifier(2), ADMIN_A, 'team-a')

    expect(await lifecycle.claim(state(1))).toBeNull()
    expect(await lifecycle.claim(state(2))).not.toBeNull()
  })

  it('bounds each administrator to sixteen concurrent targets', async () => {
    const lifecycle = new PairingStateStore(store, 1_000, 500, () => now)
    for (let index = 0; index < 16; index += 1) {
      await lifecycle.put(state(index + 1), verifier(index + 1), ADMIN_A, `target-${index}`)
    }
    await expect(lifecycle.put(state(17), verifier(17), ADMIN_A, 'target-16')).rejects.toThrow(/administrator/)
  })

  it('bounds total pending and claimed lifecycle entries', async () => {
    const lifecycle = new PairingStateStore(store, 60_000, 30_000, () => now, 3, 3)
    for (let index = 0; index < 3; index += 1) {
      await lifecycle.put(
        crypto.randomBytes(32).toString('base64url'),
        crypto.randomBytes(32).toString('base64url'),
        crypto.randomUUID(),
        `target-${index}`,
      )
    }
    await expect(
      lifecycle.put(
        crypto.randomBytes(32).toString('base64url'),
        crypto.randomBytes(32).toString('base64url'),
        crypto.randomUUID(),
        'target-overflow',
      ),
    ).rejects.toThrow(/bounded pending-pairing limit/)
  }, 10_000)

  it('encrypts state, verifier, admin, code, and token sentinels on disk', async () => {
    const lifecycle = new PairingStateStore(store, 1_000, 500, () => now)
    const stateSentinel = state(77)
    const verifierSentinel = verifier(88)
    const codeSentinel = 'AUTH_CODE_SENTINEL'
    const tokenSentinel = 'ACCESS_TOKEN_SENTINEL'
    await lifecycle.put(stateSentinel, verifierSentinel, ADMIN_A, 'team-a')
    await store.saveRecord('team-b', record({ accessToken: tokenSentinel }))

    const raw = await fs.readFile(filePath, 'utf8')
    for (const sentinel of [stateSentinel, verifierSentinel, ADMIN_A, codeSentinel, tokenSentinel]) {
      expect(raw).not.toContain(sentinel)
    }
  })
})
