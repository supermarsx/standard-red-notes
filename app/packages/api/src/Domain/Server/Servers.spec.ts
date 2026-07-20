import { Uuid } from '@standardnotes/domain-core'
import { HttpServiceInterface } from '../Http/HttpServiceInterface'
import { AsymmetricMessageServer } from './AsymmetricMessage/AsymmetricMessageServer'
import { AuthServer } from './Auth/AuthServer'
import { AuthenticatorServer } from './Authenticator/AuthenticatorServer'
import { RevisionServer } from './Revision/RevisionServer'
import { SharedVaultInvitesServer } from './SharedVaultInvites/SharedVaultInvitesServer'
import { SharedVaultServer } from './SharedVault/SharedVaultServer'
import { SharedVaultUsersServer } from './SharedVaultUsers/SharedVaultUsersServer'
import { SubscriptionServer } from './Subscription/SubscriptionServer'
import { UserRequestServer } from './UserRequest/UserRequestServer'
import { UserServer } from './User/UserServer'
import { WebSocketServer } from './WebSocket/WebSocketServer'

/**
 * The Server classes are the wire contract between the client and the sync/auth servers:
 * each method is a verb + path + body. These tests pin all three.
 */
describe('Servers', () => {
  let http: jest.Mocked<HttpServiceInterface>
  const response = { status: 200, data: {} }

  beforeEach(() => {
    http = {
      get: jest.fn().mockResolvedValue(response),
      post: jest.fn().mockResolvedValue(response),
      put: jest.fn().mockResolvedValue(response),
      patch: jest.fn().mockResolvedValue(response),
      delete: jest.fn().mockResolvedValue(response),
    } as unknown as jest.Mocked<HttpServiceInterface>
  })

  describe('AuthServer', () => {
    it('generateRecoveryCodes should POST to the recovery codes path, forwarding options', async () => {
      const options = { headers: [{ key: 'x-server-password', value: 'secret' }] }

      await expect(new AuthServer(http).generateRecoveryCodes(options)).resolves.toBe(response)
      expect(http.post).toHaveBeenCalledWith('/v1/recovery/codes', undefined, options)
    })

    it('recoveryKeyParams should POST the params to the login-params path', async () => {
      const params = { api_version: '20200115', code_challenge: 'c', recovery_codes: 'r', username: 'u' } as never

      await new AuthServer(http).recoveryKeyParams(params)

      expect(http.post).toHaveBeenCalledWith('/v1/recovery/login-params', params)
    })

    it('signInWithRecoveryCodes should POST the params to the recovery login path', async () => {
      const params = { api_version: '20200115', username: 'u' } as never

      await new AuthServer(http).signInWithRecoveryCodes(params)

      expect(http.post).toHaveBeenCalledWith('/v1/recovery/login', params)
    })
  })

  describe('UserServer', () => {
    it('deleteAccount should DELETE the user path with the params and options', async () => {
      const options = { headers: [{ key: 'x-server-password', value: 'secret' }] }
      const params = { userUuid: 'user-1' }

      await new UserServer(http).deleteAccount(params, options)

      expect(http.delete).toHaveBeenCalledWith('/v1/users/user-1', params, options)
    })

    it('register should POST to the users collection', async () => {
      const params = { email: 'a@b.c' } as never

      await new UserServer(http).register(params)

      expect(http.post).toHaveBeenCalledWith('/v1/users', params)
    })

    it('update should PATCH the user path', async () => {
      const params = { user_uuid: 'user-1' } as never

      await new UserServer(http).update(params)

      expect(http.patch).toHaveBeenCalledWith('/v1/users/user-1', params)
    })
  })

  describe('UserRequestServer', () => {
    it('submitUserRequest should POST to the user requests path', async () => {
      const params = { userUuid: 'user-1', requestType: 'exit-discount' } as never

      await new UserRequestServer(http).submitUserRequest(params)

      expect(http.post).toHaveBeenCalledWith('/v1/users/user-1/requests', params)
    })
  })

  describe('WebSocketServer', () => {
    it('createConnectionToken should POST to the socket tokens path', async () => {
      await new WebSocketServer(http).createConnectionToken({})

      expect(http.post).toHaveBeenCalledWith('/v1/sockets/tokens', {})
    })

    it('authorizeCollaboration should POST the note uuid to the collaboration path', async () => {
      await new WebSocketServer(http).authorizeCollaboration({ noteUuid: 'note-1' })

      expect(http.post).toHaveBeenCalledWith('/v1/collaboration/authorize', { noteUuid: 'note-1' })
    })
  })

  describe('RevisionServer', () => {
    it('listRevisions should GET the v2 revisions collection', async () => {
      await new RevisionServer(http).listRevisions({ itemUuid: 'item-1' })

      expect(http.get).toHaveBeenCalledWith('/v2/items/item-1/revisions')
    })

    it('getRevision should GET a single v2 revision', async () => {
      await new RevisionServer(http).getRevision({ itemUuid: 'item-1', revisionUuid: 'rev-1' })

      expect(http.get).toHaveBeenCalledWith('/v2/items/item-1/revisions/rev-1')
    })

    it('deleteRevision should DELETE a single v2 revision', async () => {
      await new RevisionServer(http).deleteRevision({ itemUuid: 'item-1', revisionUuid: 'rev-1' })

      expect(http.delete).toHaveBeenCalledWith('/v2/items/item-1/revisions/rev-1')
    })
  })

  describe('AuthenticatorServer', () => {
    it('list should GET the authenticators collection with the params', async () => {
      await new AuthenticatorServer(http).list({} as never)

      expect(http.get).toHaveBeenCalledWith('/v1/authenticators', {})
    })

    it('delete should DELETE a single authenticator', async () => {
      const params = { authenticatorId: 'auth-1' } as never

      await new AuthenticatorServer(http).delete(params)

      expect(http.delete).toHaveBeenCalledWith('/v1/authenticators/auth-1', params)
    })

    it('generateRegistrationOptions should GET the registration options path', async () => {
      await new AuthenticatorServer(http).generateRegistrationOptions()

      expect(http.get).toHaveBeenCalledWith('/v1/authenticators/generate-registration-options')
    })

    it('verifyRegistrationResponse should POST to the verify path', async () => {
      const params = { userUuid: 'user-1', name: 'key', attestationResponse: {} } as never

      await new AuthenticatorServer(http).verifyRegistrationResponse(params)

      expect(http.post).toHaveBeenCalledWith('/v1/authenticators/verify-registration', params)
    })

    it('generateAuthenticationOptions should POST to the authentication options path', async () => {
      const params = { username: 'u' } as never

      await new AuthenticatorServer(http).generateAuthenticationOptions(params)

      expect(http.post).toHaveBeenCalledWith('/v1/authenticators/generate-authentication-options', params)
    })
  })

  describe('SubscriptionServer', () => {
    it('acceptInvite should POST to the invite accept path', async () => {
      const params = { inviteUuid: 'invite-1' } as never

      await new SubscriptionServer(http).acceptInvite(params)

      expect(http.post).toHaveBeenCalledWith('/v1/subscription-invites/invite-1/accept', params)
    })

    it('declineInvite should GET the invite decline path', async () => {
      const params = { inviteUuid: 'invite-1' } as never

      await new SubscriptionServer(http).declineInvite(params)

      expect(http.get).toHaveBeenCalledWith('/v1/subscription-invites/invite-1/decline', params)
    })

    it('cancelInvite should DELETE the invite', async () => {
      const params = { inviteUuid: 'invite-1' } as never

      await new SubscriptionServer(http).cancelInvite(params)

      expect(http.delete).toHaveBeenCalledWith('/v1/subscription-invites/invite-1', params)
    })

    it('listInvites should GET the invites collection', async () => {
      const params = {} as never

      await new SubscriptionServer(http).listInvites(params)

      expect(http.get).toHaveBeenCalledWith('/v1/subscription-invites', params)
    })

    it('invite should POST to the invites collection', async () => {
      const params = { identifier: 'a@b.c' } as never

      await new SubscriptionServer(http).invite(params)

      expect(http.post).toHaveBeenCalledWith('/v1/subscription-invites', params)
    })

    it('confirmAppleIAP should POST to the apple confirm path', async () => {
      const params = { receipt: 'r' } as never

      await new SubscriptionServer(http).confirmAppleIAP(params)

      expect(http.post).toHaveBeenCalledWith('/v1/subscriptions/apple_iap_confirm', params)
    })

    it('getUserSubscription should GET the user subscription path', async () => {
      const params = { userUuid: 'user-1' } as never

      await new SubscriptionServer(http).getUserSubscription(params)

      expect(http.get).toHaveBeenCalledWith('/v1/users/user-1/subscription', params)
    })

    it('getAvailableSubscriptions should GET the unauthenticated v2 subscriptions path', async () => {
      await new SubscriptionServer(http).getAvailableSubscriptions()

      expect(http.get).toHaveBeenCalledWith('/v2/subscriptions')
    })
  })

  describe('AsymmetricMessageServer', () => {
    it('createMessage should POST the snake_case body to the messages collection', async () => {
      await new AsymmetricMessageServer(http).createMessage({
        recipientUuid: 'recipient-1',
        encryptedMessage: 'cipher',
        replaceabilityIdentifier: 'replace-1',
      } as never)

      expect(http.post).toHaveBeenCalledWith('/v1/messages', {
        recipient_uuid: 'recipient-1',
        encrypted_message: 'cipher',
        replaceability_identifier: 'replace-1',
      })
    })

    it('getInboundUserMessages and getMessages should both GET the messages collection', async () => {
      const server = new AsymmetricMessageServer(http)

      await server.getInboundUserMessages()
      await server.getMessages()

      expect(http.get.mock.calls).toEqual([['/v1/messages'], ['/v1/messages']])
    })

    it('getOutboundUserMessages should GET the outbound path', async () => {
      await new AsymmetricMessageServer(http).getOutboundUserMessages()

      expect(http.get).toHaveBeenCalledWith('/v1/messages/outbound')
    })

    it('deleteMessage should DELETE a single message', async () => {
      await new AsymmetricMessageServer(http).deleteMessage({ messageUuid: 'message-1' } as never)

      expect(http.delete).toHaveBeenCalledWith('/v1/messages/message-1')
    })

    it('deleteAllInboundMessages should DELETE the inbound path', async () => {
      await new AsymmetricMessageServer(http).deleteAllInboundMessages()

      expect(http.delete).toHaveBeenCalledWith('/v1/messages/inbound')
    })
  })

  describe('SharedVaultServer', () => {
    it('getSharedVaults should GET the shared vaults collection', async () => {
      await new SharedVaultServer(http).getSharedVaults()

      expect(http.get).toHaveBeenCalledWith('/v1/shared-vaults')
    })

    it('createSharedVault should POST to the shared vaults collection', async () => {
      await new SharedVaultServer(http).createSharedVault()

      expect(http.post).toHaveBeenCalledWith('/v1/shared-vaults')
    })

    it('deleteSharedVault should DELETE a single shared vault', async () => {
      await new SharedVaultServer(http).deleteSharedVault({ sharedVaultUuid: 'vault-1' })

      expect(http.delete).toHaveBeenCalledWith('/v1/shared-vaults/vault-1')
    })

    it('createSharedVaultFileValetToken should POST the snake_case body with no owner header', async () => {
      await new SharedVaultServer(http).createSharedVaultFileValetToken({
        sharedVaultUuid: 'vault-1',
        fileUuid: 'file-1',
        remoteIdentifier: 'remote-1',
        operation: 'read',
        unencryptedFileSize: 10,
        moveOperationType: undefined,
        sharedVaultToSharedVaultMoveTargetUuid: undefined,
      } as never)

      expect(http.post).toHaveBeenCalledWith(
        '/v1/shared-vaults/vault-1/valet-tokens',
        {
          file_uuid: 'file-1',
          remote_identifier: 'remote-1',
          operation: 'read',
          unencrypted_file_size: 10,
          move_operation_type: undefined,
          shared_vault_to_shared_vault_move_target_uuid: undefined,
        },
        { headers: undefined },
      )
    })

    it('createSharedVaultFileValetToken should add the owner context header when an owner is supplied', async () => {
      await new SharedVaultServer(http).createSharedVaultFileValetToken({
        sharedVaultUuid: 'vault-1',
        sharedVaultOwnerUuid: 'owner-1',
        fileUuid: 'file-1',
        remoteIdentifier: 'remote-1',
        operation: 'write',
      } as never)

      expect(http.post.mock.calls[0][2]).toEqual({
        headers: [{ key: 'x-shared-vault-owner-context', value: 'owner-1' }],
      })
    })
  })

  describe('SharedVaultUsersServer', () => {
    it('designateSurvivor should POST to the designate-survivor path using the uuid values', async () => {
      await new SharedVaultUsersServer(http).designateSurvivor({
        sharedVaultUuid: { value: 'vault-1' } as Uuid,
        sharedVaultMemberUuid: { value: 'member-1' } as Uuid,
      })

      expect(http.post).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/users/member-1/designate-survivor')
    })

    it('getSharedVaultUsers should GET the vault users collection', async () => {
      await new SharedVaultUsersServer(http).getSharedVaultUsers({ sharedVaultUuid: 'vault-1' } as never)

      expect(http.get).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/users')
    })

    it('deleteSharedVaultUser should DELETE a single vault user', async () => {
      await new SharedVaultUsersServer(http).deleteSharedVaultUser({
        sharedVaultUuid: 'vault-1',
        userUuid: 'user-1',
      } as never)

      expect(http.delete).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/users/user-1')
    })
  })

  describe('SharedVaultInvitesServer', () => {
    it('createInvite should POST the snake_case body with the permission value', async () => {
      await new SharedVaultInvitesServer(http).createInvite({
        sharedVaultUuid: 'vault-1',
        recipientUuid: 'recipient-1',
        encryptedMessage: 'cipher',
        permission: { value: 'write' },
      } as never)

      expect(http.post).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/invites', {
        recipient_uuid: 'recipient-1',
        encrypted_message: 'cipher',
        permission: 'write',
      })
    })

    it('updateInvite should PATCH the invite with the permission value', async () => {
      await new SharedVaultInvitesServer(http).updateInvite({
        sharedVaultUuid: 'vault-1',
        inviteUuid: 'invite-1',
        encryptedMessage: 'cipher',
        permission: { value: 'read' },
      } as never)

      expect(http.patch).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/invites/invite-1', {
        encrypted_message: 'cipher',
        permission: 'read',
      })
    })

    it('updateInvite should send an undefined permission when none is supplied', async () => {
      await new SharedVaultInvitesServer(http).updateInvite({
        sharedVaultUuid: 'vault-1',
        inviteUuid: 'invite-1',
        encryptedMessage: 'cipher',
      } as never)

      expect(http.patch.mock.calls[0][1]).toEqual({ encrypted_message: 'cipher', permission: undefined })
    })

    it('acceptInvite and declineInvite should POST to their respective paths', async () => {
      const server = new SharedVaultInvitesServer(http)
      const params = { sharedVaultUuid: 'vault-1', inviteUuid: 'invite-1' } as never

      await server.acceptInvite(params)
      await server.declineInvite(params)

      expect(http.post.mock.calls).toEqual([
        ['/v1/shared-vaults/vault-1/invites/invite-1/accept'],
        ['/v1/shared-vaults/vault-1/invites/invite-1/decline'],
      ])
    })

    it('getInboundUserInvites and getOutboundUserInvites should GET their paths', async () => {
      const server = new SharedVaultInvitesServer(http)

      await server.getInboundUserInvites()
      await server.getOutboundUserInvites()

      expect(http.get.mock.calls).toEqual([['/v1/shared-vaults/invites'], ['/v1/shared-vaults/invites/outbound']])
    })

    it('getSharedVaultInvites should GET the vault invites collection', async () => {
      await new SharedVaultInvitesServer(http).getSharedVaultInvites({ sharedVaultUuid: 'vault-1' } as never)

      expect(http.get).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/invites')
    })

    it('deleteInvite should DELETE a single invite', async () => {
      await new SharedVaultInvitesServer(http).deleteInvite({
        sharedVaultUuid: 'vault-1',
        inviteUuid: 'invite-1',
      } as never)

      expect(http.delete).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/invites/invite-1')
    })

    it('deleteAllSharedVaultInvites should DELETE the vault invites collection', async () => {
      await new SharedVaultInvitesServer(http).deleteAllSharedVaultInvites({ sharedVaultUuid: 'vault-1' } as never)

      expect(http.delete).toHaveBeenCalledWith('/v1/shared-vaults/vault-1/invites')
    })

    it('deleteAllInboundInvites and deleteAllOutboundInvites should DELETE their paths', async () => {
      const server = new SharedVaultInvitesServer(http)

      await server.deleteAllInboundInvites()
      await server.deleteAllOutboundInvites()

      expect(http.delete.mock.calls).toEqual([
        ['/v1/shared-vaults/invites/inbound'],
        ['/v1/shared-vaults/invites/outbound'],
      ])
    })
  })
})
