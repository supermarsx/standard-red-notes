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

  it.each([
    ['older local copy', 'a', 'ab', false],
    ['older retrieved copy', 'ab', 'a', true],
  ] as const)(
    'resolves an %s before the collaboration provider mounts without a duplicate',
    (_, local, remote, dirty) => {
      stop()
      CollaborationSaverRegistry.clear(room, 'local')
      const base = payload(local, local === 'a' ? oldStamp : currentStamp, true, 1)
      const incoming = payload(remote, remote === 'a' ? oldStamp : currentStamp, false, 2)
      const delta = new ConflictDelta(
        ImmutablePayloadCollection.WithPayloads([base]),
        base,
        incoming,
        {},
        collaborationConflictPolicy,
      ).result()
      expect(delta.emits).toHaveLength(1)
      expect(delta.emits[0]).toMatchObject({ dirty, updated_at_timestamp: 2, content: { text: 'ab' } })
    },
  )

  it('keeps a covered retained body dirty through reconnect without duplicating an older peer revision', () => {
    stop()
    stop = CollaborativeDocumentRegistry.set(room, {
      epoch: 'epoch',
      state: () => undefined,
      retainedState: () => documentStateOf(doc),
      subscribe: () => () => undefined,
    })
    const base = payload('ab', currentStamp, true, 1)
    const incoming = payload('a', oldStamp, false, 2)
    const delta = new ConflictDelta(
      ImmutablePayloadCollection.WithPayloads([base]),
      base,
      incoming,
      {},
      collaborationConflictPolicy,
    ).result()
    expect(delta.emits).toHaveLength(1)
    expect(delta.emits[0]).toMatchObject({ dirty: true, content: { text: 'ab' } })
  })

  it('does not acknowledge retained offline edits merely because a reconnect brought back a covering revision', () => {
    stop()
    stop = CollaborativeDocumentRegistry.set(room, {
      epoch: 'epoch',
      state: () => undefined,
      retainedState: () => documentStateOf(doc),
      subscribe: () => () => undefined,
    })
    expect(collaborationConflictPolicy(payload('a', oldStamp, true, 1), payload('ab', currentStamp, false, 2))).toBe(
      ConflictStrategy.KeepBase,
    )
  })

  it('preserves independent offline insertions and deletions before a provider mounts', () => {
    stop()
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
    doc.getText('body').insert(2, 'c')
    remote.getText('body').delete(1, 1)
    const localStamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'abc', Date.now())!
    const remoteStamp = createCollaborationRevisionStamp('epoch', documentStateOf(remote), 'a', Date.now())!
    const base = payload('abc', localStamp, true, 1)
    const incoming = payload('a', remoteStamp, false, 2)
    const delta = new ConflictDelta(
      ImmutablePayloadCollection.WithPayloads([base]),
      base,
      incoming,
      {},
      collaborationConflictPolicy,
    ).result()
    expect(collaborationConflictPolicy(base, incoming)).toBeUndefined()
    expect(delta.emits).toHaveLength(2)
    expect(delta.emits.map((entry) => (entry.content as NoteContent).text).sort()).toEqual(['a', 'abc'])
    remote.destroy()
  })

  it.each([false, true])('preserves a deletion-only progression before mount, locally deleted=%s', (locallyDeleted) => {
    stop()
    doc.getText('body').delete(1, 1)
    const deletedStamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'a', Date.now())!
    const base = locallyDeleted ? payload('a', deletedStamp, true, 1) : payload('ab', currentStamp, true, 1)
    const incoming = locallyDeleted ? payload('ab', currentStamp, false, 2) : payload('a', deletedStamp, false, 2)
    const delta = new ConflictDelta(
      ImmutablePayloadCollection.WithPayloads([base]),
      base,
      incoming,
      {},
      collaborationConflictPolicy,
    ).result()
    expect(delta.emits).toHaveLength(1)
    expect(delta.emits[0]).toMatchObject({ dirty: locallyDeleted, content: { text: 'a' } })
  })

  it('does not mistake a newly mounted unestablished document for a retained reconnect', () => {
    stop()
    stop = CollaborativeDocumentRegistry.set(room, {
      epoch: 'epoch',
      state: () => undefined,
      subscribe: () => () => undefined,
    })
    expect(
      collaborationConflictPolicy(payload('a', oldStamp, true, 1), payload('ab', currentStamp, false, 2)),
    ).toBeUndefined()
  })

  it.each(['title', 'epoch', 'body', 'restored-date', 'vault', 'key-system'])(
    'retains ordinary conflicts for %s differences before a provider mounts',
    (change) => {
      stop()
      const base = payload('a', oldStamp, true, 1)
      let incoming = payload('ab', currentStamp, false, 2)
      if (change === 'title') {
        incoming = payload('ab', currentStamp, false, 2, 'New title')
      } else if (change === 'vault') {
        incoming = incoming.copy({ shared_vault_uuid: 'other-vault' })
      } else if (change === 'key-system') {
        incoming = incoming.copy({ key_system_identifier: 'other-key-system' })
      } else {
        const changedContent = JSON.parse(JSON.stringify(incoming.content)) as NoteContent
        if (change === 'body') {
          changedContent.text = 'edited without updating the stamp'
        } else {
          const domain = changedContent.appData!['org.standardnotes.sn'] as unknown as Record<string, unknown>
          if (change === 'epoch') {
            domain.collaborationRevision = { ...currentStamp, epoch: 'different-epoch' }
          } else {
            domain.client_updated_at = new Date(currentStamp.at + 60_000).toISOString()
          }
        }
        incoming = incoming.copy({ content: changedContent })
      }
      expect(collaborationConflictPolicy(base, incoming)).toBeUndefined()
      const delta = new ConflictDelta(
        ImmutablePayloadCollection.WithPayloads([base]),
        base,
        incoming,
        {},
        collaborationConflictPolicy,
      ).result()
      expect(delta.emits.length).toBeGreaterThan(1)
    },
  )
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
