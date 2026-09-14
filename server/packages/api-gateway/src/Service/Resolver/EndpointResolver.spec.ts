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
      ).toEqual('users/a%3Ab/settings/x')
    })

    // R2: a caller-supplied value used to be spliced in raw, so `../../v1/x?y=1`
    // rewrote the upstream URL's path and query once `new URL()` resolved the
    // dots. Every value is now ONE percent-encoded path segment.
    it('percent-encodes a param so it can never escape its path segment', () => {
      const resolver = createResolver(false)

      expect(
        resolver.resolveEndpointOrMethodIdentifier(
          'DELETE',
          'sockets/connections/:connectionId',
          '../../v1/anything?x=1#frag',
        ),
      ).toEqual('sockets/connections/..%2F..%2Fv1%2Fanything%3Fx%3D1%23frag')
      expect(new URL('http://localhost:3000/sockets/connections/..%2F..%2Fv1%2Fanything%3Fx%3D1%23frag').pathname).toBe(
        '/sockets/connections/..%2F..%2Fv1%2Fanything%3Fx%3D1%23frag',
      )
    })

    it('leaves uuids, emails and setting names readable after encoding', () => {
      const resolver = createResolver(false)

      expect(
        resolver.resolveEndpointOrMethodIdentifier('GET', 'admin/users/:email/ban-status', 'a.b+c@example.com'),
      ).toEqual('admin/users/a.b%2Bc%40example.com/ban-status')
      expect(decodeURIComponent('a.b%2Bc%40example.com')).toBe('a.b+c@example.com')
      expect(
        resolver.resolveEndpointOrMethodIdentifier(
          'GET',
          'users/:userUuid/settings/:settingName',
          '3f2c1e8a-1c0e-4c9a-9d2b-1f9f1b5a6c7d',
          'MUTE_SIGN_IN_EMAILS',
        ),
      ).toEqual('users/3f2c1e8a-1c0e-4c9a-9d2b-1f9f1b5a6c7d/settings/MUTE_SIGN_IN_EMAILS')
    })

    it('leaves extra placeholders untouched when fewer params are supplied', () => {
      const resolver = createResolver(false)

      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'users/:userUuid/settings/:settingName', 'abc')).toEqual(
        'users/abc/settings/:settingName',
      )
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

    it('maps the sync command status route to its dedicated handler before item lookup', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'items/sync-command/:commandId')).toEqual(
        'sync.items.sync_command_status',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'items/:uuid')).toEqual('sync.items.get_item')
    })

    it('maps legacy websocket token minting to the in-process provider', () => {
      const resolver = createResolver(true)
      expect(resolver.resolveEndpointOrMethodIdentifier('POST', 'sockets/tokens')).toBe('websockets.tokens.create')
    })

    // Standard Red Notes: admin suspend/unsuspend + hard-delete routes.
    it('maps the admin suspension status/set and delete identifiers', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'admin/users/:email/suspension-status')).toEqual(
        'admin.getUserSuspensionStatus',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('PUT', 'admin/users/:userUuid/suspension')).toEqual(
        'admin.setUserSuspension',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('DELETE', 'admin/users/:userUuid')).toEqual('admin.deleteUser')
    })

    // The bare ':userUuid' DELETE must not collide with the more specific
    // '/users/:userUuid/mfa-secret' DELETE — each maps to its own identifier.
    it('keeps the bare-uuid delete distinct from the mfa-secret delete', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('DELETE', 'admin/users/:userUuid/mfa-secret')).toEqual(
        'admin.resetUserMFA',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('DELETE', 'admin/users/:userUuid')).toEqual('admin.deleteUser')
    })

    // Standard Red Notes: INVITE-URL signup control — admin invite-link CRUD +
    // approval queue. These identifiers must match what the auth side registers on
    // its controllerContainer, or the DirectCall proxy throws "Method X not found"
    // at runtime (build stays green).
    it('maps the admin invite-link CRUD identifiers', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('POST', 'admin/invite-links')).toEqual('admin.createInviteLink')
      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'admin/invite-links')).toEqual('admin.listInviteLinks')
      expect(resolver.resolveEndpointOrMethodIdentifier('DELETE', 'admin/invite-links/:uuid')).toEqual(
        'admin.revokeInviteLink',
      )
    })

    it('maps the admin approval-queue identifiers', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'admin/pending-users')).toEqual('admin.listPendingUsers')
      expect(resolver.resolveEndpointOrMethodIdentifier('POST', 'admin/pending-users/:userUuid/approve')).toEqual(
        'admin.approveUser',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('POST', 'admin/pending-users/:userUuid/reject')).toEqual(
        'admin.rejectUser',
      )
    })

    // Standard Red Notes: SELF-SERVE invite links — AUTHENTICATED user surface (not
    // admin). The ':uuid' delete is declared after the collection route and maps to
    // its own identifier.
    it('maps the self-serve invite-link identifiers', () => {
      const resolver = createResolver(true)

      expect(resolver.resolveEndpointOrMethodIdentifier('POST', 'users/me/invite-links')).toEqual(
        'auth.meInviteLinks.create',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('GET', 'users/me/invite-links')).toEqual(
        'auth.meInviteLinks.list',
      )
      expect(resolver.resolveEndpointOrMethodIdentifier('DELETE', 'users/me/invite-links/:uuid')).toEqual(
        'auth.meInviteLinks.revoke',
      )
    })
  })
})
