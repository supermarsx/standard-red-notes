import { LegacyApiService } from './ApiService'

describe('session activity API', () => {
  const setup = () => {
    const post = jest.fn().mockResolvedValue({ status: 200, data: { active: true } })
    const get = jest.fn().mockResolvedValue({ status: 200, data: [] })
    const service = Object.create(LegacyApiService.prototype) as LegacyApiService
    Object.assign(service, {
      httpService: { post, get },
      session: { accessToken: 'test-token' },
      preprocessingError: () => undefined,
      getSessionAccessToken: () => 'test-token',
    })
    return { service, post, get }
  }
  it('posts only the opaque profile id and uses the existing authenticated API', async () => {
    const { service, post } = setup()
    await service.recordSessionActivity('opaque-profile')
    expect(post).toHaveBeenCalledWith(
      '/v1/sessions/activity',
      { device_id: 'opaque-profile' },
      { authentication: 'test-token' },
    )
  })
  it('encodes the admin target and passes no identity claims in the body', async () => {
    const { service, get } = setup()
    await service.getAdminUserSessions('user/target')
    expect(get).toHaveBeenCalledWith('/v1/admin/users/user%2Ftarget/sessions', {}, { authentication: 'test-token' })
  })

  it('does not quarantine a replacement sign-in from a late heartbeat failure belonging to the prior token', async () => {
    const { service, post } = setup()
    let token = 'prior-test-token'
    let finish!: (value: unknown) => void
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const preprocess = jest.fn()
    Object.assign(service, { getSessionAccessToken: () => token, preprocessAuthenticatedErrorResponse: preprocess })
    const pending = service.recordSessionActivity('opaque-profile')
    token = 'replacement-test-token'
    finish({ status: 401, data: { error: { message: 'Expired' } } })
    await pending
    expect(preprocess).not.toHaveBeenCalled()
  })

  it('requests the caller storage measurement without another user identifier', async () => {
    const { service, get } = setup()
    await service.getAccountStorageUsage()
    expect(get).toHaveBeenCalledWith('/v1/items/storage-usage', {}, { authentication: 'test-token' })
  })

  it('uses the explicit reset-all contract instead of the old TOTP-only reset', async () => {
    const { service } = setup()
    const request = jest.fn().mockResolvedValue({ status: 200 })
    Object.assign(service, { host: 'https://example.test', tokenRefreshableRequest: request })
    await service.adminGetUserMfaStatus('target')
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://example.test/v1/admin/users/target/mfa/status',
        authentication: 'test-token',
      }),
    )
    await service.adminResetAllUserFactors('target')
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://example.test/v1/admin/users/target/mfa/reset',
        params: { intent: 'reset_all_factors', userUuid: 'target' },
        authentication: 'test-token',
      }),
    )
    await service.adminGetUserStorageUsage('target')
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://example.test/v1/admin/users/target/storage-usage',
        authentication: 'test-token',
      }),
    )
  })
})
