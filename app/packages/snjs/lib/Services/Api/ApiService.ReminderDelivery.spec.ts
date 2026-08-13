import { HttpVerb } from '@standardnotes/responses'

import { LegacyApiService } from './ApiService'

describe('LegacyApiService reminder delivery', () => {
  const createService = () => {
    const runHttp = jest.fn().mockResolvedValue({ status: 200, data: { optedOut: true } })
    const service = new LegacyApiService(
      { runHttp } as never,
      {} as never,
      'https://sync.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    ;(service as unknown as { session: unknown }).session = { accessToken: 'access-token' }

    return { service, runHttp }
  }

  it('posts the authenticated authoritative opt-out request', async () => {
    const { service, runHttp } = createService()

    await expect(service.optOutReminderDelivery()).resolves.toEqual({ status: 200, data: { optedOut: true } })

    expect(runHttp).toHaveBeenCalledWith({
      verb: HttpVerb.Post,
      url: 'https://sync.example.test/v1/reminder-delivery/opt-out',
      authentication: 'access-token',
      fallbackErrorMessage: 'Failed to opt out of reminder delivery.',
    })
  })
})
