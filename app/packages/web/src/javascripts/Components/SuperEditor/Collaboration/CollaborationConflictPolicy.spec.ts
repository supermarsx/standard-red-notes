import * as Y from 'yjs'
import { ContentType } from '@standardnotes/domain-core'
import {
  ConflictDelta,
  ConflictStrategy,
  DecryptedPayload,
  FillItemContent,
  ImmutablePayloadCollection,
  PayloadTimestampDefaults,
  type NoteContent,
} from '@standardnotes/models'
import { UuidGenerator } from '@standardnotes/utils'
import { collaborationConflictPolicy } from './CollaborationConflictPolicy'
import { CollaborationSaverRegistry } from './CollaborationSaverElection'
import { CollaborativeDocumentRegistry, documentStateOf } from './CollaborativeDocumentRegistry'
import { createCollaborationRevisionStamp, type CollaborationRevisionStamp } from './CollaborationRevisionStamp'

UuidGenerator.SetGenerator(() => String(Math.random()))
const room = 'note-room'
const content = (text: string, stamp: CollaborationRevisionStamp, title = 'Shared note') =>
  FillItemContent<NoteContent>({
    text,
    title,
    appData: {
      'org.standardnotes.sn': { collaborationRevision: stamp, client_updated_at: new Date(stamp.at).toISOString() },
    },
  })
const payload = (text: string, stamp: CollaborationRevisionStamp, dirty: boolean, timestamp: number, title?: string) =>
  new DecryptedPayload<NoteContent>({
    uuid: room,
    content_type: ContentType.TYPES.Note,
    content: content(text, stamp, title),
    ...PayloadTimestampDefaults(),
    dirty,
    updated_at_timestamp: timestamp,
    shared_vault_uuid: 'vault',
    key_system_identifier: 'vault-key',
  })

describe('covered collaboration dirty handoff', () => {
  let doc: Y.Doc
  let stop: () => void
  let oldStamp: CollaborationRevisionStamp
  let currentStamp: CollaborationRevisionStamp
  beforeEach(() => {
    doc = new Y.Doc()
    doc.getText('body').insert(0, 'a')
    oldStamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'a', Date.now())!
    doc.getText('body').insert(1, 'b')
    currentStamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'ab', Date.now())!
    stop = CollaborativeDocumentRegistry.set(room, {
      epoch: 'epoch',
      state: () => documentStateOf(doc),
      subscribe: () => () => undefined,
    })
    CollaborationSaverRegistry.set(room, {
      active: true,
      isSaver: false,
      paused: false,
      leaseId: 'local',
      saverLeaseId: 'peer',
      saveRequest: 0,
    })
  })
  afterEach(() => {
    stop()
    CollaborationSaverRegistry.clear(room, 'local')
    doc.destroy()
  })
  it('cleans the former saver from a peer acknowledgement that covers all retained edits', () => {
    const base = payload('a', oldStamp, true, 1)
    const incoming = payload('ab', currentStamp, false, 2)
    expect(collaborationConflictPolicy(base, incoming)).toBe(ConflictStrategy.KeepApply)
    const delta = new ConflictDelta(
      ImmutablePayloadCollection.WithPayloads([base]),
      base,
      incoming,
      {},
      collaborationConflictPolicy,
    ).result()
    expect(delta.emits).toHaveLength(1)
    expect(delta.emits[0]).toMatchObject({ dirty: false, updated_at_timestamp: 2, content: { text: 'ab' } })
  })
  it('rebases a merged live body without a duplicate while its full state still needs saving', () => {
    const base = payload('ab', currentStamp, true, 1)
    const incoming = payload('a', oldStamp, false, 2)
    expect(collaborationConflictPolicy(base, incoming)).toBe(ConflictStrategy.KeepBase)
    const delta = new ConflictDelta(
      ImmutablePayloadCollection.WithPayloads([base]),
      base,
      incoming,
      {},
      collaborationConflictPolicy,
    ).result()
    expect(delta.emits).toHaveLength(1)
    expect(delta.emits[0]).toMatchObject({ dirty: true, updated_at_timestamp: 2, content: { text: 'ab' } })
  })
  it('retains ordinary duplicate behavior for an unrelated title divergence', () => {
    const base = payload('a', oldStamp, true, 1, 'Local title')
    const incoming = payload('ab', currentStamp, false, 2, 'Peer title')
    expect(collaborationConflictPolicy(base, incoming)).toBeUndefined()
    const delta = new ConflictDelta(
      ImmutablePayloadCollection.WithPayloads([base]),
      base,
      incoming,
      {},
      collaborationConflictPolicy,
    ).result()
    expect(delta.emits.length).toBeGreaterThan(1)
  })
  it('never overrides a vault mismatch, an unknown epoch, or an unseen remote operation', () => {
    const base = payload('a', oldStamp, true, 1)
    const incoming = payload('ab', currentStamp, false, 2)
    const differentVault = incoming.copy({ shared_vault_uuid: 'other-vault' })
    expect(collaborationConflictPolicy(base, differentVault)).toBeUndefined()
    const rotatedKeySystem = incoming.copy({ key_system_identifier: 'rotated-key-system' })
    expect(collaborationConflictPolicy(base, rotatedKeySystem)).toBeUndefined()
    const other = new Y.Doc()
    other.getText('body').insert(0, 'unknown')
    const unseen = createCollaborationRevisionStamp('epoch', documentStateOf(other), 'unknown', Date.now())!
    expect(collaborationConflictPolicy(base, payload('unknown', unseen, false, 3))).toBeUndefined()
    other.destroy()
    stop()
    stop = CollaborativeDocumentRegistry.set(room, {
      epoch: 'other-epoch',
      state: () => documentStateOf(doc),
      subscribe: () => () => undefined,
    })
    expect(collaborationConflictPolicy(base, incoming)).toBeUndefined()
  })
})
