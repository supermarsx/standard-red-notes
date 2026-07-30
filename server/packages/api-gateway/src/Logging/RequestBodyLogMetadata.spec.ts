import { requestBodyLogMetadata } from './RequestBodyLogMetadata'

describe('requestBodyLogMetadata', () => {
  it('reports only shape and never includes secret values or field names', () => {
    const password = 'correct horse battery staple'
    const token = 'secret-token'

    const metadata = requestBodyLogMetadata({
      email: 'person@example.com',
      password,
      nested: { token },
    })
    const serialized = JSON.stringify(metadata)

    expect(metadata).toEqual({ kind: 'object', fieldCount: 3 })
    expect(serialized).not.toContain(password)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('nested')
  })

  it('describes absent, array, and primitive bodies without serializing them', () => {
    expect(requestBodyLogMetadata(undefined)).toEqual({ kind: 'absent' })
    expect(requestBodyLogMetadata(['secret', 'values'])).toEqual({ kind: 'array', elementCount: 2 })
    expect(requestBodyLogMetadata('secret')).toEqual({ kind: 'primitive', primitiveType: 'string' })
  })
})
