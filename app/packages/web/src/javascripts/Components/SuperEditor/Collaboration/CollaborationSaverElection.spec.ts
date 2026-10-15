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
  SAVER_INITIALIZATION_TIMEOUT_MS,
  SAVER_PEER_PREPARATION_GRACE_MS,
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
  it('retains a healthy active saver ahead of a newly eligible or older participant', () => {
    const active = { ...participant('z', 'active'), saving: true }
    const newcomer = participant('a', 'newcomer')
    expect(electCollaborationSaver([newcomer, active])).toBe(active)
    expect(electCollaborationSaver([active, newcomer])).toBe(active)
    expect(electCollaborationSaver([{ ...active, canSaveOverSocket: false }, newcomer])).toBe(newcomer)
    expect(electCollaborationSaver([{ ...active, canonicalReady: false }, newcomer])).toBe(newcomer)
    const otherActive = { ...newcomer, saving: true }
    expect(electCollaborationSaver([active, otherActive])).toBe(otherActive)
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
    let activeIdentity: { leaseId: string; roomEpoch: string } | undefined
    let changeIdentity: () => void
    beforeEach(() => {
      jest.useFakeTimers()
      doc = new Y.Doc()
      awareness = new Awareness(doc)
      lane = { usable: true }
      dirty = false
      content = {}
      activeIdentity = { leaseId: 'local', roomEpoch: 'epoch' }
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
        getActiveEditorLeaseIdentity: () => activeIdentity,
        onActiveEditorLeaseChange: (listener: () => void) => {
          changeIdentity = listener
          return jest.fn()
        },
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
    it('retries a transient claim failure promptly without waiting five seconds', async () => {
      jest.mocked(claimCollaborationSaveFence).mockRejectedValueOnce(new Error('temporary outage'))
      await jest.advanceTimersByTimeAsync(500)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ paused: true, isSaver: false })
      await jest.advanceTimersByTimeAsync(1_000)
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(2)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ paused: false, isSaver: true })
    })
    it('does not wait forever for an eligible peer which never obtains a save proof', async () => {
      awareness.getStates().set(999, { saver: participant('0', 'stuck-peer') })
      awareness.emit('change', [])
      await jest.advanceTimersByTimeAsync(SAVER_PEER_PREPARATION_GRACE_MS - 100)
      expect(claimCollaborationSaveFence).not.toHaveBeenCalled()
      // Awareness refreshes from an old client do not restart the grace period.
      awareness.emit('change', [])
      await jest.advanceTimersByTimeAsync(500)
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(1)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ paused: false, isSaver: true })
    })
    it('keeps editing disabled when a replacement candidate is refused by the server lock', async () => {
      awareness.getStates().set(999, { saver: participant('0', 'stuck-peer') })
      awareness.emit('change', [])
      jest.mocked(claimCollaborationSaveFence).mockRejectedValue(new Error('another editor holds the proof'))
      await jest.advanceTimersByTimeAsync(7_000)
      expect(claimCollaborationSaveFence).toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ paused: true, isSaver: false })
      expect(application.sync.sync).not.toHaveBeenCalled()
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
      await jest.advanceTimersByTimeAsync(16_000)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      expect(awareness.getLocalState()?.saver.canSaveOverSocket).toBe(false)
    })
    it('reclaims a proof promptly when the lane recovers instead of waiting out the old quarantine', async () => {
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
      jest.mocked(renewCollaborationSaveFence).mockRejectedValueOnce(new Error('temporary outage'))
      for (let tick = 0; tick < 30 && !jest.mocked(renewCollaborationSaveFence).mock.calls.length; tick++) {
        await jest.advanceTimersByTimeAsync(1_000)
      }
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ paused: true, isSaver: false })
      lane = { usable: false }
      changeLane()
      lane = { usable: true }
      changeLane()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ paused: false, isSaver: true })
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(2)
      expect(application.sync.sync).toHaveBeenCalledTimes(2)
    })
    it('waits for the elected peer to hold its server fence before enabling edits', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      lane = { usable: false }
      changeLane()
      awareness.getStates().set(999, { saver: { ...participant('0', 'peer'), saving: false } })
      awareness.emit('change', [])
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      await Promise.resolve()
      expect(releaseCollaborationSaveFence).toHaveBeenCalled()
      awareness.getStates().set(999, { saver: { ...participant('0', 'peer'), saving: true } })
      awareness.emit('change', [])
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({
        isSaver: false,
        paused: false,
        saverLeaseId: 'peer',
      })
    })
    it('does not interrupt a healthy saver when an earlier peer changes eligibility every five seconds', async () => {
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
      await jest.advanceTimersByTimeAsync(2_000)
      const pauses: boolean[] = []
      const unsubscribe = CollaborationSaverRegistry.subscribe('room', () => {
        pauses.push(CollaborationSaverRegistry.get('room')?.paused === true)
      })
      try {
        for (let tick = 0; tick < 8; tick++) {
          awareness.getStates().set(999, { saver: participant('0', 'peer', tick % 2 === 0) })
          awareness.emit('change', [])
          await jest.advanceTimersByTimeAsync(5_000)
        }
        expect(pauses).not.toContain(true)
        expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, paused: false })
        expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(1)
        expect(renewCollaborationSaveFence).toHaveBeenCalled()
        expect(releaseCollaborationSaveFence).not.toHaveBeenCalled()
      } finally {
        unsubscribe()
      }
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
      await jest.advanceTimersByTimeAsync(21_000)
      expect(renewCollaborationSaveFence).toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      expect(awareness.getLocalState()?.saver.saving).toBe(false)
    })
    it('renews its claim while a long pull-only catchup is still preparing', async () => {
      jest.mocked(claimCollaborationSaveFence).mockResolvedValueOnce({
        room: 'room',
        token: 'token',
        expiresAt: Date.now() + 8_000,
      })
      let complete: () => void = () => undefined
      ;(application.sync.sync as jest.Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = () => resolve({ downloadOnly: true, successful: true })
          }),
      )
      await jest.advanceTimersByTimeAsync(12_000)
      expect(renewCollaborationSaveFence).toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      complete()
      for (let index = 0; index < 10; index++) {
        await Promise.resolve()
      }
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, paused: false })
    })
    it('rebinds proof claims and awareness to the latest active gateway lease after reactivation', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(true)
      activeIdentity = undefined
      changeIdentity()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      activeIdentity = { leaseId: 'reactivated', roomEpoch: 'epoch' }
      changeIdentity()
      expect(awareness.getLocalState()?.saver.leaseId).toBe('reactivated')
      await jest.advanceTimersByTimeAsync(2_000)
      expect(claimCollaborationSaveFence).toHaveBeenLastCalledWith(application, {
        room: 'room',
        roomEpoch: 'epoch',
        leaseId: 'reactivated',
      })
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ leaseId: 'reactivated', isSaver: true })
      expect(releaseCollaborationSaveFence).toHaveBeenCalledWith(
        application,
        { room: 'room', roomEpoch: 'epoch', leaseId: 'local' },
        expect.any(Object),
      )
    })
    it('releases a timed-out initialization proof and lets a healthy peer take over without accepting late completion', async () => {
      doc.getText('text').insert(0, 'pending canonical work')
      let complete: (value: unknown) => void = () => undefined
      ;(application.sync.sync as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
      await jest.advanceTimersByTimeAsync(2_000 + SAVER_INITIALIZATION_TIMEOUT_MS)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: false, paused: true })
      expect(awareness.getLocalState()?.saver.canSaveOverSocket).toBe(false)
      expect(releaseCollaborationSaveFence).toHaveBeenCalled()
      awareness.getStates().set(999, { saver: { ...participant('b', 'peer'), saving: true } })
      awareness.emit('change', [])
      const stamp = createCollaborationRevisionStamp('epoch', documentStateOf(doc), 'peer durable body', Date.now())!
      content = {
        text: 'peer durable body',
        appData: {
          'org.standardnotes.sn': {
            collaborationRevision: stamp,
            client_updated_at: new Date(stamp.at).toISOString(),
          },
        },
      }
      await jest.advanceTimersByTimeAsync(1_000)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({
        saverLeaseId: 'peer',
        isSaver: false,
        paused: false,
      })
      complete({ downloadOnly: true, successful: true })
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ saverLeaseId: 'peer', isSaver: false })
    })
    it('ignores an old claim completing after its lease has been replaced', async () => {
      let complete: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      jest
        .mocked(claimCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
      await jest.advanceTimersByTimeAsync(2_000)
      activeIdentity = { leaseId: 'replacement', roomEpoch: 'epoch' }
      changeIdentity()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ leaseId: 'replacement', isSaver: true })
      complete({ room: 'room', token: 'old-claim', expiresAt: Date.now() + 30_000 })
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
      expect(releaseCollaborationSaveFence).toHaveBeenCalledWith(
        application,
        { room: 'room', roomEpoch: 'epoch', leaseId: 'local' },
        expect.objectContaining({ token: 'old-claim' }),
      )
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ leaseId: 'replacement', isSaver: true })
    })
    it('keeps a timed-out queued pull withdrawn across retry windows until that exact coroutine settles', async () => {
      let complete: (value: unknown) => void = () => undefined
      ;(application.sync.sync as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
      await jest.advanceTimersByTimeAsync(2_000 + SAVER_INITIALIZATION_TIMEOUT_MS)
      const claims = jest.mocked(claimCollaborationSaveFence).mock.calls.length
      const pulls = (application.sync.sync as jest.Mock).mock.calls.length
      awareness.getStates().set(999, { saver: { ...participant('b', 'peer'), saving: true } })
      awareness.emit('change', [])
      await jest.advanceTimersByTimeAsync(60_000)
      expect(awareness.getLocalState()?.saver.canSaveOverSocket).toBe(false)
      expect(CollaborationSaverRegistry.get('room')?.saverLeaseId).toBe('peer')
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims)
      expect(application.sync.sync).toHaveBeenCalledTimes(pulls)
      complete({ downloadOnly: true, successful: true })
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve()
      }
      expect(awareness.getLocalState()?.saver.canSaveOverSocket).toBe(true)
      await jest.advanceTimersByTimeAsync(2_000)
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims)
      expect(CollaborationSaverRegistry.get('room')?.saverLeaseId).toBe('peer')
      awareness.getStates().delete(999)
      awareness.emit('change', [])
      await jest.advanceTimersByTimeAsync(2_000)
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims + 1)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(true)
    })
    it('cannot replace the current proof with a delayed renewal from the previous gateway lease', async () => {
      let complete: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      jest.mocked(claimCollaborationSaveFence).mockResolvedValueOnce({
        room: 'room',
        token: 'original-proof',
        expiresAt: Date.now() + 8_000,
      })
      jest
        .mocked(renewCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
      await jest.advanceTimersByTimeAsync(3_000)
      expect(renewCollaborationSaveFence).toHaveBeenCalled()
      activeIdentity = { leaseId: 'replacement', roomEpoch: 'epoch' }
      changeIdentity()
      await jest.advanceTimersByTimeAsync(2_000)
      complete({ room: 'room', token: 'stale-renewal', expiresAt: Date.now() + 30_000 })
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
      expect(releaseCollaborationSaveFence).toHaveBeenCalledWith(
        application,
        { room: 'room', roomEpoch: 'epoch', leaseId: 'local' },
        expect.objectContaining({ token: 'stale-renewal' }),
      )
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({
        leaseId: 'replacement',
        isSaver: true,
        saveFence: { token: 'token' },
      })
    })
    it('does not release a SQL token reused by a newer attempt on the same active lease', async () => {
      let complete: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      jest.mocked(claimCollaborationSaveFence).mockResolvedValueOnce({
        room: 'room',
        token: 'token',
        expiresAt: Date.now() + 8_000,
      })
      jest
        .mocked(renewCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)))
      await jest.advanceTimersByTimeAsync(3_000)
      lane = { usable: false }
      changeLane()
      lane = { usable: true }
      changeLane()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(true)
      jest.mocked(releaseCollaborationSaveFence).mockClear()
      complete({ room: 'room', token: 'token', expiresAt: Date.now() + 30_000 })
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
      expect(releaseCollaborationSaveFence).not.toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, saveFence: { token: 'token' } })
    })
    it('waits for an older same-identity release before claiming a reusable SQL token again', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      let finishRelease: () => void = () => undefined
      jest
        .mocked(releaseCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise<void>((resolve) => (finishRelease = resolve)))
      const claims = jest.mocked(claimCollaborationSaveFence).mock.calls.length
      lane = { usable: false }
      changeLane()
      lane = { usable: true }
      changeLane()
      await jest.advanceTimersByTimeAsync(2_000)
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(false)
      finishRelease()
      for (let turn = 0; turn < 30; turn++) {
        await Promise.resolve()
      }
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims + 1)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(true)
    })
    it('shares the pending release barrier across installer replacement for the same gateway identity', async () => {
      await jest.advanceTimersByTimeAsync(2_000)
      let finishRelease: () => void = () => undefined
      jest
        .mocked(releaseCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise<void>((resolve) => (finishRelease = resolve)))
      lane = { usable: false }
      changeLane()
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
      stop()
      lane = { usable: true }
      const claims = jest.mocked(claimCollaborationSaveFence).mock.calls.length
      stop = installCollaborationSaver(application, 'room', 'a', 'local', provider, 'epoch')
      await jest.advanceTimersByTimeAsync(2_000)
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims)
      finishRelease()
      for (let turn = 0; turn < 30; turn++) {
        await Promise.resolve()
      }
      expect(claimCollaborationSaveFence).toHaveBeenCalledTimes(claims + 1)
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(true)
    })
    it.each([false, true])('cannot revoke a replacement installer same-lease claim (pending=%s)', async (pending) => {
      let completeOld: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      let completeNew: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      jest
        .mocked(claimCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise((resolve) => (completeOld = resolve)))
      if (pending) {
        jest
          .mocked(claimCollaborationSaveFence)
          .mockImplementationOnce(() => new Promise((resolve) => (completeNew = resolve)))
      }
      await jest.advanceTimersByTimeAsync(2_000)
      stop()
      stop = installCollaborationSaver(application, 'room', 'a', 'local', provider, 'epoch')
      await jest.advanceTimersByTimeAsync(2_000)
      const fence = { room: 'room', token: 'token', expiresAt: Date.now() + 30_000 }
      completeOld(fence)
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve()
      }
      expect(releaseCollaborationSaveFence).not.toHaveBeenCalled()
      if (pending) {
        expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(false)
        completeNew(fence)
        for (let turn = 0; turn < 20; turn++) {
          await Promise.resolve()
        }
      }
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, saveFence: { token: 'token' } })
    })
    it('does not revoke a newer same-lease claim still waiting for its reused-token response', async () => {
      let completeOld: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      let completeNew: (value: { room: string; token: string; expiresAt: number }) => void = () => undefined
      jest
        .mocked(claimCollaborationSaveFence)
        .mockImplementationOnce(() => new Promise((resolve) => (completeOld = resolve)))
        .mockImplementationOnce(() => new Promise((resolve) => (completeNew = resolve)))
      await jest.advanceTimersByTimeAsync(2_000)
      lane = { usable: false }
      changeLane()
      lane = { usable: true }
      changeLane()
      await jest.advanceTimersByTimeAsync(2_000)
      const fence = { room: 'room', token: 'token', expiresAt: Date.now() + 30_000 }
      completeOld(fence)
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
      }
      expect(releaseCollaborationSaveFence).not.toHaveBeenCalled()
      expect(CollaborationSaverRegistry.get('room')?.isSaver).toBe(false)
      completeNew(fence)
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve()
      }
      expect(CollaborationSaverRegistry.get('room')).toMatchObject({ isSaver: true, saveFence: { token: 'token' } })
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
