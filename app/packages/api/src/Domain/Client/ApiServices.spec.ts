import { ApiEndpointParam } from '@standardnotes/responses'
import { ApiVersion } from '../Api/ApiVersion'
import { ApiCallError } from '../Error/ApiCallError'
import { ErrorMessage } from '../Error/ErrorMessage'
import { AuthApiService } from './Auth/AuthApiService'
import { AuthenticatorApiService } from './Authenticator/AuthenticatorApiService'
import { RevisionApiService } from './Revision/RevisionApiService'
import { SubscriptionApiService } from './Subscription/SubscriptionApiService'
import { UserApiService } from './User/UserApiService'
import { WebSocketApiService } from './WebSocket/WebSocketApiService'

const response = { status: 200, data: {} }
const ok = () => jest.fn().mockResolvedValue(response)
const boom = () => jest.fn().mockRejectedValue(new Error('network down'))
/** A call that never settles, so the in-progress lock stays held for the second call. */
const pending = () => jest.fn().mockReturnValue(new Promise(() => undefined))

describe('AuthApiService', () => {
  it('accountRecoveryLookup should forward only the UUID locator', async () => {
    const server = { accountRecoveryLookup: ok() }

    await expect(
      new AuthApiService(server as never, ApiVersion.v0).accountRecoveryLookup({
        userUuid: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).resolves.toBe(response)
    expect(server.accountRecoveryLookup).toHaveBeenCalledWith({
      user_uuid: '123e4567-e89b-42d3-a456-426614174000',
    })
  })

  it('accountRecoveryLookup should reject a concurrent call and translate transport failures', async () => {
    const locked = new AuthApiService({ accountRecoveryLookup: pending() } as never, ApiVersion.v0)
    void locked.accountRecoveryLookup({ userUuid: '123e4567-e89b-42d3-a456-426614174000' })
    await expect(locked.accountRecoveryLookup({ userUuid: '123e4567-e89b-42d3-a456-426614174000' })).rejects.toThrow(
      ErrorMessage.GenericInProgress,
    )

    const failing = new AuthApiService({ accountRecoveryLookup: boom() } as never, ApiVersion.v0)
    await expect(failing.accountRecoveryLookup({ userUuid: '123e4567-e89b-42d3-a456-426614174000' })).rejects.toThrow(
      ErrorMessage.GenericFail,
    )
  })

  it('generateRecoveryCodes should send the server password as a header', async () => {
    const server = { generateRecoveryCodes: ok() }

    await expect(
      new AuthApiService(server as never, ApiVersion.v0).generateRecoveryCodes({ serverPassword: 'secret' }),
    ).resolves.toBe(response)
    expect(server.generateRecoveryCodes).toHaveBeenCalledWith({
      headers: [{ key: 'x-server-password', value: 'secret' }],
    })
  })

  it('generateRecoveryCodes should reject a concurrent call and release the lock afterwards', async () => {
    const service = new AuthApiService({ generateRecoveryCodes: pending() } as never, ApiVersion.v0)

    void service.generateRecoveryCodes({ serverPassword: 'secret' })

    await expect(service.generateRecoveryCodes({ serverPassword: 'secret' })).rejects.toThrow(
      ErrorMessage.GenericInProgress,
    )
  })

  it('generateRecoveryCodes should translate a transport failure into an ApiCallError', async () => {
    const service = new AuthApiService({ generateRecoveryCodes: boom() } as never, ApiVersion.v0)

    await expect(service.generateRecoveryCodes({ serverPassword: 'secret' })).rejects.toThrow(ApiCallError)
  })

  it('generateRecoveryCodes should release the lock after a failure', async () => {
    const generateRecoveryCodes = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response)
    const service = new AuthApiService({ generateRecoveryCodes } as never, ApiVersion.v0)

    await expect(service.generateRecoveryCodes({ serverPassword: 'secret' })).rejects.toThrow(ApiCallError)
    await expect(service.generateRecoveryCodes({ serverPassword: 'secret' })).resolves.toBe(response)
  })

  it('recoveryKeyParams should map the dto onto the snake_case request', async () => {
    const server = { recoveryKeyParams: ok() }

    await new AuthApiService(server as never, ApiVersion.v1).recoveryKeyParams({
      username: 'u',
      codeChallenge: 'challenge',
      recoveryCodes: 'codes',
    })

    expect(server.recoveryKeyParams).toHaveBeenCalledWith({
      api_version: ApiVersion.v1,
      code_challenge: 'challenge',
      recovery_codes: 'codes',
      username: 'u',
    })
  })

  it('recoveryKeyParams should guard against concurrent calls and transport failures', async () => {
    const locked = new AuthApiService({ recoveryKeyParams: pending() } as never, ApiVersion.v0)
    void locked.recoveryKeyParams({ username: 'u', codeChallenge: 'c', recoveryCodes: 'r' })
    await expect(locked.recoveryKeyParams({ username: 'u', codeChallenge: 'c', recoveryCodes: 'r' })).rejects.toThrow(
      ErrorMessage.GenericInProgress,
    )

    const failing = new AuthApiService({ recoveryKeyParams: boom() } as never, ApiVersion.v0)
    await expect(failing.recoveryKeyParams({ username: 'u', codeChallenge: 'c', recoveryCodes: 'r' })).rejects.toThrow(
      ErrorMessage.GenericFail,
    )
  })

  it('signInWithRecoveryCodes should map the dto including the optional hvm token', async () => {
    const server = { signInWithRecoveryCodes: ok() }

    await new AuthApiService(server as never, ApiVersion.v0).signInWithRecoveryCodes({
      username: 'u',
      password: 'p',
      codeVerifier: 'v',
      recoveryCodes: 'codes',
      hvmToken: 'hvm',
    })

    expect(server.signInWithRecoveryCodes).toHaveBeenCalledWith({
      api_version: ApiVersion.v0,
      code_verifier: 'v',
      password: 'p',
      recovery_codes: 'codes',
      username: 'u',
      hvm_token: 'hvm',
    })
  })

  it('signInWithRecoveryCodes should guard against concurrent calls and transport failures', async () => {
    const dto = { username: 'u', password: 'p', codeVerifier: 'v', recoveryCodes: 'c' }

    const locked = new AuthApiService({ signInWithRecoveryCodes: pending() } as never, ApiVersion.v0)
    void locked.signInWithRecoveryCodes(dto)
    await expect(locked.signInWithRecoveryCodes(dto)).rejects.toThrow(ErrorMessage.GenericInProgress)

    const failing = new AuthApiService({ signInWithRecoveryCodes: boom() } as never, ApiVersion.v0)
    await expect(failing.signInWithRecoveryCodes(dto)).rejects.toThrow(ErrorMessage.GenericFail)
  })
})

describe('RevisionApiService', () => {
  it('listRevisions should pass the item uuid through', async () => {
    const server = { listRevisions: ok() }

    await expect(new RevisionApiService(server as never).listRevisions('item-1')).resolves.toBe(response)
    expect(server.listRevisions).toHaveBeenCalledWith({ itemUuid: 'item-1' })
  })

  it('getRevision and deleteRevision should pass both uuids through', async () => {
    const server = { getRevision: ok(), deleteRevision: ok() }
    const service = new RevisionApiService(server as never)

    await service.getRevision('item-1', 'rev-1')
    await service.deleteRevision('item-1', 'rev-1')

    expect(server.getRevision).toHaveBeenCalledWith({ itemUuid: 'item-1', revisionUuid: 'rev-1' })
    expect(server.deleteRevision).toHaveBeenCalledWith({ itemUuid: 'item-1', revisionUuid: 'rev-1' })
  })

  it('should reject concurrent calls per operation', async () => {
    const list = new RevisionApiService({ listRevisions: pending() } as never)
    void list.listRevisions('item-1')
    await expect(list.listRevisions('item-1')).rejects.toThrow(ErrorMessage.GenericInProgress)

    const get = new RevisionApiService({ getRevision: pending() } as never)
    void get.getRevision('item-1', 'rev-1')
    await expect(get.getRevision('item-1', 'rev-1')).rejects.toThrow(ErrorMessage.GenericInProgress)

    const remove = new RevisionApiService({ deleteRevision: pending() } as never)
    void remove.deleteRevision('item-1', 'rev-1')
    await expect(remove.deleteRevision('item-1', 'rev-1')).rejects.toThrow(ErrorMessage.GenericInProgress)
  })

  it('should translate transport failures into ApiCallError', async () => {
    const server = { listRevisions: boom(), getRevision: boom(), deleteRevision: boom() }
    const service = new RevisionApiService(server as never)

    await expect(service.listRevisions('item-1')).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.getRevision('item-1', 'rev-1')).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.deleteRevision('item-1', 'rev-1')).rejects.toThrow(ErrorMessage.GenericFail)
  })
})

describe('WebSocketApiService', () => {
  it('createConnectionToken should call the server with an empty params object', async () => {
    const server = { createConnectionToken: ok() }

    await expect(new WebSocketApiService(server as never).createConnectionToken()).resolves.toBe(response)
    expect(server.createConnectionToken).toHaveBeenCalledWith({})
  })

  it('createConnectionToken should release its lock between successful calls', async () => {
    const server = { createConnectionToken: ok() }
    const service = new WebSocketApiService(server as never)

    await service.createConnectionToken()
    await service.createConnectionToken()

    expect(server.createConnectionToken).toHaveBeenCalledTimes(2)
  })

  it('createConnectionToken should reject a concurrent call', async () => {
    const service = new WebSocketApiService({ createConnectionToken: pending() } as never)

    void service.createConnectionToken()

    await expect(service.createConnectionToken()).rejects.toThrow(ErrorMessage.GenericInProgress)
  })

  it('createConnectionToken should translate a transport failure into an ApiCallError', async () => {
    await expect(
      new WebSocketApiService({ createConnectionToken: boom() } as never).createConnectionToken(),
    ).rejects.toThrow(ErrorMessage.GenericFail)
  })

  it('authorizeCollaboration should pass the note uuid through', async () => {
    const server = { authorizeCollaboration: ok() }

    await new WebSocketApiService(server as never).authorizeCollaboration('note-1')

    expect(server.authorizeCollaboration).toHaveBeenCalledWith({ noteUuid: 'note-1' })
  })

  it('authorizeCollaboration should reject a concurrent call', async () => {
    const service = new WebSocketApiService({ authorizeCollaboration: pending() } as never)

    void service.authorizeCollaboration('note-1')

    await expect(service.authorizeCollaboration('note-1')).rejects.toThrow(ErrorMessage.GenericInProgress)
  })

  it('authorizeCollaboration should release the lock after a failure', async () => {
    const authorizeCollaboration = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response)
    const service = new WebSocketApiService({ authorizeCollaboration } as never)

    await expect(service.authorizeCollaboration('note-1')).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.authorizeCollaboration('note-1')).resolves.toBe(response)
  })
})

describe('AuthenticatorApiService', () => {
  it('should forward each call to the matching server method', async () => {
    const server = {
      list: ok(),
      delete: ok(),
      generateRegistrationOptions: ok(),
      verifyRegistrationResponse: ok(),
      generateAuthenticationOptions: ok(),
    }
    const service = new AuthenticatorApiService(server as never)

    await service.list()
    await service.delete('auth-1')
    await service.generateRegistrationOptions()
    await service.verifyRegistrationResponse('user-1', 'key', { attestation: true })
    await service.generateAuthenticationOptions('u')

    expect(server.list).toHaveBeenCalledWith({})
    expect(server.delete).toHaveBeenCalledWith({ authenticatorId: 'auth-1' })
    expect(server.generateRegistrationOptions).toHaveBeenCalledWith()
    expect(server.verifyRegistrationResponse).toHaveBeenCalledWith({
      userUuid: 'user-1',
      name: 'key',
      attestationResponse: { attestation: true },
    })
    expect(server.generateAuthenticationOptions).toHaveBeenCalledWith({ username: 'u' })
  })

  it('should reject concurrent calls per operation', async () => {
    const list = new AuthenticatorApiService({ list: pending() } as never)
    void list.list()
    await expect(list.list()).rejects.toThrow(ErrorMessage.GenericInProgress)

    const remove = new AuthenticatorApiService({ delete: pending() } as never)
    void remove.delete('auth-1')
    await expect(remove.delete('auth-1')).rejects.toThrow(ErrorMessage.GenericInProgress)

    const register = new AuthenticatorApiService({ generateRegistrationOptions: pending() } as never)
    void register.generateRegistrationOptions()
    await expect(register.generateRegistrationOptions()).rejects.toThrow(ErrorMessage.GenericInProgress)

    const verify = new AuthenticatorApiService({ verifyRegistrationResponse: pending() } as never)
    void verify.verifyRegistrationResponse('user-1', 'key', {})
    await expect(verify.verifyRegistrationResponse('user-1', 'key', {})).rejects.toThrow(ErrorMessage.GenericInProgress)

    const authenticate = new AuthenticatorApiService({ generateAuthenticationOptions: pending() } as never)
    void authenticate.generateAuthenticationOptions('u')
    await expect(authenticate.generateAuthenticationOptions('u')).rejects.toThrow(ErrorMessage.GenericInProgress)
  })

  it('should translate transport failures into ApiCallError', async () => {
    const service = new AuthenticatorApiService({
      list: boom(),
      delete: boom(),
      generateRegistrationOptions: boom(),
      verifyRegistrationResponse: boom(),
      generateAuthenticationOptions: boom(),
    } as never)

    await expect(service.list()).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.delete('auth-1')).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.generateRegistrationOptions()).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.verifyRegistrationResponse('user-1', 'key', {})).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.generateAuthenticationOptions('u')).rejects.toThrow(ErrorMessage.GenericFail)
  })
})

describe('SubscriptionApiService', () => {
  it('should stamp the api version on the invite operations', async () => {
    const server = { listInvites: ok(), cancelInvite: ok(), invite: ok(), acceptInvite: ok() }
    const service = new SubscriptionApiService(server as never, ApiVersion.v1)

    await service.listInvites()
    await service.cancelInvite('invite-1')
    await service.invite('a@b.c')
    await service.acceptInvite('invite-1')

    expect(server.listInvites).toHaveBeenCalledWith({ [ApiEndpointParam.ApiVersion]: ApiVersion.v1 })
    expect(server.cancelInvite).toHaveBeenCalledWith({
      [ApiEndpointParam.ApiVersion]: ApiVersion.v1,
      inviteUuid: 'invite-1',
    })
    expect(server.invite).toHaveBeenCalledWith({
      [ApiEndpointParam.ApiVersion]: ApiVersion.v1,
      identifier: 'a@b.c',
    })
    // acceptInvite deliberately does not carry the api version.
    expect(server.acceptInvite).toHaveBeenCalledWith({ inviteUuid: 'invite-1' })
  })

  it('should forward the subscription lookups untouched', async () => {
    const server = { confirmAppleIAP: ok(), getUserSubscription: ok(), getAvailableSubscriptions: ok() }
    const service = new SubscriptionApiService(server as never, ApiVersion.v0)
    const appleParams = { receipt: 'r' } as never

    await service.confirmAppleIAP(appleParams)
    await service.getUserSubscription({ userUuid: 'user-1' } as never)
    await service.getAvailableSubscriptions()

    expect(server.confirmAppleIAP).toHaveBeenCalledWith(appleParams)
    expect(server.getUserSubscription).toHaveBeenCalledWith({ userUuid: 'user-1' })
    expect(server.getAvailableSubscriptions).toHaveBeenCalledWith()
  })

  it('should reject concurrent calls per operation', async () => {
    const cases: [string, () => Promise<unknown>][] = []
    const build = (method: string, invoke: (service: SubscriptionApiService) => Promise<unknown>) => {
      const service = new SubscriptionApiService({ [method]: pending() } as never, ApiVersion.v0)
      void invoke(service)
      cases.push([method, () => invoke(service)])
    }

    build('listInvites', (service) => service.listInvites())
    build('cancelInvite', (service) => service.cancelInvite('invite-1'))
    build('invite', (service) => service.invite('a@b.c'))
    build('acceptInvite', (service) => service.acceptInvite('invite-1'))
    build('confirmAppleIAP', (service) => service.confirmAppleIAP({} as never))
    build('getUserSubscription', (service) => service.getUserSubscription({ userUuid: 'user-1' } as never))
    build('getAvailableSubscriptions', (service) => service.getAvailableSubscriptions())

    for (const [, retry] of cases) {
      await expect(retry()).rejects.toThrow(ErrorMessage.GenericInProgress)
    }
  })

  it('should translate invite transport failures into ApiCallError', async () => {
    const service = new SubscriptionApiService(
      { listInvites: boom(), cancelInvite: boom(), invite: boom(), acceptInvite: boom() } as never,
      ApiVersion.v0,
    )

    await expect(service.listInvites()).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.cancelInvite('invite-1')).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.invite('a@b.c')).rejects.toThrow(ErrorMessage.GenericFail)
    await expect(service.acceptInvite('invite-1')).rejects.toThrow(ErrorMessage.GenericFail)
  })

  it('should let the subscription lookups propagate the raw error and still release the lock', async () => {
    const getAvailableSubscriptions = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response)
    const service = new SubscriptionApiService({ getAvailableSubscriptions } as never, ApiVersion.v0)

    await expect(service.getAvailableSubscriptions()).rejects.toThrow('network down')
    await expect(service.getAvailableSubscriptions()).resolves.toBe(response)
  })
})

describe('UserApiService', () => {
  const keyParams = { getPortableValue: () => ({ pw_nonce: 'nonce', version: '004' }) } as never

  it('deleteAccount should send the server password header and release the lock', async () => {
    const userServer = { deleteAccount: ok() }
    const service = new UserApiService(userServer as never, {} as never, ApiVersion.v0)

    await service.deleteAccount({ userUuid: 'user-1', serverPassword: 'secret' })
    await service.deleteAccount({ userUuid: 'user-1', serverPassword: 'secret' })

    expect(userServer.deleteAccount).toHaveBeenCalledWith(
      { userUuid: 'user-1' },
      { headers: [{ key: 'x-server-password', value: 'secret' }] },
    )
    expect(userServer.deleteAccount).toHaveBeenCalledTimes(2)
  })

  it('submitUserRequest should forward the uuid and request type', async () => {
    const userRequestServer = { submitUserRequest: ok() }

    await new UserApiService({} as never, userRequestServer as never, ApiVersion.v0).submitUserRequest({
      userUuid: 'user-1',
      requestType: 'exit-discount' as never,
    })

    expect(userRequestServer.submitUserRequest).toHaveBeenCalledWith({
      userUuid: 'user-1',
      requestType: 'exit-discount',
    })
  })

  it('register should stamp the api version and merge the portable key params', async () => {
    const userServer = { register: ok() }

    await new UserApiService(userServer as never, {} as never, ApiVersion.v1).register({
      email: 'a@b.c',
      serverPassword: 'server-password',
      keyParams,
      ephemeral: true,
      hvmToken: 'hvm',
    })

    expect(userServer.register).toHaveBeenCalledWith({
      [ApiEndpointParam.ApiVersion]: ApiVersion.v1,
      password: 'server-password',
      email: 'a@b.c',
      hvm_token: 'hvm',
      ephemeral: true,
      pw_nonce: 'nonce',
      version: '004',
    })
  })

  it('register should include workspace and proof-of-work fields only when supplied', async () => {
    const userServer = { register: ok() }

    await new UserApiService(userServer as never, {} as never, ApiVersion.v0).register({
      email: 'a@b.c',
      serverPassword: 'p',
      keyParams,
      ephemeral: false,
      workspaceIdentifier: 'work',
      powSeed: 'seed',
      powNonce: 'nonce-value',
    })

    const body = userServer.register.mock.calls[0][0]
    expect(body.workspace_identifier).toBe('work')
    expect(body.pow_seed).toBe('seed')
    expect(body.pow_nonce).toBe('nonce-value')
  })

  it('updateUser should stamp the api version and the user uuid', async () => {
    const userServer = { update: ok() }

    await new UserApiService(userServer as never, {} as never, ApiVersion.v0).updateUser({ userUuid: 'user-1' })

    expect(userServer.update).toHaveBeenCalledWith({
      [ApiEndpointParam.ApiVersion]: ApiVersion.v0,
      user_uuid: 'user-1',
    })
  })

  it('should reject concurrent calls per operation', async () => {
    const deleting = new UserApiService({ deleteAccount: pending() } as never, {} as never, ApiVersion.v0)
    void deleting.deleteAccount({ userUuid: 'user-1', serverPassword: 's' })
    await expect(deleting.deleteAccount({ userUuid: 'user-1', serverPassword: 's' })).rejects.toThrow(
      ErrorMessage.GenericInProgress,
    )

    const submitting = new UserApiService({} as never, { submitUserRequest: pending() } as never, ApiVersion.v0)
    void submitting.submitUserRequest({ userUuid: 'user-1', requestType: 'x' as never })
    await expect(submitting.submitUserRequest({ userUuid: 'user-1', requestType: 'x' as never })).rejects.toThrow(
      ErrorMessage.GenericInProgress,
    )

    const registering = new UserApiService({ register: pending() } as never, {} as never, ApiVersion.v0)
    const registerDTO = { email: 'a@b.c', serverPassword: 'p', keyParams, ephemeral: false }
    void registering.register(registerDTO)
    await expect(registering.register(registerDTO)).rejects.toThrow(ErrorMessage.GenericInProgress)

    const updating = new UserApiService({ update: pending() } as never, {} as never, ApiVersion.v0)
    void updating.updateUser({ userUuid: 'user-1' })
    await expect(updating.updateUser({ userUuid: 'user-1' })).rejects.toThrow(ErrorMessage.GenericInProgress)
  })

  it('should translate transport failures into ApiCallError', async () => {
    const service = new UserApiService(
      { deleteAccount: boom(), register: boom(), update: boom() } as never,
      { submitUserRequest: boom() } as never,
      ApiVersion.v0,
    )

    await expect(service.deleteAccount({ userUuid: 'user-1', serverPassword: 's' })).rejects.toThrow(
      ErrorMessage.GenericFail,
    )
    await expect(service.submitUserRequest({ userUuid: 'user-1', requestType: 'x' as never })).rejects.toThrow(
      ErrorMessage.GenericFail,
    )
    await expect(
      service.register({ email: 'a@b.c', serverPassword: 'p', keyParams, ephemeral: false }),
    ).rejects.toThrow(ErrorMessage.GenericRegistrationFail)
    await expect(service.updateUser({ userUuid: 'user-1' })).rejects.toThrow(ErrorMessage.GenericFail)
  })
})
