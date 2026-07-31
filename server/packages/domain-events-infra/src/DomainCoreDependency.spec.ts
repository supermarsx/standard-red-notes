import { safeErrorLogMetadata } from '@standardnotes/domain-core'

describe('@standardnotes/domain-core runtime dependency', () => {
  it('loads the safe error classifier from the package entry point without exposing error details', () => {
    const metadata = safeErrorLogMetadata(
      Object.assign(new TypeError('message-secret-sentinel'), {
        code: 'ECONNREFUSED',
        stack: 'stack-secret-sentinel',
        response: {
          status: 502,
          data: 'provider-body-secret-sentinel',
        },
      }),
    )

    expect(typeof safeErrorLogMetadata).toBe('function')
    expect(metadata).toEqual({
      errorType: 'TypeError',
      errorCode: 'ECONNREFUSED',
      status: 502,
    })
    expect(JSON.stringify(metadata)).not.toMatch(/message-secret|stack-secret|provider-body-secret/)
  })
})
