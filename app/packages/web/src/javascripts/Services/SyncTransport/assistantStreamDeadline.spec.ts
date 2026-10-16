import { maximumRpcDeadlineMs } from './syncTransportProtocol'

describe('assistant-only streaming deadline', () => {
  it.each(['/v1/assistant/stream', '/v1/assistant/stream?api=20240226'])(
    'allows the bounded five-minute server generation plus transport margin for %s',
    (path) => {
      expect(maximumRpcDeadlineMs({ method: 'POST', path, stream: true })).toBe(330_000)
    },
  )
  it.each([
    { method: 'GET', path: '/v1/assistant/stream', stream: true },
    { method: 'POST', path: '/v1/assistant/stream', stream: false },
    { method: 'POST', path: '/v1/assistant/stream/other', stream: true },
    { method: 'POST', path: '/v1/items', stream: true },
  ])('keeps other RPCs at the existing maximum: %j', (request) => {
    expect(maximumRpcDeadlineMs(request)).toBe(120_000)
  })
})
