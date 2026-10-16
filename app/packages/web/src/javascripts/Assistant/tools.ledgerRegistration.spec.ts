import {
  AppDataField,
  ContentType,
  DefaultAppDomain,
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  NoteMutator,
  MutationType,
  NoteType,
  PayloadEmitSource,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
  FeatureStatus,
  NativeFeatureIdentifier,
} from '@standardnotes/snjs'
import { webcrypto } from 'node:crypto'
import { TextEncoder } from 'node:util'
import type { WebApplication } from '@/Application/WebApplication'
import { AssistantTools } from './tools'
import { getAssistantChangeLedger } from './assistantChangeLedger'
import { applyAssistantNoteChange, captureAssistantNoteSnapshot } from './assistantNoteChanges'

jest.mock('@/Components/SuperEditor/Tools/HeadlessSuperConverter', () => ({
  HeadlessSuperConverter: class {
    convertOtherFormatToSuperString(markdown: string) {
      return JSON.stringify({
        root: {
          type: 'root',
          version: 1,
          children: [
            { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text: markdown, format: 0 }] },
          ],
        },
      })
    }
    async convertSuperStringToOtherFormat(text: string) {
      return JSON.parse(text)
        .root.children.map((node: { children: { text: string }[] }) =>
          node.children.map((child) => child.text).join(''),
        )
        .join('\n')
    }
  },
}))

const superText = (text: string) =>
  JSON.stringify({
    root: {
      type: 'root',
      version: 1,
      children: [{ type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text, format: 0 }] }],
    },
  })
function note(title = 'Original', text = 'Before', overrides: Partial<NoteContent> = {}): SNNote {
  return new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid: 'ledger-note',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title, text, noteType: NoteType.Plain, ...overrides }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )
}
function setup(initial = note(), superEntitled = true) {
  let live = initial
  const writes: SNNote[] = []
  const changeItem = jest.fn(
    async (
      _note: SNNote,
      mutate: (mutator: NoteMutator) => void,
      mutation = MutationType.UpdateUserTimestamps,
      _source?: PayloadEmitSource,
    ) => {
      const mutator = new NoteMutator(live, mutation)
      mutate(mutator)
      live = new SNNote(mutator.getResult())
      writes.push(live)
      return live
    },
  )
  const insertItem = jest.fn(async (template: SNNote) => {
    live = template
    writes.push(live)
    return live
  })
  const sync = jest.fn(async () => undefined)
  const application = {
    sessions: { isCurrentSessionReadOnly: () => false, getUser: () => undefined },
    isAuthorizedToRenderItem: () => true,
    vaults: { getItemVault: () => undefined },
    vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
    itemControllerGroup: { itemControllers: [] },
    items: {
      findItem: (uuid: string) => (uuid === live.uuid ? live : undefined),
      getItems: () => [live],
      getSortedTagsForItem: () => [],
      createTemplateItem: (_type: unknown, content: Partial<NoteContent>) => note(content.title, content.text, content),
    },
    mutator: { changeItem, insertItem },
    sync: { sync },
    features: { getFeatureStatus: () => (superEntitled ? FeatureStatus.Entitled : FeatureStatus.NoUserSubscription) },
  } as unknown as WebApplication
  const tools = new AssistantTools(application, {
    confirmBeforeWrite: false,
    requestConfirmation: async () => true,
    presentPane: () => undefined,
    assistantMessageId: 'response-1',
    assistantRunId: 'run-1',
  })
  return {
    application,
    tools,
    changeItem,
    insertItem,
    sync,
    writes,
    get live() {
      return live
    },
    replace: (replacement: SNNote) => {
      live = replacement
    },
  }
}
beforeAll(() => {
  Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder })
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }
})

it('atomically records ordinary title and body edits using actual NoteMutator results and retains prior audit and unrelated appData', async () => {
  const customKey = 'custom-setting' as AppDataField
  const appData = { [DefaultAppDomain]: { [customKey]: { retain: true } }, 'other.example': { unrelated: 'safe' } }
  const initial = note('Original', 'Before', {
    references: [{ uuid: 'linked-note', content_type: ContentType.TYPES.Note }],
    appData,
  })
  const harness = setup(initial)
  await harness.tools.call('notes.update', { uuid: initial.uuid, title: 'Renamed' }, 'title-call')
  const titleRecord = getAssistantChangeLedger(harness.live).records[0]
  expect(titleRecord).toMatchObject({
    source: { toolCallId: 'title-call', assistantMessageId: 'response-1', assistantRunId: 'run-1' },
    operations: [{ summary: 'Updated note title' }],
    undo: { before: captureAssistantNoteSnapshot(initial), after: captureAssistantNoteSnapshot(harness.live) },
  })
  expect(harness.writes[0].getAppDomainValue(customKey)).toEqual({ retain: true })
  expect(getAssistantChangeLedger(harness.writes[0]).records).toHaveLength(1)
  await harness.tools.call('notes.update', { uuid: initial.uuid, text: 'After body' }, 'body-call')
  const ledger = getAssistantChangeLedger(harness.live)
  expect(ledger.records).toHaveLength(2)
  expect(ledger.records[0]).toMatchObject({
    source: { toolCallId: 'body-call' },
    operations: [{ summary: 'Updated note content' }],
    undo: { before: { title: 'Renamed', text: 'Before' }, after: { title: 'Renamed', text: 'After body' } },
  })
  expect(ledger.records[1].changeId).toBe(titleRecord.changeId)
  expect(harness.live.getAppDomainValue(customKey)).toEqual({ retain: true })
  expect(harness.live.payload.content.appData).toMatchObject({ 'other.example': { unrelated: 'safe' } })
  expect(harness.live.references).toEqual(initial.references)
  expect(harness.changeItem).toHaveBeenCalledTimes(2)
  expect(harness.changeItem.mock.calls.every((call) => call[2] === MutationType.UpdateUserTimestamps)).toBe(true)
  expect(harness.changeItem.mock.calls.every((call) => call[3] === PayloadEmitSource.AssistantChanged)).toBe(true)
  expect(harness.sync).toHaveBeenCalledTimes(2)
})

it('does not mutate or append another audit record for an ordinary no-op update', async () => {
  const harness = setup()
  await harness.tools.call('notes.update', { uuid: harness.live.uuid, title: 'Renamed' }, 'first')
  const ledger = getAssistantChangeLedger(harness.live)
  await expect(
    harness.tools.call('notes.update', { uuid: harness.live.uuid, title: 'Renamed', text: 'Before' }, 'noop'),
  ).resolves.toMatchObject({ unchanged: true })
  expect(getAssistantChangeLedger(harness.live)).toEqual(ledger)
  expect(harness.changeItem).toHaveBeenCalledTimes(1)
  expect(harness.sync).toHaveBeenCalledTimes(1)
})

it('records Super title-only changes without rewriting the document and audits explicit full replacement', async () => {
  const original = superText('Original rich body')
  const initial = note('Rich', original, {
    noteType: NoteType.Super,
    editorIdentifier: NativeFeatureIdentifier.TYPES.SuperEditor,
  })
  const harness = setup(initial)
  await harness.tools.call('notes.update', { uuid: initial.uuid, title: 'Rich renamed' }, 'rich-title')
  expect(harness.live.text).toBe(original)
  expect(getAssistantChangeLedger(harness.live).records[0].operations.map((operation) => operation.summary)).toEqual([
    'Updated note title',
  ])
  await harness.tools.call(
    'notes.updateSuper',
    { uuid: initial.uuid, markdown: 'Replacement body', fullReplacement: true },
    'rich-body',
  )
  expect(harness.live.text).toBe(superText('Replacement body'))
  expect(harness.live.noteType).toBe(NoteType.Super)
  expect(harness.live.editorIdentifier).toBe(NativeFeatureIdentifier.TYPES.SuperEditor)
  expect(getAssistantChangeLedger(harness.live).records).toHaveLength(2)
  expect(getAssistantChangeLedger(harness.live).records[0]).toMatchObject({
    source: { toolCallId: 'rich-body' },
    undo: { before: { title: 'Rich renamed', text: original }, after: { text: superText('Replacement body') } },
  })
  await expect(
    harness.tools.call(
      'notes.updateSuper',
      { uuid: initial.uuid, markdown: 'Replacement body', fullReplacement: true },
      'rich-noop',
    ),
  ).resolves.toMatchObject({ unchanged: true })
  expect(getAssistantChangeLedger(harness.live).records).toHaveLength(2)
  expect(harness.changeItem).toHaveBeenCalledTimes(2)
})

it.each([
  { tool: 'notes.create', superEntitled: true, body: { text: 'Created plain' }, expectedSuper: false },
  { tool: 'notes.createSuper', superEntitled: true, body: { markdown: 'Created rich' }, expectedSuper: true },
  { tool: 'notes.createSuper', superEntitled: false, body: { markdown: 'Fallback markdown' }, expectedSuper: false },
])(
  'seeds encrypted creation audit before insertion for $tool (Super entitled $superEntitled)',
  async ({ tool, superEntitled, body, expectedSuper }) => {
    const harness = setup(note(), superEntitled)
    await harness.tools.call(tool, { title: 'Created', ...body }, 'create-call')
    expect(harness.insertItem).toHaveBeenCalledTimes(1)
    expect(harness.changeItem).not.toHaveBeenCalled()
    const inserted = harness.insertItem.mock.calls[0][0]
    expect(inserted).toBe(harness.live)
    expect(inserted.noteType).toBe(expectedSuper ? NoteType.Super : NoteType.Plain)
    const records = getAssistantChangeLedger(inserted).records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      source: { toolCallId: 'create-call' },
      undo: { before: { title: '', text: '' }, after: { title: 'Created', text: inserted.text } },
    })
    expect(records[0].operations.map((operation) => operation.summary)).toContain('Created note content')
  },
)

it('rejects oversized undo metadata before existing-note writes or new-note insertion', async () => {
  const harness = setup()
  await expect(
    harness.tools.call('notes.update', { uuid: harness.live.uuid, text: '€'.repeat(40000) }, 'oversize-update'),
  ).rejects.toThrow(/encrypted undo record/)
  await expect(
    harness.tools.call('notes.create', { title: 'Huge', text: '€'.repeat(40000) }, 'oversize-create'),
  ).rejects.toThrow(/encrypted undo record/)
  expect(harness.changeItem).not.toHaveBeenCalled()
  expect(harness.insertItem).not.toHaveBeenCalled()
  expect(getAssistantChangeLedger(harness.live).records).toEqual([])
})

it('uses actual before snapshots for guarded undo and rejects undo after a newer user change', async () => {
  const initial = note('Before title', 'Before body')
  const harness = setup(initial)
  await harness.tools.call(
    'notes.update',
    { uuid: initial.uuid, title: 'After title', text: 'After body' },
    'undo-call',
  )
  const change = getAssistantChangeLedger(harness.live).records[0].undo
  await expect(applyAssistantNoteChange(harness.application, change, 'undo')).resolves.toMatchObject({
    position: 'before',
    alreadyApplied: false,
  })
  expect(captureAssistantNoteSnapshot(harness.live)).toEqual(captureAssistantNoteSnapshot(initial))
  await applyAssistantNoteChange(harness.application, change, 'redo')
  const mutator = new NoteMutator(harness.live, MutationType.UpdateUserTimestamps)
  mutator.text = 'Newer manual edit'
  harness.replace(new SNNote(mutator.getResult()))
  const writes = harness.changeItem.mock.calls.length
  await expect(applyAssistantNoteChange(harness.application, change, 'undo')).rejects.toThrow('note changed again')
  expect(harness.changeItem).toHaveBeenCalledTimes(writes)
  expect(harness.live.text).toBe('Newer manual edit')
})
