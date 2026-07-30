import { LegacyApiService } from './ApiService'

describe('LegacyApiService.changeCredentials', () => {
  const createService = (httpService: { put: jest.Mock }) => {
    const service = new LegacyApiService(
      httpService as never,
      {} as never,
      'https://sync.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    ;(service as unknown as { session: unknown }).session = {
      accessToken: 'access-token',
    }

    return service
  }

  it('clears the in-progress latch when the request rejects so the operation can be retried', async () => {
    const requestFailure = new Error('connection dropped')
    const successResponse = {
      status: 200,
      data: {},
    }
    const httpService = {
      put: jest.fn().mockRejectedValueOnce(requestFailure).mockResolvedValueOnce(successResponse),
    }
    const service = createService(httpService)

    const parameters = {
      userUuid: 'user-uuid',
      currentServerPassword: 'current-server-password',
      newServerPassword: 'new-server-password',
      newKeyParams: {
        getPortableValue: () => ({
          identifier: 'user@example.com',
          version: '004',
        }),
      },
    }

    await expect(service.changeCredentials(parameters as never)).rejects.toBe(requestFailure)
    await expect(service.changeCredentials(parameters as never)).resolves.toBe(successResponse)

    expect(httpService.put).toHaveBeenCalledTimes(2)
  })

  it('clears the in-progress latch when key-parameter serialization throws', async () => {
    const serializationFailure = new Error('invalid key params')
    const successResponse = {
      status: 200,
      data: {},
    }
    const httpService = {
      put: jest.fn().mockResolvedValue(successResponse),
    }
    const service = createService(httpService)
    const getPortableValue = jest
      .fn()
      .mockImplementationOnce(() => {
        throw serializationFailure
      })
      .mockReturnValue({
        identifier: 'user@example.com',
        version: '004',
      })
    const parameters = {
      userUuid: 'user-uuid',
      currentServerPassword: 'current-server-password',
      newServerPassword: 'new-server-password',
      newKeyParams: {
        getPortableValue,
      },
    }

    await expect(service.changeCredentials(parameters as never)).rejects.toBe(serializationFailure)
    await expect(service.changeCredentials(parameters as never)).resolves.toBe(successResponse)

    expect(httpService.put).toHaveBeenCalledTimes(1)
  })
})
