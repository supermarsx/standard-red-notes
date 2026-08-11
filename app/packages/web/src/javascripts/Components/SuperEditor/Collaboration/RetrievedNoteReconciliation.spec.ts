import * as Y from 'yjs'
import {
  ContentType,
  createLitePayloadFromDecrypted,
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  PayloadSource,
  PayloadTimestampDefaults,
} from '@standardnotes/snjs'
import {
  applyRetrievedEditorContent,
  authorizedRetrievedEditorSurfaceNote,
  bindRetrievedReconciliationLifetime,
  buildRetrievedEditorFallbackContent,
  commitRetrievedEditorSurfaceForLifetime,
  flushAuthorizedRetrievedEditorSurfaceBeforeTransition,
  isExactLocalDatabasePayload,
  ownsRetrievedEditorBody,
  persistAndVerifyRetrievedPayloadPair,
  persistedJsonValuesEqual,
  reconcileRetrievedNoteContent,
  RetrievedEditorSurfaceState,
  retrievedEditorComposerLifetimeKey,
  RetrievedDurableState,
  scheduleRetrievedSyncAfterPreservation,
  serializeRetrievedConflictPreservation,
} from './RetrievedNoteReconciliation'
import {
  ChangeEditorFunction,
  registerLatestChangeEditorFunction,
} from '../Plugins/ChangeContentCallback/ChangeContentCallback'

const flushMicrotasks = async (count = 8) => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

const persistencePayload = (uuid: string, text: string, source = PayloadSource.Constructor) =>
  new DecryptedPayload<NoteContent>(
    {
      uuid,
      content_type: ContentType.TYPES.Note,
      content: FillItemContent<NoteContent>({
        title: `Title ${uuid}`,
        text,
        appData: {
          'org.standardnotes.sn': {
            nested: { second: 2, first: 1 },
          },
        } as unknown as NoteContent['appData'],
      }),
      dirty: true,
      duplicate_of: uuid === 'incoming-copy' ? 'original' : undefined,
      key_system_identifier: 'vault-key-system',
      shared_vault_uuid: 'shared-vault',
      last_edited_by_uuid: 'writer',
      ...PayloadTimestampDefaults(),
    },
    source,
  )

const localDatabaseCopy = <Payload extends DecryptedPayload<NoteContent>>(payload: Payload): Payload =>
  payload.copy(undefined, PayloadSource.LocalDatabaseLoaded)

describe('retrieved durable note reconciliation', () => {
  it('preserves newer collaborative CRDT state across sustained lagging durable revisions', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    text.insert(0, 'E1+E2')
    const update = jest.fn()
    doc.on('update', update)
    const changeEditor = jest.fn(() => {
      text.delete(0, text.length)
      text.insert(0, 'E1')
    })
    const flushEditorSerialize = jest.fn()
    const collaboration = { isAttached: jest.fn(() => true) }
    const durableState = { serverUpdatedAtTimestamp: 10, text: 'E1' }

    for (const [revision, durableText] of [
      [9, 'E1'],
      [10, 'E1'],
      [10, 'E1'],
    ] as const) {
      expect(
        reconcileRetrievedNoteContent({
          text: durableText,
          serverUpdatedAtTimestamp: revision,
          collaboration,
          currentCollaborativeText: () => text.toString(),
          durableState,
          editorHasPendingChanges: () => true,
          flushEditorSerialize,
          changeEditor,
          ignoreNextChangeRef: { current: undefined },
        }),
      ).toBe('preserved-collaboration')
    }

    expect(text.toString()).toBe('E1+E2')
    expect(changeEditor).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(flushEditorSerialize).toHaveBeenCalledTimes(3)
    expect(collaboration.isAttached).toHaveBeenCalledTimes(3)
  })

  it('treats a newer equal body as an HTTP echo and preserves one divergent newer body as a conflict', async () => {
    const durableState = { serverUpdatedAtTimestamp: 10, text: 'E1' }
    const preserveDivergentRetrieved = jest.fn().mockResolvedValue(true)
    const common = {
      collaboration: { isAttached: () => true },
      currentCollaborativeText: () => 'E1+E2',
      durableState,
      editorHasPendingChanges: () => false,
      flushEditorSerialize: jest.fn(),
      changeEditor: jest.fn(),
      ignoreNextChangeRef: { current: undefined },
      preserveDivergentRetrieved,
    }

    expect(
      reconcileRetrievedNoteContent({
        ...common,
        text: 'E1+E2',
        serverUpdatedAtTimestamp: 11,
      }),
    ).toBe('preserved-collaboration')
    expect(preserveDivergentRetrieved).not.toHaveBeenCalled()

    expect(
      reconcileRetrievedNoteContent({
        ...common,
        text: 'offline divergent body',
        serverUpdatedAtTimestamp: 12,
      }),
    ).toBe('preserved-conflict')
    await Promise.resolve()
    expect(preserveDivergentRetrieved).toHaveBeenCalledTimes(1)
    expect(preserveDivergentRetrieved).toHaveBeenCalledWith({
      incomingText: 'offline divergent body',
      collaborativeText: 'E1+E2',
      serverUpdatedAtTimestamp: 12,
    })
    await flushMicrotasks()

    expect(
      reconcileRetrievedNoteContent({
        ...common,
        text: 'offline divergent body',
        serverUpdatedAtTimestamp: 12,
      }),
    ).toBe('preserved-collaboration')
    expect(preserveDivergentRetrieved).toHaveBeenCalledTimes(1)
  })

  it('does not advance the durable high-water when conflict duplication fails and retries the same revision', async () => {
    const durableState = { serverUpdatedAtTimestamp: 10, text: 'E1' }
    const preserveDivergentRetrieved = jest
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(true)
    const input = {
      text: 'offline divergent body',
      serverUpdatedAtTimestamp: 12,
      collaboration: { isAttached: () => true },
      currentCollaborativeText: () => 'E1+E2',
      durableState,
      editorHasPendingChanges: () => false,
      flushEditorSerialize: jest.fn(),
      ignoreNextChangeRef: { current: undefined },
      preserveDivergentRetrieved,
    }

    expect(reconcileRetrievedNoteContent(input)).toBe('preserved-conflict')
    await flushMicrotasks()
    expect(durableState.serverUpdatedAtTimestamp).toBe(10)

    expect(reconcileRetrievedNoteContent(input)).toBe('preserved-conflict')
    await flushMicrotasks()
    expect(preserveDivergentRetrieved).toHaveBeenCalledTimes(2)
    expect(durableState.serverUpdatedAtTimestamp).toBe(12)
  })

  it('does not create a conflict when the matching Yjs update settles in the same turn', async () => {
    const durableState = { serverUpdatedAtTimestamp: 10, text: 'E1' }
    const preserveDivergentRetrieved = jest.fn().mockResolvedValue(true)
    let collaborativeText = 'E1+local'

    expect(
      reconcileRetrievedNoteContent({
        text: 'server revision 11',
        serverUpdatedAtTimestamp: 11,
        collaboration: { isAttached: () => true },
        currentCollaborativeText: () => collaborativeText,
        durableState,
        editorHasPendingChanges: () => false,
        flushEditorSerialize: jest.fn(),
        ignoreNextChangeRef: { current: undefined },
        preserveDivergentRetrieved,
      }),
    ).toBe('preserved-conflict')

    collaborativeText = 'server revision 11'
    await flushMicrotasks()

    expect(preserveDivergentRetrieved).not.toHaveBeenCalled()
    expect(durableState).toMatchObject({ serverUpdatedAtTimestamp: 11, text: 'server revision 11' })
  })

  it('bounds a retrieved revision storm to one active and one latest coalesced preservation', async () => {
    const durableState: RetrievedDurableState = { serverUpdatedAtTimestamp: 10, text: 'E1' }
    let resolveFirst!: (preserved: boolean) => void
    const firstPreservation = new Promise<boolean>((resolve) => {
      resolveFirst = resolve
    })
    const preserveDivergentRetrieved = jest
      .fn()
      .mockImplementationOnce(() => firstPreservation)
      .mockResolvedValue(true)
    const common = {
      collaboration: { isAttached: () => true },
      currentCollaborativeText: () => 'latest collaborative body',
      durableState,
      editorHasPendingChanges: () => false,
      flushEditorSerialize: jest.fn(),
      ignoreNextChangeRef: { current: undefined },
      preserveDivergentRetrieved,
    }

    expect(reconcileRetrievedNoteContent({ ...common, text: 'server revision 11', serverUpdatedAtTimestamp: 11 })).toBe(
      'preserved-conflict',
    )
    await Promise.resolve()
    expect(preserveDivergentRetrieved).toHaveBeenCalledTimes(1)

    for (let revision = 12; revision <= 100; revision += 1) {
      expect(
        reconcileRetrievedNoteContent({
          ...common,
          text: `server revision ${revision}`,
          serverUpdatedAtTimestamp: revision,
        }),
      ).toBe('preserved-conflict')
    }
    expect(preserveDivergentRetrieved).toHaveBeenCalledTimes(1)

    resolveFirst(true)
    await flushMicrotasks(16)

    expect(preserveDivergentRetrieved).toHaveBeenCalledTimes(2)
    expect(preserveDivergentRetrieved).toHaveBeenLastCalledWith(
      expect.objectContaining({ incomingText: 'server revision 100', serverUpdatedAtTimestamp: 100 }),
    )
    expect(durableState).toMatchObject({ serverUpdatedAtTimestamp: 100, text: 'server revision 100' })
    expect(durableState.pending).toBeUndefined()
  })

  it('serializes duplicate work and saves the latest E3 body typed while duplication is pending', async () => {
    let resolveDuplicate: (() => void) | undefined
    const duplicate = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDuplicate = resolve
        }),
    )
    let latest = { text: 'E2', preview: 'preview E2' }
    const save = jest.fn().mockResolvedValue(undefined)
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => true,
      duplicate,
      validateBeforeSave: () => true,
      getLatestValue: () => latest,
      save,
    })
    await flushMicrotasks()
    latest = { text: 'E3', preview: 'preview E3' }
    resolveDuplicate?.()

    await expect(serialized.work).resolves.toBe(true)
    expect(save).toHaveBeenCalledWith({ text: 'E3', preview: 'preview E3' })
  })

  it('finishes the durable E3 restore when relay attachment ends during incoming duplication', async () => {
    let attached = true
    const authorized = true
    let resolveDuplicate: (() => void) | undefined
    const save = jest.fn().mockResolvedValue(undefined)
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => attached && authorized,
      duplicate: () =>
        new Promise<void>((resolve) => {
          resolveDuplicate = resolve
        }),
      // After the incoming body is durable, ordinary note authorization and
      // identity—not continued relay attachment—own completion of the restore.
      validateBeforeSave: () => authorized,
      getLatestValue: () => 'latest E3 after note switch',
      save,
    })
    await flushMicrotasks()

    attached = false
    resolveDuplicate?.()
    await expect(serialized.work).resolves.toBe(true)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('latest E3 after note switch')
  })

  it('retries only the authoritative editor restore after a transient save rejection', async () => {
    const duplicate = jest.fn().mockResolvedValue(undefined)
    const save = jest.fn().mockRejectedValueOnce(new Error('temporary write failure')).mockResolvedValueOnce(undefined)
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => true,
      duplicate,
      validateBeforeSave: () => true,
      getLatestValue: () => ({ text: 'latest E3', preview: 'latest preview' }),
      save,
    })

    await expect(serialized.work).resolves.toBe(true)
    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(2, { text: 'latest E3', preview: 'latest preview' })
  })

  it('does not advance preservation when the latest editor body cannot be restored durably', async () => {
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => true,
      duplicate: jest.fn().mockResolvedValue(undefined),
      validateBeforeSave: () => true,
      getLatestValue: () => 'latest E3',
      save: jest.fn().mockRejectedValue(new Error('disk remains full')),
    })

    await expect(serialized.work).resolves.toBe(false)
  })

  it('keeps both incoming and latest editor bodies durable after permanent save failure and teardown', async () => {
    const durableBodies: string[] = ['incoming retrieved body']
    const duplicate = jest.fn(async () => {
      durableBodies.push('incoming retrieved conflict copy')
    })
    const preserveLatestFallback = jest.fn(async (latest: string) => {
      durableBodies.push(latest)
    })
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => true,
      duplicate,
      validateBeforeSave: () => true,
      getLatestValue: () => 'latest collaborative E3 body',
      save: jest.fn().mockRejectedValue(new Error('permanent original write failure')),
      preserveLatestFallback,
    })

    await expect(serialized.work).resolves.toBe(true)
    // Model the editor lifecycle ending immediately after the preservation queue.
    await serialized.tail

    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(preserveLatestFallback).toHaveBeenCalledTimes(1)
    expect(durableBodies).toEqual([
      'incoming retrieved body',
      'incoming retrieved conflict copy',
      'latest collaborative E3 body',
    ])
  })

  it('keeps live title, references, appData, and editor metadata in the teardown fallback', async () => {
    let resolveIncomingDuplicate: (() => void) | undefined
    let liveContent = FillItemContent<NoteContent>({
      title: 'incoming title',
      text: 'incoming R+1',
      editorIdentifier: 'incoming-editor',
      references: [{ uuid: 'incoming-file', content_type: 'File' }],
      appData: {
        'org.standardnotes.sn': { client_updated_at: 'incoming', nested: { marker: 'incoming' } },
      } as unknown as NoteContent['appData'],
    })
    let durableFallback: NoteContent | undefined
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => true,
      duplicate: () =>
        new Promise<void>((resolve) => {
          resolveIncomingDuplicate = resolve
        }),
      validateBeforeSave: () => true,
      getLatestValue: () => ({ text: 'latest E3', previewPlain: 'latest preview', previewHtml: '<p>E3</p>' }),
      save: jest.fn().mockRejectedValue(new Error('primary ended with editor lifetime')),
      preserveLatestFallback: async (latest) => {
        durableFallback = buildRetrievedEditorFallbackContent({
          currentContent: liveContent,
          text: latest.text,
          previewPlain: latest.previewPlain,
          previewHtml: latest.previewHtml,
        })
      },
    })
    await flushMicrotasks()

    liveContent = FillItemContent<NoteContent>({
      title: 'local title changed during checkpoint',
      text: 'incoming R+1',
      editorIdentifier: 'local-editor-v2',
      references: [{ uuid: 'local-file', content_type: 'File' }],
      appData: {
        'org.standardnotes.sn': { client_updated_at: 'local', nested: { marker: 'local' } },
      } as unknown as NoteContent['appData'],
    })
    resolveIncomingDuplicate?.()
    await expect(serialized.work).resolves.toBe(true)

    expect(durableFallback).toMatchObject({
      title: 'local title changed during checkpoint',
      text: 'latest E3',
      preview_plain: 'latest preview',
      preview_html: '<p>E3</p>',
      editorIdentifier: 'local-editor-v2',
      references: [{ uuid: 'local-file', content_type: 'File' }],
      appData: {
        'org.standardnotes.sn': { client_updated_at: 'local', nested: { marker: 'local' } },
      },
    })

    liveContent.references[0].uuid = 'mutated-after-copy'
    ;(liveContent.appData?.['org.standardnotes.sn'] as { nested?: { marker?: string } }).nested!.marker =
      'mutated-after-copy'
    expect(durableFallback?.references[0].uuid).toBe('local-file')
    expect(
      (durableFallback?.appData?.['org.standardnotes.sn'] as { nested?: { marker?: string } }).nested?.marker,
    ).toBe('local')
  })

  it('applies retrieved content before attachment and clears stale ignore state between composers', () => {
    const changeEditor = jest.fn((_text: string, onUpdate?: () => void) => onUpdate?.())
    const ignoreNextChangeRef: { current: object | undefined } = { current: undefined }
    const flushEditorSerialize = jest.fn()
    expect(
      reconcileRetrievedNoteContent({
        text: 'canonical',
        collaboration: { isAttached: () => false },
        editorHasPendingChanges: () => false,
        flushEditorSerialize,
        changeEditor,
        ignoreNextChangeRef,
      }),
    ).toBe('applied')
    expect(changeEditor).toHaveBeenCalledWith('canonical', expect.any(Function))
    expect(flushEditorSerialize).toHaveBeenCalledTimes(1)
    expect(ignoreNextChangeRef.current).toBeUndefined()

    ignoreNextChangeRef.current = {}
    expect(
      reconcileRetrievedNoteContent({
        text: 'new composer state',
        editorHasPendingChanges: () => false,
        flushEditorSerialize: jest.fn(),
        ignoreNextChangeRef,
      }),
    ).toBe('deferred')
    expect(ignoreNextChangeRef.current).toBeUndefined()
  })

  it('consumes the ignore token with the exact programmatic flush before a user edit can share its debounce', () => {
    const ignoreNextChangeRef: { current: object | undefined } = { current: undefined }
    const persisted: string[] = []
    let pendingSerializedText: string | undefined
    let completeProgrammaticUpdate: (() => void) | undefined
    const flushEditorSerialize = () => {
      const text = pendingSerializedText
      pendingSerializedText = undefined
      if (text === undefined) {
        return
      }
      if (ignoreNextChangeRef.current !== undefined) {
        ignoreNextChangeRef.current = undefined
        return
      }
      persisted.push(text)
    }

    expect(
      applyRetrievedEditorContent({
        text: 'retrieved canonical body',
        changeEditor: (text, onUpdate) => {
          pendingSerializedText = text
          completeProgrammaticUpdate = onUpdate
        },
        ignoreNextChangeRef,
        isLifetimeCurrent: () => true,
        flushEditorSerialize,
      }),
    ).toBe(true)
    expect(ignoreNextChangeRef.current).toBeDefined()

    // Lexical's discrete onUpdate fires inside the original debounce window and
    // flushes only the programmatic state while its exact token is active.
    completeProgrammaticUpdate?.()
    expect(persisted).toEqual([])
    expect(ignoreNextChangeRef.current).toBeUndefined()

    // A user edit in what would have been the same 350ms trailing window now has
    // its own pending serialization and can never consume the old ignore token.
    pendingSerializedText = 'user edit inside old debounce window'
    flushEditorSerialize()
    expect(persisted).toEqual(['user edit inside old debounce window'])
  })

  it('does not let a stale programmatic callback flush or clear a replacement lifetime token', () => {
    const ignoreNextChangeRef: { current: object | undefined } = { current: undefined }
    let lifetimeCurrent = true
    let completeStaleUpdate: (() => void) | undefined
    const flushEditorSerialize = jest.fn()

    expect(
      applyRetrievedEditorContent({
        text: 'old lifetime body',
        changeEditor: (_text, onUpdate) => {
          completeStaleUpdate = onUpdate
        },
        ignoreNextChangeRef,
        isLifetimeCurrent: () => lifetimeCurrent,
        flushEditorSerialize,
      }),
    ).toBe(true)

    lifetimeCurrent = false
    const replacementLifetimeToken = {}
    ignoreNextChangeRef.current = replacementLifetimeToken
    completeStaleUpdate?.()

    expect(flushEditorSerialize).not.toHaveBeenCalled()
    expect(ignoreNextChangeRef.current).toBe(replacementLifetimeToken)
  })

  it('adopts a newer HTTP body while realtime is disconnected and the retained editor is clean', () => {
    const changeEditor = jest.fn((_text: string, onUpdate?: () => void) => onUpdate?.())
    const preserve = jest.fn()
    const durableState = { serverUpdatedAtTimestamp: 10, text: 'clean R' }

    expect(
      reconcileRetrievedNoteContent({
        text: 'newer R+1',
        serverUpdatedAtTimestamp: 11,
        collaboration: { isAttached: () => false },
        collaborationHasLocalDivergence: () => false,
        currentCollaborativeText: () => 'clean R',
        durableState,
        preserveDivergentRetrieved: preserve,
        editorHasPendingChanges: () => false,
        flushEditorSerialize: jest.fn(),
        changeEditor,
        ignoreNextChangeRef: { current: undefined },
      }),
    ).toBe('applied')

    expect(changeEditor).toHaveBeenCalledWith('newer R+1', expect.any(Function))
    expect(preserve).not.toHaveBeenCalled()
    expect(durableState).toMatchObject({ serverUpdatedAtTimestamp: 11, text: 'newer R+1' })
  })

  it('preserves a true offline editor divergence while realtime is disconnected', async () => {
    const preserve = jest.fn().mockResolvedValue(true)

    expect(
      reconcileRetrievedNoteContent({
        text: 'newer R+1',
        serverUpdatedAtTimestamp: 11,
        collaboration: { isAttached: () => false },
        collaborationHasLocalDivergence: () => true,
        currentCollaborativeText: () => 'offline E3',
        durableState: { serverUpdatedAtTimestamp: 10, text: 'clean R' },
        preserveDivergentRetrieved: preserve,
        editorHasPendingChanges: () => false,
        flushEditorSerialize: jest.fn(),
        changeEditor: jest.fn(),
        ignoreNextChangeRef: { current: undefined },
      }),
    ).toBe('preserved-conflict')

    await flushMicrotasks()
    expect(preserve).toHaveBeenCalledWith({
      incomingText: 'newer R+1',
      collaborativeText: 'offline E3',
      serverUpdatedAtTimestamp: 11,
    })
  })

  it('authorizes detached-before-receipt preservation only for the exact committed divergent lifetime', async () => {
    const sessionUser = {}
    const identity = {
      noteUuid: 'offline-note',
      userUuid: 'user-a',
      sessionUser,
      sourceId: 'root-a',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const lifetime = bindRetrievedReconciliationLifetime(undefined, {
      identity,
      noteUuid: identity.noteUuid,
      serverUpdatedAtTimestamp: 10,
      text: 'durable R',
      previewPlain: 'R',
      previewHtml: undefined,
    })
    const detachedLease = { validateAttachment: jest.fn(() => false) }
    const ownsDetachedBody = ownsRetrievedEditorBody({
      committedLifetime: lifetime,
      expectedLifetime: lifetime,
      expectedIdentity: identity,
      liveIdentity: identity,
      ownerMatchesCurrentPrincipal: true,
      collaboration: detachedLease,
      latestEditorText: 'offline E3',
      durableText: 'durable R',
    })
    const preserve = jest.fn().mockResolvedValue(true)
    expect(
      reconcileRetrievedNoteContent({
        text: 'remote R+1',
        serverUpdatedAtTimestamp: 11,
        collaboration: { isAttached: () => false },
        collaborationHasLocalDivergence: () => ownsDetachedBody,
        currentCollaborativeText: () => 'offline E3',
        durableState: lifetime.durableState,
        preserveDivergentRetrieved: ownsDetachedBody ? preserve : undefined,
        editorHasPendingChanges: () => false,
        flushEditorSerialize: jest.fn(),
        changeEditor: jest.fn(),
        ignoreNextChangeRef: { current: undefined },
      }),
    ).toBe('preserved-conflict')
    await flushMicrotasks()
    expect(detachedLease.validateAttachment).toHaveBeenCalled()
    expect(preserve).toHaveBeenCalledTimes(1)

    const replacementLifetime = bindRetrievedReconciliationLifetime(lifetime, {
      identity: { ...identity, sessionUser: {}, sourceId: 'root-b' },
      noteUuid: identity.noteUuid,
      serverUpdatedAtTimestamp: 20,
      text: 'replacement body',
      previewPlain: 'replacement',
      previewHtml: undefined,
    })
    expect(
      ownsRetrievedEditorBody({
        committedLifetime: replacementLifetime,
        expectedLifetime: lifetime,
        expectedIdentity: identity,
        liveIdentity: identity,
        ownerMatchesCurrentPrincipal: true,
        collaboration: detachedLease,
        latestEditorText: 'offline E3',
        durableText: 'durable R',
      }),
    ).toBe(false)
    expect(
      ownsRetrievedEditorBody({
        committedLifetime: lifetime,
        expectedLifetime: lifetime,
        expectedIdentity: identity,
        liveIdentity: { ...identity, sessionUser: {}, sourceId: 'foreign-root' },
        ownerMatchesCurrentPrincipal: true,
        collaboration: detachedLease,
        latestEditorText: 'offline E3',
        durableText: 'durable R',
      }),
    ).toBe(false)
    expect(
      ownsRetrievedEditorBody({
        committedLifetime: lifetime,
        expectedLifetime: lifetime,
        expectedIdentity: identity,
        liveIdentity: identity,
        ownerMatchesCurrentPrincipal: true,
        collaboration: detachedLease,
        latestEditorText: 'durable R',
        durableText: 'durable R',
      }),
    ).toBe(false)
  })

  it('isolates same-UUID reconciliation state across session and root-key lifetimes', () => {
    const firstSession = {}
    const secondSession = {}
    const commonIdentity = {
      noteUuid: 'same-note',
      userUuid: 'same-user',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const first = bindRetrievedReconciliationLifetime(undefined, {
      identity: { ...commonIdentity, sessionUser: firstSession, sourceId: 'root-a' },
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 10,
      text: 'old-session E3',
      previewPlain: 'old preview',
      previewHtml: undefined,
    })
    first.durableState.serverUpdatedAtTimestamp = 99
    first.latestEditorText.current = 'old queued E4'

    const second = bindRetrievedReconciliationLifetime(first, {
      identity: { ...commonIdentity, sessionUser: secondSession, sourceId: 'root-a' },
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 20,
      text: 'new-session canonical',
      previewPlain: 'new preview',
      previewHtml: '<p>new preview</p>',
    })

    const oldComposer = jest.fn()
    const noteRef = { current: { uuid: 'same-note', text: 'old-session E3' } }
    const changeEditorFunctionRef: { current: ChangeEditorFunction | undefined } = { current: oldComposer }
    const ignoreNextChangeRef: { current: object | undefined } = { current: {} }
    const newAuthorizedNote = { uuid: 'same-note', text: 'new-session canonical' }
    const owner = { controller: {}, principal: 'same-user' }
    const firstSurface: RetrievedEditorSurfaceState<typeof owner, typeof newAuthorizedNote> = {
      owner,
      lifetime: first,
      generation: 1,
      note: noteRef.current,
    }
    const secondSurface: RetrievedEditorSurfaceState<typeof owner, typeof newAuthorizedNote> = {
      owner,
      lifetime: second,
      generation: 2,
      note: newAuthorizedNote,
    }
    const committedSurfaceRef: { current: RetrievedEditorSurfaceState<typeof owner, typeof newAuthorizedNote> } = {
      current: firstSurface,
    }
    const ownerRef = { current: owner }
    const lifetimeRef = { current: first }
    const generationRef = { current: 1 }
    expect(
      commitRetrievedEditorSurfaceForLifetime({
        expectedPrevious: firstSurface,
        next: secondSurface,
        committedSurfaceRef,
        ownerRef,
        lifetimeRef,
        generationRef,
        noteRef,
        changeEditorFunctionRef,
        ignoreNextChangeRef,
      }),
    ).toBe(true)

    expect(second).not.toBe(first)
    expect(second.durableState).toEqual({ serverUpdatedAtTimestamp: 20, text: 'new-session canonical' })
    expect(second.latestEditorText.current).toBe('new-session canonical')
    expect(noteRef.current).toBe(newAuthorizedNote)
    expect(changeEditorFunctionRef.current).toBeUndefined()
    expect(ignoreNextChangeRef.current).toBeUndefined()
    expect(lifetimeRef.current).toBe(second)
    expect(generationRef.current).toBe(2)
    const prepareAccess = jest.fn()
    prepareAccess(noteRef.current)
    expect(prepareAccess).toHaveBeenCalledWith(newAuthorizedNote)
    expect(
      reconcileRetrievedNoteContent({
        text: 'new-session R+1',
        collaboration: { isAttached: () => false },
        editorHasPendingChanges: () => false,
        flushEditorSerialize: jest.fn(),
        changeEditor: changeEditorFunctionRef.current,
        ignoreNextChangeRef: { current: undefined },
      }),
    ).toBe('deferred')
    expect(oldComposer).not.toHaveBeenCalled()
    expect(retrievedEditorComposerLifetimeKey({ noteUuid: 'same-note', generation: 1 })).not.toBe(
      retrievedEditorComposerLifetimeKey({ noteUuid: 'same-note', generation: 2 }),
    )
    const replacementComposer = jest.fn()
    const disposeReplacement = registerLatestChangeEditorFunction(changeEditorFunctionRef, replacementComposer)
    expect(changeEditorFunctionRef.current).toBe(replacementComposer)
    disposeReplacement()
    first.durableState.serverUpdatedAtTimestamp = 100
    expect(second.durableState.serverUpdatedAtTimestamp).toBe(20)

    const rotated = bindRetrievedReconciliationLifetime(second, {
      identity: { ...commonIdentity, sessionUser: secondSession, sourceId: 'root-b' },
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 30,
      text: 'new-root canonical',
      previewPlain: 'rotated preview',
      previewHtml: undefined,
    })
    expect(rotated).not.toBe(second)
    expect(rotated.durableState).toEqual({ serverUpdatedAtTimestamp: 30, text: 'new-root canonical' })
  })

  it('withholds the old editor surface and callback during a same-UUID unauthorized rollover', () => {
    const oldIdentity = {
      noteUuid: 'same-note',
      userUuid: 'old-user',
      sessionUser: {},
      sourceId: 'old-root',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const oldLifetime = bindRetrievedReconciliationLifetime(undefined, {
      identity: oldIdentity,
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 10,
      text: 'old secret body',
      previewPlain: 'old secret preview',
      previewHtml: undefined,
    })
    const unauthorizedLifetime = bindRetrievedReconciliationLifetime(oldLifetime, {
      identity: undefined,
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 0,
      text: 'foreign controller body',
      previewPlain: 'foreign preview',
      previewHtml: undefined,
    })
    const oldComposer = jest.fn()
    const oldNote = { uuid: 'same-note', title: 'old secret title', text: 'old secret body' }
    const foreignControllerNote = { uuid: 'same-note', title: 'foreign title', text: 'foreign controller body' }
    const noteRef = { current: oldNote }
    const changeEditorFunctionRef: { current: ChangeEditorFunction | undefined } = { current: oldComposer }
    const ignoreNextChangeRef: { current: object | undefined } = { current: {} }

    const oldOwner = { controller: {}, principal: 'old-user' }
    const oldSurface = {
      owner: oldOwner,
      lifetime: oldLifetime,
      generation: 1,
      note: oldNote,
    }
    const unauthorizedSurface = {
      owner: oldOwner,
      lifetime: unauthorizedLifetime,
      generation: 2,
      note: foreignControllerNote,
    }
    commitRetrievedEditorSurfaceForLifetime({
      expectedPrevious: oldSurface,
      next: unauthorizedSurface,
      committedSurfaceRef: { current: oldSurface },
      ownerRef: { current: oldOwner },
      lifetimeRef: { current: oldLifetime },
      generationRef: { current: 1 },
      noteRef,
      changeEditorFunctionRef,
      ignoreNextChangeRef,
    })
    const renderableNote = authorizedRetrievedEditorSurfaceNote({
      lifetime: unauthorizedLifetime,
      identity: undefined,
      note: noteRef.current,
    })

    expect(noteRef.current).toBe(foreignControllerNote)
    expect(renderableNote).toBeUndefined()
    expect(changeEditorFunctionRef.current).toBeUndefined()
    expect(ignoreNextChangeRef.current).toBeUndefined()
    expect(oldComposer).not.toHaveBeenCalled()
    expect(renderableNote ? `${renderableNote.title}:${renderableNote.text}` : '').not.toContain('old secret')
  })

  it('keeps the committed editor writable when a concurrent replacement render is abandoned', () => {
    const oldOwner = { controller: { id: 'old-controller' }, principal: 'old-user' }
    const newOwner = { controller: { id: 'new-controller' }, principal: 'new-user' }
    const oldIdentity = {
      noteUuid: 'same-note',
      userUuid: 'old-user',
      sessionUser: {},
      sourceId: 'old-root',
      keySystemIdentifier: null,
      sharedVaultUuid: null,
    }
    const newIdentity = {
      ...oldIdentity,
      userUuid: 'new-user',
      sessionUser: {},
      sourceId: 'new-root',
    }
    const oldLifetime = bindRetrievedReconciliationLifetime(undefined, {
      identity: oldIdentity,
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 10,
      text: 'old committed body',
      previewPlain: 'old preview',
      previewHtml: undefined,
    })
    const plannedLifetime = bindRetrievedReconciliationLifetime(oldLifetime, {
      identity: newIdentity,
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 20,
      text: 'replacement body',
      previewPlain: 'replacement preview',
      previewHtml: undefined,
    })
    const oldNote = { uuid: 'same-note', text: 'old committed body' }
    const replacementNote = { uuid: 'same-note', text: 'replacement body' }
    const oldSurface: RetrievedEditorSurfaceState<typeof oldOwner, typeof oldNote> = {
      owner: oldOwner,
      lifetime: oldLifetime,
      generation: 1,
      note: oldNote,
    }
    const abandonedPlan: RetrievedEditorSurfaceState<typeof oldOwner, typeof oldNote> = {
      owner: newOwner,
      lifetime: plannedLifetime,
      generation: 2,
      note: replacementNote,
    }
    const committedSurfaceRef = { current: oldSurface }
    const ownerRef = { current: oldOwner }
    const lifetimeRef = { current: oldLifetime }
    const generationRef = { current: 1 }
    const noteRef = { current: oldNote }
    const oldEditorCallback = jest.fn()
    const changeEditorFunctionRef: { current: ChangeEditorFunction | undefined } = { current: oldEditorCallback }
    const abandonedIgnoreToken = {}
    const ignoreNextChangeRef: { current: object | undefined } = { current: abandonedIgnoreToken }
    const saveCommittedEdit = jest.fn()
    const oldCommittedHandleChange = () => {
      if (lifetimeRef.current === oldLifetime) {
        saveCommittedEdit()
      }
    }

    // React may prepare this object and then abandon that render. Planning alone
    // must not publish any ownership change into refs shared with the live tree.
    expect(abandonedPlan.lifetime).toBe(plannedLifetime)
    oldCommittedHandleChange()
    expect(saveCommittedEdit).toHaveBeenCalledTimes(1)
    expect(committedSurfaceRef.current).toBe(oldSurface)
    expect(changeEditorFunctionRef.current).toBe(oldEditorCallback)
    expect(ignoreNextChangeRef.current).toBe(abandonedIgnoreToken)

    expect(
      commitRetrievedEditorSurfaceForLifetime({
        expectedPrevious: oldSurface,
        next: abandonedPlan,
        committedSurfaceRef,
        ownerRef,
        lifetimeRef,
        generationRef,
        noteRef,
        changeEditorFunctionRef,
        ignoreNextChangeRef,
      }),
    ).toBe(true)
    oldCommittedHandleChange()
    expect(saveCommittedEdit).toHaveBeenCalledTimes(1)
    expect(committedSurfaceRef.current).toBe(abandonedPlan)
    expect(lifetimeRef.current).toBe(plannedLifetime)
    expect(noteRef.current).toBe(replacementNote)
    expect(changeEditorFunctionRef.current).toBeUndefined()
    expect(ignoreNextChangeRef.current).toBeUndefined()
  })

  it('invalidates stale callbacks when a replacement controller keeps the same note lifetime', () => {
    const firstOwner = { controller: { id: 'first-controller' }, principal: 'user-a' }
    const secondOwner = { controller: { id: 'second-controller' }, principal: 'user-a' }
    const lifetime = bindRetrievedReconciliationLifetime(undefined, {
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 10,
      text: 'same authorized body',
      previewPlain: 'preview',
      previewHtml: undefined,
    })
    const note = { uuid: 'same-note', text: 'same authorized body' }
    const firstSurface: RetrievedEditorSurfaceState<typeof firstOwner, typeof note> = {
      owner: firstOwner,
      lifetime,
      generation: 1,
      note,
    }
    const secondSurface: RetrievedEditorSurfaceState<typeof firstOwner, typeof note> = {
      owner: secondOwner,
      lifetime,
      generation: 2,
      note,
    }
    const committedSurfaceRef = { current: firstSurface }
    const ownerRef = { current: firstOwner }
    const lifetimeRef = { current: lifetime }
    const saveFromFirstController = jest.fn()
    const firstControllerCallback = () => {
      if (ownerRef.current === firstOwner && lifetimeRef.current === lifetime) {
        saveFromFirstController()
      }
    }

    firstControllerCallback()
    expect(
      commitRetrievedEditorSurfaceForLifetime({
        expectedPrevious: firstSurface,
        next: secondSurface,
        committedSurfaceRef,
        ownerRef,
        lifetimeRef,
        generationRef: { current: 1 },
        noteRef: { current: note },
        changeEditorFunctionRef: { current: firstControllerCallback },
        ignoreNextChangeRef: { current: {} },
      }),
    ).toBe(true)
    firstControllerCallback()

    expect(saveFromFirstController).toHaveBeenCalledTimes(1)
    expect(ownerRef.current).toBe(secondOwner)
    expect(lifetimeRef.current).toBe(lifetime)
  })

  it('flushes the old note tail before a note switch publishes the replacement lifetime', () => {
    const oldOwner = { controller: { id: 'old-controller' }, principal: 'user-a' }
    const newOwner = { controller: { id: 'new-controller' }, principal: 'user-a' }
    const oldLifetime = bindRetrievedReconciliationLifetime(undefined, {
      noteUuid: 'old-note',
      serverUpdatedAtTimestamp: 10,
      text: 'old durable body',
      previewPlain: 'old preview',
      previewHtml: undefined,
    })
    const newLifetime = bindRetrievedReconciliationLifetime(undefined, {
      noteUuid: 'new-note',
      serverUpdatedAtTimestamp: 20,
      text: 'new durable body',
      previewPlain: 'new preview',
      previewHtml: undefined,
    })
    const ownerRef = { current: oldOwner }
    const lifetimeRef = { current: oldLifetime }
    let pending = true
    const saveOldTail = jest.fn()
    const oldHandleChange = () => {
      if (ownerRef.current === oldOwner && lifetimeRef.current === oldLifetime) {
        saveOldTail()
      }
    }
    const flushPendingChanges = jest.fn(() => {
      if (!pending) {
        return
      }
      pending = false
      oldHandleChange()
    })

    expect(
      flushAuthorizedRetrievedEditorSurfaceBeforeTransition({
        expectedOwner: oldOwner,
        expectedLifetime: oldLifetime,
        ownerRef,
        lifetimeRef,
        validateAuthorization: () => true,
        hasPendingChanges: () => pending,
        flushPendingChanges,
      }),
    ).toBe(true)
    ownerRef.current = newOwner
    lifetimeRef.current = newLifetime
    // BlocksEditor's later passive cleanup is idempotent because the layout
    // cleanup already consumed its exact pending serialize.
    flushPendingChanges()

    expect(saveOldTail).toHaveBeenCalledTimes(1)
    expect(flushPendingChanges).toHaveBeenCalledTimes(2)
  })

  it('flushes an exact old controller once but rejects stale or unauthorized controller cleanup', () => {
    const oldOwner = { controller: { id: 'old-controller' }, principal: 'user-a' }
    const replacementOwner = { controller: { id: 'replacement-controller' }, principal: 'user-a' }
    const lifetime = bindRetrievedReconciliationLifetime(undefined, {
      noteUuid: 'same-note',
      serverUpdatedAtTimestamp: 10,
      text: 'durable body',
      previewPlain: 'preview',
      previewHtml: undefined,
    })
    const ownerRef = { current: oldOwner }
    const lifetimeRef = { current: lifetime }
    const flushPendingChanges = jest.fn()

    expect(
      flushAuthorizedRetrievedEditorSurfaceBeforeTransition({
        expectedOwner: oldOwner,
        expectedLifetime: lifetime,
        ownerRef,
        lifetimeRef,
        validateAuthorization: () => true,
        hasPendingChanges: () => true,
        flushPendingChanges,
      }),
    ).toBe(true)
    ownerRef.current = replacementOwner
    expect(
      flushAuthorizedRetrievedEditorSurfaceBeforeTransition({
        expectedOwner: oldOwner,
        expectedLifetime: lifetime,
        ownerRef,
        lifetimeRef,
        validateAuthorization: () => true,
        hasPendingChanges: () => true,
        flushPendingChanges,
      }),
    ).toBe(false)
    ownerRef.current = oldOwner
    expect(
      flushAuthorizedRetrievedEditorSurfaceBeforeTransition({
        expectedOwner: oldOwner,
        expectedLifetime: lifetime,
        ownerRef,
        lifetimeRef,
        validateAuthorization: () => false,
        hasPendingChanges: () => true,
        flushPendingChanges,
      }),
    ).toBe(false)

    expect(flushPendingChanges).toHaveBeenCalledTimes(1)
  })

  describe('atomic retrieved-conflict persistence proof', () => {
    it('persists both exact payloads in one batch and independently reads both from LocalDatabaseLoaded', async () => {
      const first = persistencePayload('incoming-copy', 'incoming R+1')
      const second = persistencePayload('original', 'latest E3')
      const persist = jest.fn().mockResolvedValue(undefined)
      const read = jest.fn((uuid: string) => Promise.resolve(localDatabaseCopy(uuid === first.uuid ? first : second)))
      const validate = jest.fn(() => true)

      await expect(
        persistAndVerifyRetrievedPayloadPair({ first, second, persist, read, validate }),
      ).resolves.toBeUndefined()

      expect(persist).toHaveBeenCalledTimes(1)
      expect(persist).toHaveBeenCalledWith([first, second])
      expect(read.mock.calls.map(([uuid]) => uuid)).toEqual([first.uuid, second.uuid])
      expect(validate).toHaveBeenCalledTimes(3)
    })

    it('rejects quota/storage failure without attempting a readback', async () => {
      const first = persistencePayload('incoming-copy', 'incoming R+1')
      const second = persistencePayload('original', 'latest E3')
      const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
      const read = jest.fn()

      await expect(
        persistAndVerifyRetrievedPayloadPair({
          first,
          second,
          validate: () => true,
          persist: jest.fn().mockRejectedValue(quota),
          read,
        }),
      ).rejects.toBe(quota)
      expect(read).not.toHaveBeenCalled()
    })

    it('rejects a raced lite input before starting the atomic write', async () => {
      const first = createLitePayloadFromDecrypted(persistencePayload('incoming-copy', 'incoming R+1'))
      const second = persistencePayload('original', 'latest E3')
      const persist = jest.fn()
      const read = jest.fn()

      await expect(
        persistAndVerifyRetrievedPayloadPair({
          first,
          second,
          validate: () => true,
          persist,
          read,
        }),
      ).rejects.toThrow('not-authorized')
      expect(persist).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    })

    it('rejects a same-UUID pair before it can masquerade as two durable bodies', async () => {
      const first = persistencePayload('same-uuid', 'incoming R+1')
      const second = persistencePayload('same-uuid', 'latest E3')
      const persist = jest.fn()

      await expect(
        persistAndVerifyRetrievedPayloadPair({
          first,
          second,
          validate: () => true,
          persist,
          read: jest.fn(),
        }),
      ).rejects.toThrow('not-authorized')
      expect(persist).not.toHaveBeenCalled()
    })

    it('rejects a resolved deinit/no-op persistence when neither exact UUID is on disk', async () => {
      const first = persistencePayload('incoming-copy', 'incoming R+1')
      const second = persistencePayload('original', 'latest E3')

      await expect(
        persistAndVerifyRetrievedPayloadPair({
          first,
          second,
          validate: () => true,
          persist: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(undefined),
        }),
      ).rejects.toThrow('readback-mismatch')
    })

    it('rejects when either readback is lite, stale, or not sourced from LocalDatabaseLoaded', async () => {
      const first = persistencePayload('incoming-copy', 'incoming R+1')
      const second = persistencePayload('original', 'latest E3')
      const staleSecond = second.copy(
        { content: FillItemContent<NoteContent>({ ...second.content, text: 'stale E2' }) },
        PayloadSource.LocalDatabaseLoaded,
      )
      const cases = [
        [first, second.copy(undefined, PayloadSource.Constructor)],
        [createLitePayloadFromDecrypted(localDatabaseCopy(first)), localDatabaseCopy(second)],
        [localDatabaseCopy(first), staleSecond],
      ] as const

      for (const [firstReadback, secondReadback] of cases) {
        await expect(
          persistAndVerifyRetrievedPayloadPair({
            first,
            second,
            validate: () => true,
            persist: jest.fn().mockResolvedValue(undefined),
            read: (uuid) => Promise.resolve(uuid === first.uuid ? firstReadback : secondReadback),
          }),
        ).rejects.toThrow('readback-mismatch')
      }
    })

    it('fails closed when session/root/write identity changes during persist or readback', async () => {
      const first = persistencePayload('incoming-copy', 'incoming R+1')
      const second = persistencePayload('original', 'latest E3')
      const firstReadback = localDatabaseCopy(first)
      const secondReadback = localDatabaseCopy(second)

      for (const validationResults of [
        [true, false],
        [true, true, false],
      ]) {
        const validate = jest.fn<boolean, []>().mockImplementation(() => validationResults.shift() ?? false)
        await expect(
          persistAndVerifyRetrievedPayloadPair({
            first,
            second,
            validate,
            persist: jest.fn().mockResolvedValue(undefined),
            read: (uuid) => Promise.resolve(uuid === first.uuid ? firstReadback : secondReadback),
          }),
        ).rejects.toThrow(/identity-changed|readback-mismatch/)
      }
    })

    it('uses JSON persistence equality for nested content while still rejecting a changed body', () => {
      expect(persistedJsonValuesEqual({ second: 2, first: { b: 2, a: 1 } }, { first: { a: 1, b: 2 }, second: 2 })).toBe(
        true,
      )
      const expected = persistencePayload('original', 'latest E3')
      expect(isExactLocalDatabasePayload(localDatabaseCopy(expected), expected)).toBe(true)
      expect(
        isExactLocalDatabasePayload(
          expected.copy(
            { content: FillItemContent<NoteContent>({ ...expected.content, text: 'changed E4' }) },
            PayloadSource.LocalDatabaseLoaded,
          ),
          expected,
        ),
      ).toBe(false)
    })
  })

  it('re-reads E4 after an E3 persistence race instead of acknowledging the stale body', async () => {
    let latest = 'E3'
    const save = jest.fn(async (value: string) => {
      if (value === 'E3') {
        latest = 'E4'
        throw new Error('live payload changed during persistence')
      }
    })
    const serialized = serializeRetrievedConflictPreservation({
      previous: Promise.resolve(),
      validateBeforeDuplicate: () => true,
      duplicate: jest.fn().mockResolvedValue(undefined),
      validateBeforeSave: () => true,
      getLatestValue: () => latest,
      save,
    })

    await expect(serialized.work).resolves.toBe(true)
    expect(save.mock.calls).toEqual([['E3'], ['E4']])
  })

  it('never schedules remote sync after a false/no-op checkpoint or invalidated identity', async () => {
    const schedule = jest.fn()

    await expect(
      scheduleRetrievedSyncAfterPreservation({
        work: Promise.resolve(false),
        validate: () => true,
        schedule,
      }),
    ).resolves.toBe(false)
    await expect(
      scheduleRetrievedSyncAfterPreservation({
        work: Promise.resolve(true),
        validate: () => false,
        schedule,
      }),
    ).resolves.toBe(false)

    expect(schedule).not.toHaveBeenCalled()
  })

  it('does not advance the retrieved high-water when post-write identity validation fails', async () => {
    const durableState = { serverUpdatedAtTimestamp: 10, text: 'R' }
    let authorized = false
    const schedule = jest.fn()
    const preserve = jest.fn(() =>
      scheduleRetrievedSyncAfterPreservation({
        work: Promise.resolve(true),
        validate: () => authorized,
        schedule,
      }),
    )
    const input = {
      text: 'R+1',
      serverUpdatedAtTimestamp: 11,
      collaboration: { isAttached: () => true },
      currentCollaborativeText: () => 'local E3',
      durableState,
      preserveDivergentRetrieved: preserve,
      editorHasPendingChanges: () => false,
      flushEditorSerialize: jest.fn(),
      ignoreNextChangeRef: { current: undefined },
    }

    expect(reconcileRetrievedNoteContent(input)).toBe('preserved-conflict')
    await flushMicrotasks(12)
    expect(durableState.serverUpdatedAtTimestamp).toBe(10)
    expect(schedule).not.toHaveBeenCalled()

    authorized = true
    expect(reconcileRetrievedNoteContent(input)).toBe('preserved-conflict')
    await flushMicrotasks(12)
    expect(preserve).toHaveBeenCalledTimes(2)
    expect(durableState).toMatchObject({ serverUpdatedAtTimestamp: 11, text: 'R+1' })
    expect(schedule).toHaveBeenCalledTimes(1)
  })
})
