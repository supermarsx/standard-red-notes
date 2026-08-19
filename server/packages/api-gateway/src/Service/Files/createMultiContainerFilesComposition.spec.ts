import type { AxiosInstance } from 'axios'

import type { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'
import type { EndpointResolverInterface } from '../Resolver/EndpointResolverInterface'
import {
  createMultiContainerFilesComposition,
  resolveInternalFilesServerUrl,
  type MultiContainerFilesEnvironment,
} from './createMultiContainerFilesComposition'
import { MultiContainerSyncFilesAdapter } from './MultiContainerSyncFilesAdapter'

const DEPENDENCIES = {
  serviceProxy: {} as unknown as ServiceProxyInterface,
  endpointResolver: {
    resolveEndpointOrMethodIdentifier: (_method: string, endpoint: string) => endpoint,
  } as EndpointResolverInterface,
  httpClient: { request: async () => ({ status: 200, data: {}, headers: {} }) } as unknown as Pick<
    AxiosInstance,
    'request'
  >,
}

const COMPLETE: MultiContainerFilesEnvironment = {
  filesServerProbeUrl: 'http://files:3000',
  authJwtSecret: 'auth-secret',
  valetTokenSecret: 'valet-secret',
}

describe('createMultiContainerFilesComposition', () => {
  describe('when the deployment is configured', () => {
    it('advertises FILES_V1 with a real adapter', () => {
      const composition = createMultiContainerFilesComposition(COMPLETE, DEPENDENCIES)

      expect(composition.advertised).toBe(true)
      if (!composition.advertised) {
        throw new Error('expected the lane to be advertised')
      }
      expect(composition.option).toEqual({ files: expect.any(MultiContainerSyncFilesAdapter) })
      expect(composition.option.files.ready()).toBe(true)
      expect(composition.filesServerUrl).toBe('http://files:3000')
      expect(composition.source).toBe('FILES_SERVER_PROBE_URL')
    })

    it('produces an option that carries no waiver', () => {
      const composition = createMultiContainerFilesComposition(COMPLETE, DEPENDENCIES)
      expect(composition.option).not.toHaveProperty('filesUnsupported')
    })
  })

  describe('when configuration is missing', () => {
    it.each([
      [
        'no internal files URL is resolvable',
        { ...COMPLETE, filesServerProbeUrl: undefined },
        /INTERNAL files service URL/u,
      ],
      ['the valet token secret is absent', { ...COMPLETE, valetTokenSecret: undefined }, /VALET_TOKEN_SECRET/u],
      ['the valet token secret is empty', { ...COMPLETE, valetTokenSecret: '' }, /VALET_TOKEN_SECRET/u],
      ['the auth jwt secret is absent', { ...COMPLETE, authJwtSecret: undefined }, /AUTH_JWT_SECRET/u],
      ['the auth jwt secret is empty', { ...COMPLETE, authJwtSecret: '' }, /AUTH_JWT_SECRET/u],
      [
        'the configured URL is not a URL',
        { ...COMPLETE, filesServerProbeUrl: 'not a url' },
        /INTERNAL files service URL/u,
      ],
      [
        'the configured URL is not http',
        { ...COMPLETE, filesServerProbeUrl: 'file:///etc/passwd' },
        /INTERNAL files service URL/u,
      ],
    ])('declares the waiver when %s', (_label, environment, reasonPattern) => {
      const composition = createMultiContainerFilesComposition(environment, DEPENDENCIES)

      expect(composition.advertised).toBe(false)
      expect(composition.option).toEqual({ filesUnsupported: true })
      if (composition.advertised) {
        throw new Error('expected the lane to be waived')
      }
      expect(composition.reason).toMatch(reasonPattern)
    })

    it('never yields an option carrying both an adapter and a waiver', () => {
      for (const environment of [COMPLETE, {}, { ...COMPLETE, valetTokenSecret: undefined }]) {
        const option = createMultiContainerFilesComposition(environment, DEPENDENCIES).option as Record<string, unknown>
        expect('files' in option && 'filesUnsupported' in option).toBe(false)
        expect('files' in option || 'filesUnsupported' in option).toBe(true)
      }
    })
  })

  describe('internal files URL resolution', () => {
    it('prefers the explicit override above everything else', () => {
      expect(
        resolveInternalFilesServerUrl({
          websocketSyncFilesUrl: 'http://explicit:9000',
          filesServerProbeUrl: 'http://probe:3000',
          filesServerUrl: 'http://configured:3000',
        }),
      ).toEqual({ url: 'http://explicit:9000', source: 'WEBSOCKET_SYNC_FILES_URL' })
    })

    it('falls back to the probe URL before the proxy URL', () => {
      expect(
        resolveInternalFilesServerUrl({
          filesServerProbeUrl: 'http://probe:3000',
          filesServerUrl: 'http://configured:3000',
        }),
      ).toEqual({ url: 'http://probe:3000', source: 'FILES_SERVER_PROBE_URL' })
    })

    it('accepts FILES_SERVER_URL in true multi-container, where it is the internal address', () => {
      // api-gateway/.env.sample ships exactly this pairing.
      expect(
        resolveInternalFilesServerUrl({
          filesServerUrl: 'http://files:3000',
          publicFilesServerUrl: 'https://notes.example.com/files',
        }),
      ).toEqual({ url: 'http://files:3000', source: 'FILES_SERVER_URL' })
    })

    it('refuses FILES_SERVER_URL in the bundled image, where it is aliased to the public URL', () => {
      // server/docker/docker-entrypoint.sh: FILES_SERVER_URL=$PUBLIC_FILES_SERVER_URL.
      // That address is the app front door and is unreachable from inside the
      // container, so serving FILES_V1 from it would fail every transfer.
      expect(
        resolveInternalFilesServerUrl({
          filesServerUrl: 'https://notes.example.com/files',
          publicFilesServerUrl: 'https://notes.example.com/files',
        }),
      ).toBeUndefined()
    })

    it('refuses FILES_SERVER_URL when it differs from the public URL only by a trailing slash', () => {
      expect(
        resolveInternalFilesServerUrl({
          filesServerUrl: 'https://notes.example.com/files/',
          publicFilesServerUrl: 'https://notes.example.com/files',
        }),
      ).toBeUndefined()
    })

    it('accepts FILES_SERVER_URL when no public URL is declared at all', () => {
      expect(resolveInternalFilesServerUrl({ filesServerUrl: 'http://files:3000' })).toEqual({
        url: 'http://files:3000',
        source: 'FILES_SERVER_URL',
      })
    })

    it('strips trailing slashes so the storage boundary builds clean paths', () => {
      expect(resolveInternalFilesServerUrl({ websocketSyncFilesUrl: 'http://files:3000///' })?.url).toBe(
        'http://files:3000',
      )
    })

    it.each([
      ['nothing configured', {}],
      ['only blank values', { websocketSyncFilesUrl: '   ', filesServerProbeUrl: '', filesServerUrl: '  ' }],
      ['a non-absolute URL', { websocketSyncFilesUrl: '/files' }],
      ['a non-http scheme', { websocketSyncFilesUrl: 'ftp://files:3000' }],
    ])('resolves nothing for %s', (_label, environment) => {
      expect(resolveInternalFilesServerUrl(environment)).toBeUndefined()
    })
  })
})
