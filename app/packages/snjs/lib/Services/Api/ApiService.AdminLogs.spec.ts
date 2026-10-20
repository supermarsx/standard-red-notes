import { LegacyApiService } from './ApiService'

it('dispatches authenticated bounded log queries with literal search and UTC lower bound', async () => {
  const service = Object.create(LegacyApiService.prototype) as LegacyApiService
  const request = jest.fn().mockResolvedValue({ status: 200 })
  Object.assign(service, {
    host: 'https://example.test',
    getSessionAccessToken: () => 'admin-test-token',
    tokenRefreshableRequest: request,
  })
  await service.adminGetLogs({
    limit: 100,
    service: 'auth',
    level: 'warn',
    order: 'asc',
    search: '[literal]',
    since: '2026-10-14T12:00:00.000Z',
  })
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      authentication: 'admin-test-token',
      params: {
        limit: '100',
        service: 'auth',
        level: 'warn',
        order: 'asc',
        search: '[literal]',
        since: '2026-10-14T12:00:00.000Z',
      },
    }),
  )
})
