import { ContentType, MutationType, NoteMutator, NoteType, PayloadEmitSource, SNNote } from '@standardnotes/snjs'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import { WebApplication } from '@/Application/WebApplication'
import { buildAssistantNoteChange, createAssistantNoteSnapshot } from './assistantNoteChanges'
import {
  acceptAssistantChange,
  appendAssistantChangeRecord,
  AssistantChangeLedgerEnvelope,
  AssistantChangeRecord,
  createAssistantChangeRecord,
  dismissAssistantChange,
  getAssistantChangeLedger,
  MAX_ASSISTANT_CHANGE_FRAGMENT_CHARS,
  MAX_ASSISTANT_CHANGE_RECORDS,
  NoteAssistantChangesKey,
  undoAssistantChange,
  withAssistantChangeLedgerMutation,
} from './assistantChangeLedger'

const noteChange = (noteUuid = 'note-1', beforeText = 'before', afterText = 'after') => {
  const before = createAssistantNoteSnapshot({
    title: 'Tracked',
    text: beforeText,
    previewPlain: beforeText,
    noteType: NoteType.Plain,
  })
  const after = createAssistantNoteSnapshot({
    title: 'Tracked',
    text: afterText,
    previewPlain: afterText,
    noteType: NoteType.Plain,
  })
  const change = buildAssistantNoteChange({ noteUuid, before, after })
  if (!change) {
    throw new Error('Expected a note change fixture')
  }
  return change
}

const effect = (operationId = 'operation-1') => ({
  operationId,
  type: 'replace-text' as const,
  summary: 'Replaced text in one structural block.',
  affected: [{ path: [0], nodeUuid: 'node-1' }],
  beforeFragment: '{"password":"plain-secret","text":"before"}',
  afterFragment: `{"token":"bearer-secret","text":"${'x'.repeat(MAX_ASSISTANT_CHANGE_FRAGMENT_CHARS + 100)}"}`,
})

const record = (overrides: Partial<AssistantChangeRecord> = {}): AssistantChangeRecord =>
  createAssistantChangeRecord({
    changeId: overrides.changeId ?? 'change-1',
    noteUuid: overrides.noteUuid ?? 'note-1',
    source: overrides.source ?? {
      assistantMessageId: 'message-1',
      assistantRunId: 'run-1',
      toolCallId: 'call-1',
    },
    baseRevision: overrides.baseRevision ?? { contentHash: 'base-hash' },
    newRevision: overrides.newRevision ?? { contentHash: 'new-hash' },
    effects: overrides.operations ?? [effect(overrides.operationIds?.[0])],
    undo: overrides.undo ?? noteChange(overrides.noteUuid),
    createdAt: overrides.createdAt,
  })

const noteWithLedger = (noteUuid: string, getValue: () => unknown): SNNote =>
  ({
    uuid: noteUuid,
    content_type: ContentType.TYPES.Note,
    getAppDomainValue: (key: unknown) => (key === NoteAssistantChangesKey ? getValue() : undefined),
  }) as unknown as SNNote

describe('assistant encrypted per-note change ledger', () => {
  beforeAll(() => {
    if (!globalThis.TextEncoder) {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
    }
  })

  it('links the source message/run and stores only bounded redacted display fragments', () => {
    const created = record()

    expect(created.source).toEqual({ assistantMessageId: 'message-1', assistantRunId: 'run-1', toolCallId: 'call-1' })
    expect(created.operations[0].beforeFragment).toContain('[redacted]')
    expect(created.operations[0].beforeFragment).not.toContain('plain-secret')
    expect(created.operations[0].afterFragment?.length).toBeLessThanOrEqual(MAX_ASSISTANT_CHANGE_FRAGMENT_CHARS + 1)
    expect(created.operations[0].truncated).toBe(true)
    expect(created.affectedNodeUuids).toEqual(['node-1'])
  })

  it('redacts unterminated secrets before a fragment can be truncated mid-value', () => {
    const secret = 'DO_NOT_PERSIST_THIS_SECRET_'.repeat(200)
    const created = createAssistantChangeRecord({
      changeId: 'change-mid-secret',
      noteUuid: 'note-1',
      source: { assistantMessageId: 'message-1', assistantRunId: 'run-1' },
      baseRevision: { contentHash: 'base-hash' },
      newRevision: { contentHash: 'new-hash' },
      effects: [
        {
          operationId: 'operation-mid-secret',
          type: 'replace-text',
          summary: 'Replaced text in one structural block.',
          affected: [{ path: [0] }],
          beforeFragment: `{"password":"${secret}`,
          afterFragment: `-----BEGIN PRIVATE KEY-----\n${secret}`,
        },
        {
          operationId: 'operation-token-prefix',
          type: 'update-attrs',
          summary: 'Updated one structural block.',
          affected: [{ path: [0] }],
          beforeFragment: `token=${secret}`,
          afterFragment: `Bearer ${secret}`,
        },
      ],
      undo: noteChange(),
    })

    const display = JSON.stringify(created.operations)
    expect(display).not.toContain('DO_NOT_PERSIST_THIS_SECRET')
    expect(display).toContain('[redacted')
  })

  it('round-trips only through the owning note and rejects cross-note records on reload', () => {
    const stored = { version: 1, records: [record()] } satisfies AssistantChangeLedgerEnvelope
    expect(getAssistantChangeLedger(noteWithLedger('note-1', () => stored)).records).toHaveLength(1)
    expect(getAssistantChangeLedger(noteWithLedger('other-note', () => stored)).records).toEqual([])
  })

  it('keeps bounded newest history and removes duplicate operation ids', () => {
    let stored: AssistantChangeLedgerEnvelope | undefined
    const note = noteWithLedger('note-1', () => stored)
    const now = Date.parse('2026-08-19T12:00:00.000Z')
    for (let index = 0; index < MAX_ASSISTANT_CHANGE_RECORDS + 5; index++) {
      const createdAt = new Date(now - index * 1_000).toISOString()
      stored = appendAssistantChangeRecord(
        note,
        record({
          changeId: `change-${index}`,
          operationIds: [`operation-${index}`],
          operations: [effect(`operation-${index}`)],
          createdAt,
        }),
        now,
      )
    }

    expect(stored?.records).toHaveLength(MAX_ASSISTANT_CHANGE_RECORDS)
    expect(new Set(stored?.records.flatMap((entry) => entry.operationIds) ?? []).size).toBe(stored?.records.length)
  })
})

function actionHarness(initial: AssistantChangeRecord) {
  const appData = new Map<unknown, unknown>([[NoteAssistantChangesKey, { version: 1, records: [initial] }]])
  const note = {
    uuid: initial.noteUuid,
    content_type: ContentType.TYPES.Note,
    payload: undefined,
    locked: false,
    title: initial.undo.after.title,
    text: initial.undo.after.text,
    preview_plain: initial.undo.after.previewPlain,
    preview_html: initial.undo.after.previewHtml,
    noteType: initial.undo.after.noteType,
    editorIdentifier: initial.undo.after.editorIdentifier,
    getAppDomainValue: (key: unknown) => appData.get(key),
  } as unknown as SNNote
  const sync = jest.fn().mockResolvedValue(undefined)
  const assistantConfigRequest = jest.fn()
  const changeItem = jest.fn(
    async (_note: SNNote, mutate: (mutator: Record<string, unknown>) => void, _type: unknown, source: unknown) => {
      const mutator: Record<string, unknown> = {
        title: note.title,
        text: note.text,
        preview_plain: note.preview_plain,
        preview_html: note.preview_html,
        noteType: note.noteType,
        editorIdentifier: note.editorIdentifier,
        setAppDataItem: (key: unknown, value: unknown) => appData.set(key, value),
      }
      mutate(mutator)
      Object.assign(note, {
        title: mutator.title,
        text: mutator.text,
        preview_plain: mutator.preview_plain,
        preview_html: mutator.preview_html,
        noteType: mutator.noteType,
        editorIdentifier: mutator.editorIdentifier,
      })
      return note
    },
  )
  const application = {
    items: { findItem: () => note },
    isAuthorizedToRenderItem: () => true,
    sessions: { isCurrentSessionReadOnly: () => false },
    vaults: { getItemVault: () => undefined },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    itemControllerGroup: { itemControllers: [] },
    mutator: { changeItem },
    sync: { sync },
    assistantConfigRequest,
  } as unknown as WebApplication
  return { application, note, appData, changeItem, sync, assistantConfigRequest }
}

describe('assistant tracked change actions', () => {
  it('persists accepted and dismissed states without sending plaintext through an API request', async () => {
    const initial = record()
    const harness = actionHarness(initial)

    await expect(acceptAssistantChange(harness.application, 'note-1', initial.changeId)).resolves.toMatchObject({
      status: 'accepted',
    })
    await expect(dismissAssistantChange(harness.application, 'note-1', initial.changeId)).resolves.toMatchObject({
      status: 'dismissed',
    })
    expect(harness.assistantConfigRequest).not.toHaveBeenCalled()
    expect(harness.changeItem.mock.calls.every((call) => call[3] === PayloadEmitSource.LocalChanged)).toBe(true)
  })

  it('uses guarded note-history undo, marks success, and refuses a concurrent body', async () => {
    const initial = record()
    const success = actionHarness(initial)

    await expect(undoAssistantChange(success.application, 'note-1', initial.changeId)).resolves.toMatchObject({
      status: 'undone',
    })
    expect(success.note.text).toBe('before')

    const conflict = actionHarness(initial)
    ;(conflict.note as unknown as { text: string }).text = 'newer user content'
    await expect(undoAssistantChange(conflict.application, 'note-1', initial.changeId)).rejects.toThrow(
      /changed again.*Review the latest note/i,
    )
    expect(getAssistantChangeLedger(conflict.note).records[0].status).toBe('applied')
  })
})

function concurrentLedgerHarness(initialRecords: AssistantChangeRecord[]) {
  const appData = new Map<unknown, unknown>([
    [NoteAssistantChangesKey, { version: 1, records: initialRecords } satisfies AssistantChangeLedgerEnvelope],
  ])
  const first = initialRecords[0]
  const note = {
    uuid: first.noteUuid,
    content_type: ContentType.TYPES.Note,
    payload: undefined,
    locked: false,
    title: first.undo.after.title,
    text: first.undo.after.text,
    preview_plain: first.undo.after.previewPlain,
    preview_html: first.undo.after.previewHtml,
    noteType: first.undo.after.noteType,
    editorIdentifier: first.undo.after.editorIdentifier,
    getAppDomainValue: (key: unknown) => appData.get(key),
  } as unknown as SNNote
  let releaseWrites!: () => void
  let signalFirstWrite!: () => void
  const writesReleased = new Promise<void>((resolve) => {
    releaseWrites = resolve
  })
  const firstWriteEntered = new Promise<void>((resolve) => {
    signalFirstWrite = resolve
  })
  let activeWrites = 0
  let maxActiveWrites = 0
  const changeItem = jest.fn(async (_note: SNNote, mutate: (mutator: NoteMutator) => void) => {
    activeWrites += 1
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
    signalFirstWrite()
    await writesReleased
    mutate({ setAppDataItem: (key: unknown, value: unknown) => appData.set(key, value) } as unknown as NoteMutator)
    activeWrites -= 1
    return note
  })
  const application = {
    items: { findItem: () => note },
    isAuthorizedToRenderItem: () => true,
    sessions: { isCurrentSessionReadOnly: () => false },
    vaults: { getItemVault: () => undefined },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    itemControllerGroup: { itemControllers: [] },
    mutator: { changeItem },
    sync: { sync: jest.fn().mockResolvedValue(undefined) },
  } as unknown as WebApplication
  return {
    application,
    note,
    firstWriteEntered,
    releaseWrites,
    maxActiveWrites: () => maxActiveWrites,
  }
}

describe('assistant ledger mutation serialization', () => {
  it('preserves two concurrent status changes for the same note', async () => {
    const first = record({ changeId: 'change-a', operationIds: ['operation-a'], operations: [effect('operation-a')] })
    const second = record({
      changeId: 'change-b',
      operationIds: ['operation-b'],
      operations: [effect('operation-b')],
      createdAt: new Date(Date.parse(first.createdAt) - 1_000).toISOString(),
    })
    const harness = concurrentLedgerHarness([first, second])

    const accept = acceptAssistantChange(harness.application, first.noteUuid, first.changeId)
    const dismiss = dismissAssistantChange(harness.application, second.noteUuid, second.changeId)
    await harness.firstWriteEntered
    await Promise.resolve()
    harness.releaseWrites()
    await Promise.all([accept, dismiss])

    expect(harness.maxActiveWrites()).toBe(1)
    expect(getAssistantChangeLedger(harness.note).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changeId: first.changeId, status: 'accepted' }),
        expect.objectContaining({ changeId: second.changeId, status: 'dismissed' }),
      ]),
    )
  })

  it('merges a concurrent status change with a queued structural append', async () => {
    const existing = record({
      changeId: 'change-existing',
      operationIds: ['operation-existing'],
      operations: [effect('operation-existing')],
    })
    const appended = record({
      changeId: 'change-appended',
      operationIds: ['operation-appended'],
      operations: [effect('operation-appended')],
      createdAt: new Date(Date.parse(existing.createdAt) + 1_000).toISOString(),
    })
    const harness = concurrentLedgerHarness([existing])

    const status = acceptAssistantChange(harness.application, existing.noteUuid, existing.changeId)
    const append = withAssistantChangeLedgerMutation(harness.application, existing.noteUuid, async () => {
      const latest = harness.application.items.findItem<SNNote>(existing.noteUuid) as SNNote
      await harness.application.mutator.changeItem<NoteMutator, SNNote>(
        latest,
        (mutator) => mutator.setAppDataItem(NoteAssistantChangesKey, appendAssistantChangeRecord(latest, appended)),
        MutationType.UpdateUserTimestamps,
        PayloadEmitSource.AssistantChanged,
      )
    })
    await harness.firstWriteEntered
    await Promise.resolve()
    harness.releaseWrites()
    await Promise.all([status, append])

    expect(harness.maxActiveWrites()).toBe(1)
    expect(getAssistantChangeLedger(harness.note).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ changeId: existing.changeId, status: 'accepted' }),
        expect.objectContaining({ changeId: appended.changeId, status: 'applied' }),
      ]),
    )
  })
})
