import { ConflictType, HttpResponse, RawSyncResponse, ServerItemResponse } from '@standardnotes/responses'
import { ServerSyncResponse } from './Response'

/**
 * Standard Red Notes: sync conflict with a filtered-out server_item regression.
 *
 * Companion to the delta-layer regression in
 * `models/.../Deltas/RemoteDataConflicts.spec.ts`. That spec proves the delta
 * survives a conflict whose `server_item` is undefined; THIS spec proves the
 * PREVENTION layer one step earlier — `ServerSyncResponse.filterConflictsAndDisallowedPayloads`
 * — never produces such a half-formed typed conflict in the first place.
 *
 * Root cause: the server can send a `sync_conflict` (ConflictingData) whose
 * `server_item` fails local payload filtering (e.g. a decrypted-object payload
 * that should have arrived encrypted). The disallowed payload is routed to an
 * `InvalidServerItem` conflict; the original `sync_conflict` entry must then be
 * DROPPED. If it were kept, it would carry an undefined `server_item` and throw
 * in `DeltaRemoteDataConflicts`, aborting the whole sync resolution before the
 * rejected-payload handler runs — leaving the item dirty and re-syncing forever
 * (the conflict-error flood + duplicated-on-create bug).
 */

const successResponse = (data: Partial<RawSyncResponse>): HttpResponse<RawSyncResponse> =>
  ({
    status: 200,
    data: data as RawSyncResponse,
  }) as HttpResponse<RawSyncResponse>

/**
 * A server_item the local filter will DISALLOW: it has a valid uuid + content
 * type and is not deleted, but its `content` is a decrypted object rather than
 * an encrypted string — so `checkRemotePayloadAllowed` rejects it.
 */
const disallowedServerItem = (uuid: string): ServerItemResponse =>
  ({
    uuid,
    content_type: 'Note',
    content: { title: 'should have been encrypted' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at_timestamp: 1,
    updated_at_timestamp: 1,
  }) as unknown as ServerItemResponse

describe('ServerSyncResponse — filtered-out conflict server_item', () => {
  it('routes a disallowed conflict server_item to InvalidServerItem and drops the typed conflict', () => {
    const response = new ServerSyncResponse(
      successResponse({
        conflicts: [
          {
            type: ConflictType.ConflictingData,
            server_item: disallowedServerItem('conflict-1'),
          },
        ],
      }),
    )

    // The half-formed ConflictingData entry must NOT be present (it would carry an
    // undefined server_item and crash the delta).
    expect(response.conflicts[ConflictType.ConflictingData]).toBeUndefined()

    // The disallowed payload is instead represented as an InvalidServerItem.
    const invalid = response.conflicts[ConflictType.InvalidServerItem]
    expect(invalid).toHaveLength(1)
    expect(invalid?.[0].server_item?.uuid).toBe('conflict-1')

    // Crucially: no typed conflict anywhere carries an undefined server_item.
    for (const [type, entries] of Object.entries(response.conflicts)) {
      if (type === ConflictType.InvalidServerItem) {
        continue
      }
      for (const entry of entries ?? []) {
        expect(entry.server_item).toBeDefined()
      }
    }
  })

  it('keeps a well-formed conflict whose server_item passes filtering', () => {
    const encryptedServerItem = {
      uuid: 'conflict-ok',
      content_type: 'Note',
      content: '003:abc:def', // encrypted string → allowed
      enc_item_key: 'key',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_at_timestamp: 1,
      updated_at_timestamp: 1,
    } as unknown as ServerItemResponse

    const response = new ServerSyncResponse(
      successResponse({
        conflicts: [
          {
            type: ConflictType.ConflictingData,
            server_item: encryptedServerItem,
          },
        ],
      }),
    )

    const conflicting = response.conflicts[ConflictType.ConflictingData]
    expect(conflicting).toHaveLength(1)
    expect(conflicting?.[0].server_item?.uuid).toBe('conflict-ok')
    expect(response.conflicts[ConflictType.InvalidServerItem]).toHaveLength(0)
  })

  it('does not throw and emits no conflicts for an empty success response', () => {
    expect(() => new ServerSyncResponse(successResponse({}))).not.toThrow()
    const response = new ServerSyncResponse(successResponse({}))
    expect(response.conflicts[ConflictType.InvalidServerItem]).toHaveLength(0)
  })
})
