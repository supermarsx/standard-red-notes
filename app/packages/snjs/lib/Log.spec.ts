import { SNLog } from './Log'

describe('SNLog', () => {
  afterEach(() => {
    ;(SNLog.onLog as unknown) = undefined
    ;(SNLog.onError as unknown) = undefined
  })

  it('redacts structured log arguments before forwarding them to the host sink', () => {
    SNLog.onLog = jest.fn()

    SNLog.log(
      'request failed',
      {
        accessToken: 'access-token-sentinel',
        content: 'encrypted-content-sentinel',
        userId: 'user-123',
      },
      new Error('opaque-error-sentinel'),
    )

    expect(SNLog.onLog).toHaveBeenCalledWith(
      'request failed',
      {
        accessToken: '[REDACTED]',
        content: '[REDACTED]',
        userId: 'user-123',
      },
      {
        errorType: 'Error',
        errorCode: undefined,
        status: undefined,
      },
    )
    expect(JSON.stringify((SNLog.onLog as jest.Mock).mock.calls)).not.toContain('opaque-error-sentinel')
  })

  it('forwards only fixed text and allowlisted metadata while returning the original error', () => {
    SNLog.onError = jest.fn()
    const original = Object.assign(new Error('opaque-upstream-secret'), {
      code: 'ERR_NETWORK',
      accessToken: 'access-token-sentinel',
    })

    expect(SNLog.error(original)).toBe(original)

    const forwarded = (SNLog.onError as jest.Mock).mock.calls[0][0] as Error & Record<string, unknown>
    expect(forwarded).not.toBe(original)
    expect(forwarded.message).toBe('A Standard Notes operation failed.')
    expect(forwarded.name).toBe('Error')
    expect(forwarded.errorCode).toBe('ERR_NETWORK')
    expect(JSON.stringify(forwarded)).not.toContain('opaque-upstream-secret')
    expect(JSON.stringify(forwarded)).not.toContain('access-token-sentinel')
  })
})
