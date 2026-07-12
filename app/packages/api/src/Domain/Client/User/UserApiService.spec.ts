import { ApiVersion } from '../../Api/ApiVersion'
import { UserApiService } from './UserApiService'

/**
 * Standard Red Notes: INVITE-URL signup control — the register request body must
 * carry `invite_token` ONLY when an invite token is supplied, so an ordinary
 * signup is byte-for-byte identical to before the feature existed (mirrors the
 * workspace_identifier / pow_* conditional-spread guarantee).
 */
describe('UserApiService register invite_token threading', () => {
  const makeService = (registerMock: jest.Mock) => {
    const userServer = { register: registerMock } as never
    const userRequestServer = {} as never

    return new UserApiService(userServer, userRequestServer, ApiVersion.v0)
  }

  const keyParams = {
    getPortableValue: () => ({ pw_nonce: 'nonce', version: '004' }),
  } as never

  const baseDTO = {
    email: 'user@example.com',
    serverPassword: 'server-password',
    keyParams,
    ephemeral: false,
  }

  it('omits invite_token entirely when no token is supplied', async () => {
    const registerMock = jest.fn().mockResolvedValue({ status: 200, data: {} })
    await makeService(registerMock).register({ ...baseDTO })

    const body = registerMock.mock.calls[0][0]
    expect('invite_token' in body).toBe(false)
  })

  it('includes invite_token only when supplied, leaving the rest of the body unchanged', async () => {
    const withoutToken = jest.fn().mockResolvedValue({ status: 200, data: {} })
    const withToken = jest.fn().mockResolvedValue({ status: 200, data: {} })

    await makeService(withoutToken).register({ ...baseDTO })
    await makeService(withToken).register({ ...baseDTO, inviteToken: 'raw-invite-token' })

    const plainBody = withoutToken.mock.calls[0][0]
    const tokenBody = withToken.mock.calls[0][0]

    expect(tokenBody.invite_token).toBe('raw-invite-token')
    // The token body is exactly the plain body plus the single invite_token key.
    expect({ ...tokenBody, invite_token: undefined }).toEqual({ ...plainBody, invite_token: undefined })
  })

  it('does not send invite_token when the token is an empty string (conditional spread)', async () => {
    const registerMock = jest.fn().mockResolvedValue({ status: 200, data: {} })
    await makeService(registerMock).register({ ...baseDTO, inviteToken: '' })

    expect('invite_token' in registerMock.mock.calls[0][0]).toBe(false)
  })
})
