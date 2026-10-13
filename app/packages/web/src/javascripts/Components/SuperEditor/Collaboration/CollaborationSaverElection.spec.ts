/** @jest-environment node */
jest.mock('@standardnotes/snjs', () => ({ SyncQueueStrategy: { ForceSpawnNew: 2 } }))
jest.mock('./CollaborationSaveFence', () => ({
  claimCollaborationSaveFence: jest
    .fn()
    .mockImplementation(async () => ({ room: 'room', token: 'token', expiresAt: Date.now() + 30_000 })),
  renewCollaborationSaveFence: jest
    .fn()
    .mockImplementation(async () => ({ room: 'room', token: 'token', expiresAt: Date.now() + 30_000 })),
  releaseCollaborationSaveFence: jest.fn().mockResolvedValue(undefined),
}))
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { WebApplication } from '@/Application/WebApplication'
import type { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { CollaborativeDocumentRegistry, documentStateOf } from './CollaborativeDocumentRegistry'
import { createCollaborationRevisionStamp, revisionStampCoversDocumentState } from './CollaborationRevisionStamp'
import {
  claimCollaborationSaveFence,
  renewCollaborationSaveFence,
  releaseCollaborationSaveFence,
} from './CollaborationSaveFence'
import {
  CollaborationSaverRegistry,
  electCollaborationSaver,
  installCollaborationSaver,
} from './CollaborationSaverElection'

const participant = (userUuid: string, leaseId: string, canSaveOverSocket = true) => ({
  userUuid,
  leaseId,
  canSaveOverSocket,
  canonicalReady: true,
})

describe('collaboration saver election', () => {
  it('chooses a stable account/device order and excludes unhealthy or unknown clients', () => {
    const peers = [participant('b', '1'), participant('a', '2'), participant('a', '1'), participant('', '0')]
    expect(electCollaborationSaver(peers)?.leaseId).toBe('1')
    expect(electCollaborationSaver(peers.reverse())?.userUuid).toBe('a')
    expect(electCollaborationSaver([participant('a', '1', false)])).toBeUndefined()
    expect(electCollaborationSaver([{ ...participant('a', '1'), canonicalReady: false }])).toBeUndefined()
  })
  it('checks reverse coverage including deletions, not just insertion clocks', () => {
    const doc = new Y.Doc()
    const text = doc.getText('text')
    text.insert(0, 'abc')
    const oldStamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'abc', 0)!
    text.delete(0, 1)
    expect(revisionStampCoversDocumentState(oldStamp, documentStateOf(doc))).toBe(false)
    const newStamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'bc', 0)!
    expect(revisionStampCoversDocumentState(newStamp, documentStateOf(doc))).toBe(true)
    doc.destroy()
  })
  describe('live lifecycle', () => {
    let doc: Y.Doc
    let awareness: Awareness
    let application: WebApplication
    let provider: EncryptedYjsProvider
    let stop: () => void
    let stopDocument: () => void
    let changeLane: () => void
    let lane: { usable: boolean }
    let dirty: boolean
    let content: unknown
    beforeEach(() => {
      jest.useFakeTimers()
      doc = new Y.Doc()
      awareness = new Awareness(doc)
      lane = { usable: true }
      dirty = false
      content = {}
      jest
        .mocked(claimCollaborationSaveFence)
        .mockImplementation(async () => ({ room: 'room', token: 'token', expiresAt: Date.now() + 30_000 }))
      jest
        .mocked(renewCollaborationSaveFence)
        .mockImplementation(async () => ({ room: 'room', token: 'token', expiresAt: Date.now() + 30_000 }))
      jest.mocked(releaseCollaborationSaveFence).mockResolvedValue(undefined)
      application = {
        get syncSaveLane() {
          return lane
        },
        requireSocketSavesForItem: jest.fn().mockReturnValue(true),
        releaseSocketSavesForItem: jest.fn(),
        setCollaborationSaver: jest.fn(),
        subscribeSyncSaveLane: (listener: () => void) => {
          changeLane = listener
          return jest.fn()
        },
        items: { findItem: () => ({ dirty, content }) },
        sync: {
          sync: jest.fn().mockResolvedValue({ downloadOnly: true, successful: true }),
          getSyncStatus: () => ({}),
        },
      } as unknown as WebApplication
      provider = {
        awareness,
        isCanonicalReady: () => true,
        isRoomJoined: () => true,
        onCanonicalReadyChange: () => jest.fn(),
        flush: jest.fn().mockResolvedValue(undefined),
      } as unknown as EncryptedYjsProvider
      stopDocument = CollaborativeDocumentRegistry.set('room', {
        epoch: 'epoch',
        state: () => documentStateOf(doc),
        subscribe: () => jest.fn(),
      })
      stop = installCollaborationSaver(application, 'room', 'a', 'local', provider, 'epoch')
    })
    afterEach(() => {
      stop()
      stopDocument()
      awareness.destroy()
      doc.destroy()
      jest.useRealTimers()
    })
    it('starts read-only and refreshes the server base before becoming saver', async () => {
      expect(CollaborationSaverRegistry.get('room')?.paused).toBe(true)
      await jest.advanceTimersByTimeAsync(2_000)
      expect(provider.flush).toHaveBeenCalled()
      expect(application.sync.sync).toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, paused: false })
    })
    it('a lost save lane immediately stops the sole saver, then recovers', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      lane = { usable: false }
      changeLane()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      lane = { usable: true }
      changeLane()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(true)
    })
    it('withdraws a saver whose server durability never advances', async () => {
      await jest.advanceTimersByTimeAsync(17_000)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      expect(awareness.getLocalState()?.saver.canSaveOverSocket).toBe(false)
    })
    it('waits for the elected peer to hold its server fence before enabling edits', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      awareness.getStates().set(999, { saver: { ...participant('0', 'peer'), saving: false } })
      awareness.emit('change', [])
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      expect(releaseCollaborationSaveFence).toHaveBeenCalled()
      awareness.getStates().set(999, { saver: { ...participant('0', 'peer'), saving: true } })
      awareness.emit('change', [])
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({
        isSaver: false,
        paused: false,
        saverLeaseId: 'peer',
      })
    })
    it('losing the authoritative renewal immediately stops saving and editing', async () => {
      doc.getText('text').insert(0, 'saved')
      const stamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'saved', Date.now())!
      content = {
        text: 'saved',
        appData: {
          'org.standardnotes.sn': {
            collaborationRevision: stamp,
            client_updated_at: new Date(stamp.at).toISOString(),
          },
        },
      }
      jest.mocked(renewCollaborationSaveFence).mockRejectedValueOnce(new Error('lease lost'))
      await jest.advanceTimersByTimeAsync(24_000)
      expect(renewCollaborationSaveFence).toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      expect(awareness.getLocalState()?.saver.saving).toBe(false)
    })
    it('renews its claim while a long pull-only catchup is still preparing', async () => {
      let complete: () => void = () => undefined
      ;(application.sync.sync as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = () => resolve({ downloadOnly: true, successful: true })
          }),
      )
      await jest.advanceTimersByTimeAsync(34_000)
      expect(renewCollaborationSaveFence).toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      complete()
      for (let index = 0; index < 10; index++) {
        await Promise.resolve()
      }
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, paused: false })
    })
    it('a last participant note switch waits for remote durability before releasing its saver proof', async () => {
      doc.getText('text').insert(0, 'outgoing edit')
      await jest.advanceTimersByTimeAsync(2_000)
      dirty = true
      ;(application.sync.sync as jest.Mock).mockImplementationOnce(async () => {
        const stamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'outgoing edit', Date.now())!
        content = {
          text: 'outgoing edit',
          appData: {
            'org.standardnotes.sn': {
              collaborationRevision: stamp,
              client_updated_at: new Date(stamp.at).toISOString(),
            },
          },
        }
        dirty = false
      })
      await CollaborationSaverRegistry.awaitDurable('room')
      expect(CollaborationSaverRegistry.hasUndurableState('room')).toBe(false)
      expect(releaseCollaborationSaveFence).not.toHaveBeenCalled()
      stop()
      stop = () => undefined
      for (let index = 0; index < 10; index++) {
        await Promise.resolve()
      }
      expect(releaseCollaborationSaveFence).toHaveBeenCalled()
      expect(application.releaseSocketSavesForItem).toHaveBeenCalledWith('room', true)
      expect(CollaborationSaverRegistry.get('room')).toBeUndefined()
    })
    it('a failed detached drain preserves its dirty transport marker and releases all room state', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      dirty = true
      ;(application.sync.sync as jest.Mock).mockRejectedValueOnce(new Error('socket failed'))
      stop()
      stop = () => undefined
      for (let index = 0; index < 10; index++) {
        await Promise.resolve()
      }
      expect(CollaborationSaverRegistry.get('room')).toBeUndefined()
      expect(application.releaseSocketSavesForItem).toHaveBeenCalledWith('room', false)
      expect(releaseCollaborationSaveFence).toHaveBeenCalled()
    })
    it('reacquires after a failed lane with a dirty body proved to belong to the retained document', async () => {
      doc.getText('text').insert(0, 'retained')
      const stamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'retained', Date.now())!
      content = {
        text: 'retained',
        appData: {
          'org.standardnotes.sn': {
            collaborationRevision: stamp,
            client_updated_at: new Date(stamp.at).toISOString(),
          },
        },
      }
      await jest.advanceTimersByTimeAsync(2_000)
      lane = { usable: false }
      changeLane()
      dirty = true
      lane = { usable: true }
      changeLane()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, paused: false })
    })
    it('teardown cancels a delayed takeover and preserves the dirty socket constraint', async () => {
      dirty = true
      stop()
      stop = () => undefined
      await jest.advanceTimersByTimeAsync(40_000)
      expect(CollaborationSaverRegistry.get('room')).toBeUndefined()
      expect(application.sync.sync).not.toHaveBeenCalled()
      expect(application.releaseSocketSavesForItem).toHaveBeenCalledWith('room', false)
    })
  })
})
