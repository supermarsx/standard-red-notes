import { INTERNAL_GRPC_AUTH_VERSION, InternalGrpcAuthScope, InternalGrpcServiceAuth } from './InternalGrpcServiceAuth'

describe('InternalGrpcServiceAuth', () => {
  const secret = 'a'.repeat(64)
  const now = 1_787_056_496_789
  const scope: InternalGrpcAuthScope = {
    method: 'syncItems',
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    commandId: 'command-1',
    commandDigest: 'A'.repeat(64),
    bodyDigest: 'B'.repeat(64),
  }

  it('signs and verifies the complete versioned durable scope', () => {
    const auth = new InternalGrpcServiceAuth(secret, () => now)

    const proof = auth.sign(scope)

    expect(proof).toEqual({
      version: INTERNAL_GRPC_AUTH_VERSION,
      timestamp: String(now),
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(auth.verify(scope, proof)).toBe('valid')
  })

  it.each([
    ['method', { method: 'getSyncCommandStatus' as const }],
    ['user', { userUuid: 'user-2' }],
    ['session', { sessionUuid: 'session-2' }],
    ['command id', { commandId: 'command-2' }],
    ['command digest', { commandDigest: 'c'.repeat(64) }],
    ['body digest', { bodyDigest: 'd'.repeat(64) }],
  ])('rejects a signature when the %s scope changes', (_label, change) => {
    const auth = new InternalGrpcServiceAuth(secret, () => now)
    const proof = auth.sign(scope)

    expect(auth.verify({ ...scope, ...change }, proof)).toBe('invalid')
  })

  it('rejects stale and future proofs outside the replay window', () => {
    const signer = new InternalGrpcServiceAuth(secret, () => now - 60_001)
    const verifier = new InternalGrpcServiceAuth(secret, () => now)

    expect(verifier.verify(scope, signer.sign(scope))).toBe('stale')

    const futureSigner = new InternalGrpcServiceAuth(secret, () => now + 60_001)
    expect(verifier.verify(scope, futureSigner.sign(scope))).toBe('stale')
  })

  it('fails closed for absent, short, malformed, or wrong-secret authentication', () => {
    const absent = new InternalGrpcServiceAuth(undefined, () => now)
    const short = new InternalGrpcServiceAuth('short', () => now)
    const signer = new InternalGrpcServiceAuth(secret, () => now)
    const proof = signer.sign(scope)

    expect(absent.ready()).toBe(false)
    expect(short.ready()).toBe(false)
    expect(absent.verify(scope, proof)).toBe('unconfigured')
    expect(short.verify(scope, proof)).toBe('unconfigured')
    expect(signer.verify(scope, { ...proof, signature: 'not-a-signature' })).toBe('invalid')
    expect(new InternalGrpcServiceAuth('b'.repeat(64), () => now).verify(scope, proof)).toBe('invalid')
  })
})
