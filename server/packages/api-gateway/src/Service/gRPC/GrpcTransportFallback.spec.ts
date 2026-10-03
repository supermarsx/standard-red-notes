import { Status } from '@grpc/grpc-js/build/src/constants'

import {
  classifyGrpcFailure,
  GRPC_FALLBACK_ELIGIBILITY,
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
