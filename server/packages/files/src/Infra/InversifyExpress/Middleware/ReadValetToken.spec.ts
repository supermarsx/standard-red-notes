import { Request } from 'express'

import { MAX_VALET_TOKEN_LENGTH, readValetToken } from './ReadValetToken'

describe('readValetToken', () => {
  const request = (values: Partial<Pick<Request, 'body' | 'headers' | 'query'>>): Request =>
    ({ headers: {}, query: {}, body: undefined, ...values }) as unknown as Request

  it('accepts a bounded header token', () => {
    expect(readValetToken(request({ headers: { 'x-valet-token': 'header-token' } }))).toBe('header-token')
  })

  it('accepts a bounded body token when the header is absent', () => {
    expect(readValetToken(request({ body: { valetToken: 'body-token' } }))).toBe('body-token')
  })

  it('never accepts a query-string token', () => {
    expect(readValetToken(request({ query: { valetToken: 'query-token' } }))).toBeUndefined()
  })

  it.each([
    ['header', { headers: { 'x-valet-token': 'x'.repeat(MAX_VALET_TOKEN_LENGTH + 1) } }],
    ['body', { body: { valetToken: 'x'.repeat(MAX_VALET_TOKEN_LENGTH + 1) } }],
  ])('rejects an oversized %s token', (_source, values) => {
    expect(readValetToken(request(values))).toBeUndefined()
  })

  it('rejects duplicate header values instead of choosing one', () => {
    expect(readValetToken(request({ headers: { 'x-valet-token': ['first', 'second'] } }))).toBeUndefined()
  })

  it('does not fall back to a body token when a malformed header is present', () => {
    expect(
      readValetToken(
        request({
          headers: { 'x-valet-token': ['first', 'second'] },
          body: { valetToken: 'body-token' },
        }),
      ),
    ).toBeUndefined()
  })
})
