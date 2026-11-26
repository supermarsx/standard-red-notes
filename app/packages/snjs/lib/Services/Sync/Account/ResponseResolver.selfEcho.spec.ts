import { ContentType } from '@standardnotes/domain-core'
import {
  DecryptedPayload,
  DeletedPayload,
  FillItemContent,
  ImmutablePayloadCollection,
  NoteContent,
  PayloadTimestampDefaults,
  ServerSyncPushContextualPayload,
  ServerSyncSavedContextualPayload,
  isDecryptedPayload,
} from '@standardnotes/models'
import { ServerSyncResponseResolver } from './ResponseResolver'

it('rebases an acknowledged save without replacing a newer in-flight local edit or manufacturing a conflict copy', () => {
  const local = new DecryptedPayload<NoteContent>({
    uuid: 'own-note',
    content_type: ContentType.TYPES.Note,
    content: FillItemContent<NoteContent>({
      title: 'Own note',
      text: 'newer local edit',
      appData: { 'org.standardnotes.sn': { client_updated_at: new Date(Date.now() - 60_000).toISOString() } },
    }),
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 1000000,
    dirty: true,
    dirtyIndex: 10,
    globalDirtyIndexAtLastSync: 5,
  })
  const echoed = local.copy({
    content: FillItemContent<NoteContent>({ title: 'Own note', text: 'previous uploaded edit' }),
    updated_at_timestamp: 2000000,
    dirty: false,
  })
  const ack = {
    uuid: local.uuid,
    content_type: local.content_type,
    deleted: false,
    updated_at_timestamp: 2000000,
    updated_at: new Date(2000),
  } as ServerSyncSavedContextualPayload
  const outgoing = { uuid: local.uuid, content_type: local.content_type } as ServerSyncPushContextualPayload
  const deltas = new ServerSyncResponseResolver(
    { retrievedPayloads: [echoed], savedPayloads: [ack], conflicts: {} },
    ImmutablePayloadCollection.WithPayloads([local]),
    [outgoing],
    {},
  ).result()
  const emitted = deltas.flatMap((delta) => delta.emits)
  expect(emitted).toHaveLength(1)
  expect(emitted[0].uuid).toBe(local.uuid)
  expect(emitted[0].dirty).toBe(true)
  expect(emitted[0].updated_at_timestamp).toBe(2000000)
  expect(isDecryptedPayload(emitted[0]) && emitted[0].content.text).toBe('newer local edit')
})

it('does not let an older save acknowledgement overwrite a genuinely newer retrieved peer revision', () => {
  const local = new DecryptedPayload<NoteContent>({
    uuid: 'own-note',
    content_type: ContentType.TYPES.Note,
    content: FillItemContent<NoteContent>({
      title: 'Own note',
      text: 'local draft',
      appData: { 'org.standardnotes.sn': { client_updated_at: new Date(Date.now() - 60_000).toISOString() } },
    }),
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 1000000,
    dirty: true,
  })
  const peer = local.copy({
    content: FillItemContent<NoteContent>({ title: 'Own note', text: 'newer peer revision' }),
    updated_at_timestamp: 3000000,
    dirty: false,
  })
  const ack = {
    uuid: local.uuid,
    content_type: local.content_type,
    deleted: false,
    updated_at_timestamp: 2000000,
    updated_at: new Date(2000),
  } as ServerSyncSavedContextualPayload
  const resolver = new ServerSyncResponseResolver(
    { retrievedPayloads: [peer], savedPayloads: [ack], conflicts: {} },
    ImmutablePayloadCollection.WithPayloads([local]),
    [{ uuid: local.uuid }] as ServerSyncPushContextualPayload[],
    {},
  )
  const applied = new Map(
    resolver
      .result()
      .flatMap((delta) => delta.emits)
      .map((payload) => [payload.uuid, payload]),
  )
  const original = applied.get(local.uuid)!
  expect(isDecryptedPayload(original) && original.content.text).toBe('newer peer revision')
  expect(original.updated_at_timestamp).toBe(3000000)
  const copies = [...applied.values()].filter((payload) => payload.uuid !== local.uuid)
  expect(copies).toHaveLength(1)
  expect(isDecryptedPayload(copies[0]) && copies[0].content.text).toBe('local draft')
})

it('ignores a late acknowledgement behind the current note rather than clearing its pending work or moving its server clock backwards', () => {
  const local = new DecryptedPayload<NoteContent>({
    uuid: 'own-note',
    content_type: ContentType.TYPES.Note,
    content: FillItemContent<NoteContent>({ title: 'Own note', text: 'latest pending work' }),
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 3000000,
    dirty: true,
  })
  const ack = {
    uuid: local.uuid,
    content_type: local.content_type,
    deleted: false,
    updated_at_timestamp: 2000000,
    updated_at: new Date(2000),
  } as ServerSyncSavedContextualPayload
  const result = new ServerSyncResponseResolver(
    { retrievedPayloads: [], savedPayloads: [ack], conflicts: {} },
    ImmutablePayloadCollection.WithPayloads([local]),
    [{ uuid: local.uuid }] as ServerSyncPushContextualPayload[],
    {},
  ).result()
  expect(result.flatMap((delta) => delta.emits)).toHaveLength(0)
  expect(local.dirty).toBe(true)
  expect(local.updated_at_timestamp).toBe(3000000)
})

it('does not resurrect a newer remote deletion when an older own save is acknowledged in the same response', () => {
  const local = new DecryptedPayload<NoteContent>({
    uuid: 'own-note',
    content_type: ContentType.TYPES.Note,
    content: FillItemContent<NoteContent>({ title: 'Own note', text: 'recoverable local draft' }),
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 1000000,
    dirty: true,
  })
  const deleted = new DeletedPayload({
    uuid: local.uuid,
    content_type: local.content_type,
    ...PayloadTimestampDefaults(),
    updated_at_timestamp: 3000000,
  })
  const ack = {
    uuid: local.uuid,
    content_type: local.content_type,
    deleted: false,
    updated_at_timestamp: 2000000,
    updated_at: new Date(2000),
  } as ServerSyncSavedContextualPayload
  const result = new ServerSyncResponseResolver(
    { retrievedPayloads: [deleted], savedPayloads: [ack], conflicts: {} },
    ImmutablePayloadCollection.WithPayloads([local]),
    [{ uuid: local.uuid }] as ServerSyncPushContextualPayload[],
    {},
  ).result()
  const applied = new Map(result.flatMap((delta) => delta.emits).map((payload) => [payload.uuid, payload]))
  expect(applied.get(local.uuid)?.deleted).toBe(true)
  expect(applied.get(local.uuid)?.updated_at_timestamp).toBe(3000000)
  expect(
    [...applied.values()].some(
      (payload) =>
        payload.uuid !== local.uuid &&
        isDecryptedPayload(payload) &&
        payload.content.text === 'recoverable local draft',
    ),
  ).toBe(true)
})
