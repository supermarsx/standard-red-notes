import {
  INTERNAL_GRPC_AUTH_METADATA,
  INTERNAL_GRPC_AUTH_REPLAY_WINDOW_MILLISECONDS,
  INTERNAL_GRPC_AUTH_VERSION,
  InternalGrpcAuthScope,
  InternalGrpcServiceAuth,
} from './InternalGrpcServiceAuth'

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

  it('refuses to issue a proof it cannot stand behind', () => {
    // Returning an unsigned or empty proof would let an unconfigured service
    // originate calls that a configured peer might treat as authenticated.
    // Failing loudly at the signer is the only safe direction.
    expect(() => new InternalGrpcServiceAuth(undefined, () => now).sign(scope)).toThrow(
      'Internal gRPC service authentication is not configured.',
    )
    expect(() => new InternalGrpcServiceAuth('too-short', () => now).sign(scope)).toThrow(
      'Internal gRPC service authentication is not configured.',
    )
  })

  describe('proofs whose shape is wrong are refused before any comparison', () => {
    const verifier = () => new InternalGrpcServiceAuth(secret, () => now)
    const validProof = () => new InternalGrpcServiceAuth(secret, () => now).sign(scope)

    it.each([
      ['an unknown version', { version: 'v2' }],
      ['a missing version', { version: undefined }],
      ['a non-string timestamp', { timestamp: undefined }],
      ['a non-numeric timestamp', { timestamp: 'not-a-number' }],
      ['a signed timestamp', { timestamp: '-1787056496789' }],
      ['a missing signature', { signature: undefined }],
      ['a short signature', { signature: 'abc' }],
      ['a non-hex signature', { signature: 'z'.repeat(64) }],
    ])('rejects %s as invalid', (_label, change) => {
      expect(verifier().verify(scope, { ...validProof(), ...change })).toBe('invalid')
    })

    it('treats a timestamp too large to be a safe integer as stale, not valid', () => {
      // Digits only, so it passes the shape check and reaches the window test.
      // Number() flattens it to something unsafe, and an unbounded timestamp
      // must never be allowed to satisfy the replay window.
      expect(verifier().verify(scope, { ...validProof(), timestamp: '9'.repeat(30) })).toBe('stale')
    })
  })

  describe('how a scope is reduced to a signing message', () => {
    it('treats an absent session the same whether it is undefined or null', () => {
      const auth = new InternalGrpcServiceAuth(secret, () => now)
      const withoutSession: InternalGrpcAuthScope = { ...scope, sessionUuid: undefined }
      const nullSession: InternalGrpcAuthScope = { ...scope, sessionUuid: null }

      expect(auth.sign(withoutSession).signature).toBe(auth.sign(nullSession).signature)
      expect(auth.verify(nullSession, auth.sign(withoutSession))).toBe('valid')
    })

    it('does not let an absent session pass for a present one', () => {
      const auth = new InternalGrpcServiceAuth(secret, () => now)

      // Otherwise a caller could drop the session and reuse a session-scoped proof.
      expect(auth.verify({ ...scope, sessionUuid: undefined }, auth.sign(scope))).toBe('invalid')
    })

    it('signs a scope carrying no digests at all', () => {
      const auth = new InternalGrpcServiceAuth(secret, () => now)
      const bare: InternalGrpcAuthScope = {
        method: 'getSyncCommandStatus',
        userUuid: 'user-1',
        commandId: 'command-1',
      }

      expect(auth.verify(bare, auth.sign(bare))).toBe('valid')
      // An omitted digest must not be interchangeable with a present one.
      expect(auth.verify({ ...bare, bodyDigest: 'e'.repeat(64) }, auth.sign(bare))).toBe('invalid')
    })

    it('reads hex digests case-insensitively, since case carries no meaning', () => {
      const auth = new InternalGrpcServiceAuth(secret, () => now)
      const upper: InternalGrpcAuthScope = { ...scope, commandDigest: 'A'.repeat(64), bodyDigest: 'B'.repeat(64) }
      const lower: InternalGrpcAuthScope = { ...scope, commandDigest: 'a'.repeat(64), bodyDigest: 'b'.repeat(64) }

      expect(auth.verify(lower, auth.sign(upper))).toBe('valid')
    })
  })

  describe('the contract this module shares with its peer service', () => {
    it('carries the proof in metadata keys both sides agree on', () => {
      // These header names cross a deploy boundary. Renaming one here without
      // renaming it in the gateway fails authentication in production, not in
      // a compiler, so the names themselves are part of the tested surface.
      expect(INTERNAL_GRPC_AUTH_METADATA).toEqual({
        version: 'x-sync-service-auth-version',
        timestamp: 'x-sync-service-auth-timestamp',
        signature: 'x-sync-service-auth-signature',
      })
      expect(new InternalGrpcServiceAuth(secret, () => now).sign(scope).version).toBe(INTERNAL_GRPC_AUTH_VERSION)
    })

    it('accepts a proof exactly at the replay window and refuses the millisecond past it', () => {
      const verifier = new InternalGrpcServiceAuth(secret, () => now)

      const atEdge = new InternalGrpcServiceAuth(secret, () => now - INTERNAL_GRPC_AUTH_REPLAY_WINDOW_MILLISECONDS)
      expect(verifier.verify(scope, atEdge.sign(scope))).toBe('valid')

      const pastEdge = new InternalGrpcServiceAuth(
        secret,
        () => now - INTERNAL_GRPC_AUTH_REPLAY_WINDOW_MILLISECONDS - 1,
      )
      expect(verifier.verify(scope, pastEdge.sign(scope))).toBe('stale')
    })

    it('honours a replay window narrower than the default', () => {
      const verifier = new InternalGrpcServiceAuth(secret, () => now, 1_000)
      const signer = new InternalGrpcServiceAuth(secret, () => now - 1_001)

      expect(verifier.verify(scope, signer.sign(scope))).toBe('stale')
    })
  })

  it('uses the real clock when no clock is injected', () => {
    const auth = new InternalGrpcServiceAuth(secret)
    const before = Date.now()

    const proof = auth.sign(scope)

    const stamped = Number(proof.timestamp)
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(Date.now())
    expect(auth.verify(scope, proof)).toBe('valid')
  })
})
