import {
  isNewerVersion,
  normalizeVersion,
  parseUpdateResponse,
  parseVersionSegments,
  resolveOwnPackageVersion,
  UpdateCheckFetchLike,
  UpdateCheckService,
} from './UpdateCheckService'

describe('UpdateCheckService', () => {
  describe('normalizeVersion', () => {
    it('strips a leading v and whitespace', () => {
      expect(normalizeVersion(' v1.2.3 ')).toEqual('1.2.3')
      expect(normalizeVersion('V2.0.0')).toEqual('2.0.0')
      expect(normalizeVersion('1.2.3')).toEqual('1.2.3')
    })
  })

  describe('parseVersionSegments', () => {
    it('parses numeric dot segments', () => {
      expect(parseVersionSegments('1.2.3')).toEqual([1, 2, 3])
      expect(parseVersionSegments('v10.0')).toEqual([10, 0])
      expect(parseVersionSegments('1.2.3-beta.1')).toEqual([1, 2, 3])
      expect(parseVersionSegments('1.2.3+build.5')).toEqual([1, 2, 3])
    })

    it('returns null for non-parseable versions', () => {
      expect(parseVersionSegments('nightly-2026-07-01')).toBeNull()
      expect(parseVersionSegments('')).toBeNull()
      expect(parseVersionSegments('abc')).toBeNull()
    })
  })

  describe('isNewerVersion', () => {
    it('compares numeric segments', () => {
      expect(isNewerVersion('1.2.4', '1.2.3')).toBe(true)
      expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true)
      expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
      expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false)
      expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true)
    })

    it('treats missing segments as zero', () => {
      expect(isNewerVersion('1.2', '1.2.0')).toBe(false)
      expect(isNewerVersion('1.2.1', '1.2')).toBe(true)
    })

    it('tolerates a leading v on either side', () => {
      expect(isNewerVersion('v1.3.0', '1.2.9')).toBe(true)
      expect(isNewerVersion('1.2.9', 'v1.3.0')).toBe(false)
    })

    it('falls back to string inequality for non-parseable versions', () => {
      expect(isNewerVersion('nightly-2026-07-01', '1.2.3')).toBe(true)
      expect(isNewerVersion('nightly', 'nightly')).toBe(false)
      expect(isNewerVersion('v-weird', 'v-weird')).toBe(false)
    })
  })

  describe('parseUpdateResponse', () => {
    it('parses a github releases list, preferring stable releases', () => {
      const result = parseUpdateResponse([
        { tag_name: 'v2.0.0-rc.1', html_url: 'https://example.com/rc', prerelease: true },
        { tag_name: 'v1.9.0', html_url: 'https://example.com/stable', prerelease: false, draft: false },
      ])
      expect(result).toEqual({ version: 'v1.9.0', url: 'https://example.com/stable' })
    })

    it('falls back to the first list entry when all are prereleases', () => {
      const result = parseUpdateResponse([
        { tag_name: 'v2.0.0-rc.1', html_url: 'https://example.com/rc', prerelease: true },
      ])
      expect(result).toEqual({ version: 'v2.0.0-rc.1', url: 'https://example.com/rc' })
    })

    it('parses a github /releases/latest object', () => {
      const result = parseUpdateResponse({ tag_name: 'v3.1.4', html_url: 'https://example.com/release' })
      expect(result).toEqual({ version: 'v3.1.4', url: 'https://example.com/release' })
    })

    it('parses a plain { version, url } document', () => {
      expect(parseUpdateResponse({ version: '5.0.1', url: 'https://example.com' })).toEqual({
        version: '5.0.1',
        url: 'https://example.com',
      })
      expect(parseUpdateResponse({ version: '5.0.1' })).toEqual({ version: '5.0.1', url: undefined })
    })

    it('returns null for unrecognizable bodies', () => {
      expect(parseUpdateResponse(null)).toBeNull()
      expect(parseUpdateResponse('str')).toBeNull()
      expect(parseUpdateResponse({})).toBeNull()
      expect(parseUpdateResponse([])).toBeNull()
      expect(parseUpdateResponse(42)).toBeNull()
    })
  })

  describe('resolveOwnPackageVersion', () => {
    it('finds the api-gateway package version', () => {
      expect(resolveOwnPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  describe('getStatus', () => {
    const makeFetch = (body: unknown, ok = true) =>
      jest.fn().mockResolvedValue({
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
      }) as jest.MockedFunction<UpdateCheckFetchLike>

    it('reports not configured when no url is set', async () => {
      const fetchFn = makeFetch({})
      const service = new UpdateCheckService(fetchFn, { currentVersion: '1.0.0' })

      expect(await service.getStatus()).toEqual({ configured: false, currentVersion: '1.0.0' })
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('reports an available update from a github latest-release object', async () => {
      const service = new UpdateCheckService(makeFetch({ tag_name: 'v1.1.0', html_url: 'https://example.com/r' }), {
        url: 'https://api.github.com/repos/x/y/releases/latest',
        currentVersion: '1.0.0',
      })

      const status = await service.getStatus(false, 1_000)
      expect(status).toEqual({
        configured: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true,
        releaseUrl: 'https://example.com/r',
        checkedAt: new Date(1_000).toISOString(),
      })
    })

    it('reports up to date when versions match', async () => {
      const service = new UpdateCheckService(makeFetch({ version: 'v1.0.0' }), {
        url: 'https://example.com/version.json',
        currentVersion: '1.0.0',
      })

      const status = await service.getStatus()
      expect(status.updateAvailable).toBe(false)
      expect(status.latestVersion).toEqual('1.0.0')
    })

    it('serves cached results within the ttl and refetches after expiry', async () => {
      const fetchFn = makeFetch({ version: '1.1.0' })
      const service = new UpdateCheckService(fetchFn, {
        url: 'https://example.com/version.json',
        currentVersion: '1.0.0',
        cacheTtlMs: 1000,
      })

      await service.getStatus(false, 0)
      await service.getStatus(false, 500)
      expect(fetchFn).toHaveBeenCalledTimes(1)

      await service.getStatus(false, 1500)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('bypasses the cache when forced', async () => {
      const fetchFn = makeFetch({ version: '1.1.0' })
      const service = new UpdateCheckService(fetchFn, {
        url: 'https://example.com/version.json',
        currentVersion: '1.0.0',
      })

      await service.getStatus(false, 0)
      await service.getStatus(true, 1)
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('resolves the url lazily per call: a runtime override WINS over the static env url', async () => {
      const fetchFn = makeFetch({ version: '1.1.0' })
      const service = new UpdateCheckService(fetchFn, {
        url: 'https://env.example.com/version.json',
        urlResolver: async () => 'https://persisted.example.com/version.json',
        currentVersion: '1.0.0',
      })

      await service.getStatus()
      expect(fetchFn).toHaveBeenCalledWith('https://persisted.example.com/version.json', expect.anything())
    })

    it('reports not configured when the resolver clears the url, and invalidates the cache on a url change', async () => {
      const fetchFn = makeFetch({ version: '1.1.0' })
      let resolved: string | undefined = 'https://a.example.com/version.json'
      const service = new UpdateCheckService(fetchFn, {
        urlResolver: async () => resolved,
        currentVersion: '1.0.0',
        cacheTtlMs: 60_000,
      })

      await service.getStatus(false, 0)
      expect(fetchFn).toHaveBeenCalledTimes(1)

      // Same url within ttl => cached.
      await service.getStatus(false, 1)
      expect(fetchFn).toHaveBeenCalledTimes(1)

      // Changed url within ttl => the cache is keyed to the url and refetches.
      resolved = 'https://b.example.com/version.json'
      await service.getStatus(false, 2)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(fetchFn).toHaveBeenLastCalledWith('https://b.example.com/version.json', expect.anything())

      // Cleared url => not configured, no fetch.
      resolved = undefined
      expect(await service.getStatus(false, 3)).toEqual({ configured: false, currentVersion: '1.0.0' })
      expect(fetchFn).toHaveBeenCalledTimes(2)
    })

    it('falls back to the static url when the resolver throws', async () => {
      const fetchFn = makeFetch({ version: '1.1.0' })
      const service = new UpdateCheckService(fetchFn, {
        url: 'https://env.example.com/version.json',
        urlResolver: async () => {
          throw new Error('settings store unreadable')
        },
        currentVersion: '1.0.0',
      })

      await service.getStatus()
      expect(fetchFn).toHaveBeenCalledWith('https://env.example.com/version.json', expect.anything())
    })

    it('degrades to an unreachable error on network failure without throwing', async () => {
      const fetchFn = jest.fn().mockRejectedValue(new Error('boom')) as jest.MockedFunction<UpdateCheckFetchLike>
      const service = new UpdateCheckService(fetchFn, {
        url: 'https://example.com/version.json',
        currentVersion: '1.0.0',
      })

      const status = await service.getStatus(true, 42)
      expect(status).toEqual({
        configured: true,
        currentVersion: '1.0.0',
        checkedAt: new Date(42).toISOString(),
        error: 'unreachable',
      })
    })

    it('degrades to an unreachable error on non-2xx responses', async () => {
      const service = new UpdateCheckService(makeFetch({}, false), {
        url: 'https://example.com/version.json',
        currentVersion: '1.0.0',
      })

      expect((await service.getStatus()).error).toEqual('unreachable')
    })

    it('degrades to an invalid-response error on unrecognizable bodies', async () => {
      const service = new UpdateCheckService(makeFetch({ nonsense: true }), {
        url: 'https://example.com/version.json',
        currentVersion: '1.0.0',
      })

      expect((await service.getStatus()).error).toEqual('invalid-response')
    })
  })
})
