import { Status } from '@grpc/grpc-js/build/src/constants'

import {
  classifyGrpcFailure,
  GRPC_FALLBACK_ELIGIBILITY,
  GRPC_FALLBACK_REFUSAL_CODES,
  GRPC_FALLBACK_REFUSAL_STATUS,
  grpcFallbackRefusal,
  mayFallBackToHttp,
  syncPayloadWritesNothing,
  type GrpcCallReplaySafety,
  type GrpcFailureClass,
} from './GrpcTransportFallback'

describe('GrpcTransportFallback', () => {
  describe('classifyGrpcFailure', () => {
    const cases: [number, GrpcFailureClass][] = [
      [Status.UNAVAILABLE, 'channel-unavailable'],
      [Status.DEADLINE_EXCEEDED, 'deadline-exceeded'],
      [Status.UNIMPLEMENTED, 'method-unimplemented'],
      [Status.INTERNAL, 'transport-internal'],
      [Status.RESOURCE_EXHAUSTED, 'message-limit'],
      [Status.CANCELLED, 'cancelled'],
      [Status.UNKNOWN, 'server-fault'],
    ]

    it.each(cases)('maps gRPC status %i onto its own class', (code, expected) => {
      expect(classifyGrpcFailure({ code })).toBe(expected)
    })

    /**
     * Every status that is NOT in the table is a deliberate backend answer, and
     * must land on `application` — the only class no replay safety accepts
     * besides the empty one. Enumerated rather than sampled so a new grpc-js
     * status cannot quietly inherit transport treatment.
     */
    it('maps every other gRPC status onto a deliberate application answer', () => {
      const mapped = new Set(cases.map(([code]) => code))
      const remaining = Object.values(Status).filter(
        (value): value is number => typeof value === 'number' && !mapped.has(value),
      )

      expect(remaining.length).toBeGreaterThan(8)
      for (const code of remaining) {
        expect(classifyGrpcFailure({ code })).toBe('application')
      }
    })

    it('treats an error with no numeric gRPC code as never dispatched', () => {
      expect(classifyGrpcFailure(new Error('channel closed'))).toBe('never-dispatched')
      expect(classifyGrpcFailure({ message: 'no code at all' })).toBe('never-dispatched')
      expect(classifyGrpcFailure({ code: 'ETIMEDOUT' })).toBe('never-dispatched')
      expect(classifyGrpcFailure(undefined)).toBe('never-dispatched')
      expect(classifyGrpcFailure(null)).toBe('never-dispatched')
      expect(classifyGrpcFailure('string throw')).toBe('never-dispatched')
    })
  })

  describe('mayFallBackToHttp', () => {
    const allClasses: GrpcFailureClass[] = [
      'channel-unavailable',
      'deadline-exceeded',
      'method-unimplemented',
      'transport-internal',
      'message-limit',
      'cancelled',
      'server-fault',
      'never-dispatched',
      'application',
    ]

    it('lets a read fall back on the whole transport-fault family', () => {
      const eligible = allClasses.filter((failure) => mayFallBackToHttp('read-only', failure))

      expect(eligible).toEqual([
        'channel-unavailable',
        'deadline-exceeded',
        'method-unimplemented',
        'transport-internal',
        'message-limit',
        'never-dispatched',
      ])
    })

    /**
     * `message-limit` is the single difference from the read set, and it is the
     * one that matters: `RESOURCE_EXHAUSTED` is how the syncing server says
     * "over the content limit", and the gateway publishes a
     * ContentSizesFixRequested domain event on it.
     */
    it('lets a ledger-deduplicated mutation fall back, but never on RESOURCE_EXHAUSTED', () => {
      const eligible = allClasses.filter((failure) => mayFallBackToHttp('idempotent-mutation', failure))

      expect(eligible).toEqual([
        'channel-unavailable',
        'deadline-exceeded',
        'method-unimplemented',
        'transport-internal',
        'never-dispatched',
      ])
      expect(mayFallBackToHttp('idempotent-mutation', 'message-limit')).toBe(false)
    })

    /**
     * The whole point of the module. No failure class — not even the one that
     * proves the request never left the gateway — authorises a second delivery
     * of an un-deduplicated write over a second transport.
     */
    it('NEVER lets an un-deduplicated mutation fall back, on any failure class', () => {
      for (const failure of allClasses) {
        expect(mayFallBackToHttp('non-idempotent-mutation', failure)).toBe(false)
      }
      expect(GRPC_FALLBACK_ELIGIBILITY['non-idempotent-mutation']).toEqual([])
    })

    it('never lets a cancelled call, a backend fault or an application answer fall back on any lane', () => {
      const safeties: GrpcCallReplaySafety[] = ['read-only', 'idempotent-mutation', 'non-idempotent-mutation']

      for (const safety of safeties) {
        for (const failure of ['cancelled', 'server-fault', 'application'] as GrpcFailureClass[]) {
          expect(mayFallBackToHttp(safety, failure)).toBe(false)
        }
      }
    })
  })

  describe('grpcFallbackRefusal', () => {
    const safeties: GrpcCallReplaySafety[] = ['read-only', 'idempotent-mutation', 'non-idempotent-mutation']

    it('gives each replay safety its own code, all of them from the closed set', () => {
      const codes = safeties.map((safety) => grpcFallbackRefusal(safety).error.code)

      expect(codes).toEqual([
        'SYNC_TRANSPORT_READ_FAILED',
        'SYNC_COMMAND_OUTCOME_UNKNOWN',
        'SYNC_WRITE_OUTCOME_UNKNOWN',
      ])
      expect(new Set(codes).size).toBe(codes.length)
      expect([...GRPC_FALLBACK_REFUSAL_CODES].sort()).toEqual([...codes].sort())
    })

    /**
     * The payload contract: a code, a retryability flag, fixed copy, and NOTHING
     * else. Asserted as exact key lists at both levels so a field added later
     * fails here rather than reaching the wire.
     */
    it('puts exactly a code, a message and a retryability flag on the wire', () => {
      for (const safety of safeties) {
        const body = grpcFallbackRefusal(safety)

        expect(Object.keys(body)).toEqual(['error'])
        expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'retryable'])
      }
    })

    /**
     * The honesty property, and the one a mutation flipping a flag must break.
     * `false` on the two write codes is the whole point: the outcome is unknown,
     * so the response may not claim the request is safe to repeat. `false` on the
     * read code is honest too — every transport-fault class a read may cross
     * transports on is served over HTTP and so never reaches a refusal, leaving
     * only answers the backend's own handler gave.
     */
    it('never reports a refusal as retryable', () => {
      for (const safety of safeties) {
        expect(grpcFallbackRefusal(safety).error.retryable).toBe(false)
      }
    })

    /**
     * The copy has to express "the outcome is unknown, reconcile" and must NEVER
     * read as "retry": a client acting on the opposite reading re-delivers the
     * same item hashes and earns the user a duplicated note, which is precisely
     * what the refusal exists to prevent.
     */
    it.each([['idempotent-mutation'], ['non-idempotent-mutation']] as [GrpcCallReplaySafety][])(
      'tells a refused %s that the outcome is unknown and to reconcile, never to retry',
      (safety) => {
        const message = grpcFallbackRefusal(safety).error.message

        expect(message).toMatch(/\bunknown\b/iu)
        expect(message).toMatch(/\breconcile\b/iu)
        expect(message).not.toMatch(/retry|retried|retrying|try again|resend|send it again/iu)
      },
    )

    it('tells a refused read there is nothing to reconcile, since nothing was written', () => {
      const message = grpcFallbackRefusal('read-only').error.message

      expect(message).toMatch(/\bnothing was written\b/iu)
      expect(message).not.toMatch(/\bunknown\b/iu)
      expect(message).not.toMatch(/retry|retried|retrying|try again|resend|send it again/iu)
    })

    /**
     * The secrecy boundary, as a property of the SIGNATURE rather than of a scan:
     * the only argument is a member of a closed three-value union, so the copy
     * cannot vary with a path, a uuid, a URL, a gRPC status or an upstream
     * message. Pinned by calling it twice and demanding byte-identical output.
     */
    it('derives the whole body from the replay safety alone, so no input can travel through it', () => {
      for (const safety of safeties) {
        expect(JSON.stringify(grpcFallbackRefusal(safety))).toBe(JSON.stringify(grpcFallbackRefusal(safety)))
      }

      const serialized = safeties.map((safety) => JSON.stringify(grpcFallbackRefusal(safety))).join('|')
      for (const transportDetail of [
        'channel-unavailable',
        'deadline-exceeded',
        'method-unimplemented',
        'transport-internal',
        'message-limit',
        'cancelled',
        'server-fault',
        'never-dispatched',
        'application',
        'grpc',
        'gRPC',
        'http',
        'HTTP',
        'items/sync',
      ]) {
        expect(serialized).not.toContain(transportDetail)
      }
    })

    /**
     * The status is deliberately the one live measurement found. A refusal that
     * started answering 503 — or that carried a Retry-After — would be saying
     * "retry" in the HTTP envelope while the body said "reconcile".
     */
    it('keeps the status the bare 500 this replaces used', () => {
      expect(GRPC_FALLBACK_REFUSAL_STATUS).toBe(500)
    })
  })

  describe('syncPayloadWritesNothing', () => {
    it('accepts a poll body built only from read-only keys', () => {
      expect(
        syncPayloadWritesNothing({
          api: '20200115',
          sync_token: 'token',
          cursor_token: 'cursor',
          limit: 150,
          content_type: 'Note',
          compute_integrity: true,
          shared_vault_uuids: ['v-1'],
        }),
      ).toBe(true)
    })

    it('accepts an explicitly empty items array', () => {
      expect(syncPayloadWritesNothing({ api: '20200115', items: [] })).toBe(true)
    })

    it('rejects any payload that carries even one item', () => {
      expect(syncPayloadWritesNothing({ api: '20200115', items: [{ uuid: 'i-1' }] })).toBe(false)
    })

    it('rejects a non-array items field rather than reading it as empty', () => {
      expect(syncPayloadWritesNothing({ api: '20200115', items: {} })).toBe(false)
      expect(syncPayloadWritesNothing({ api: '20200115', items: null })).toBe(false)
    })

    /**
     * The allow-list is the safety property: an upstream body field nobody here
     * has classified must make the call look MUTATING, never inherit read-only
     * treatment by default.
     */
    it('rejects an unrecognised body key', () => {
      expect(syncPayloadWritesNothing({ api: '20200115', some_new_upstream_field: 'x' })).toBe(false)
    })

    it('rejects a body carrying command metadata, which is decided separately', () => {
      expect(
        syncPayloadWritesNothing({ api: '20200115', items: [], command: { id: 'c-1', digest: 'a'.repeat(64) } }),
      ).toBe(false)
    })

    it('rejects a raw string body and an absent body', () => {
      expect(syncPayloadWritesNothing('raw-body')).toBe(false)
      expect(syncPayloadWritesNothing(undefined)).toBe(false)
    })
  })
})
