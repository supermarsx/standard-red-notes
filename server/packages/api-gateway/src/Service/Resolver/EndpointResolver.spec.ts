import 'reflect-metadata'

import { EndpointResolver } from './EndpointResolver'

describe('EndpointResolver', () => {
  const createResolver = (isConfiguredForHomeServer: boolean) => new EndpointResolver(isConfiguredForHomeServer)

  describe('microservice (non-home-server) placeholder substitution', () => {
    it('substitutes a single :param identically to before', () => {
      const resolver = createResolver(false)

      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'items/:uuid', '123')).toEqual('items/123')
    })

    it('substitutes multiple :params positionally', () => {
      const resolver = createResolver(false)

      expect(
        resolver.resolveEndpointOrMethodIdentifier('GET', 'users/:userUuid/settings/:settingName', 'abc', 'THEME'),
      ).toEqual('users/abc/settings/THEME')
    })

    it('does NOT mis-substitute when an earlier param value itself contains a ":word" token', () => {
      const resolver = createResolver(false)

      // The leftmost-replace reduce used to re-scan the inserted value, matching the
      // ":b" inside "a:b" as the next placeholder and clobbering it. The positional
      // single-pass replace must insert the second param at the REAL second placeholder.
      expect(
        resolver.resolveEndpointOrMethodIdentifier('GET', 'users/:userUuid/settings/:settingName', 'a:b', 'x'),
      ).toEqual('users/a:b/settings/x')
    })

    it('leaves extra placeholders untouched when fewer params are supplied', () => {
      const resolver = createResolver(false)

      expect(
        resolver.resolveEndpointOrMethodIdentifier('GET', 'users/:userUuid/settings/:settingName', 'abc'),
      ).toEqual('users/abc/settings/:settingName')
    })

    it('returns the endpoint unchanged when no params are supplied', () => {
      const resolver = createResolver(false)

      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'sessions')).toEqual('sessions')
    })
  })

  describe('home-server identifier mapping', () => {
    it('maps a known endpoint to its identifier', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('POST', 'items/sync')).toEqual('sync.items.sync')
    })
  })
})
