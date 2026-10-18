import { NoteType } from '@standardnotes/features'
import { ContentType } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { saveResearchReport } from './saveResearchReport'
const mockCall = jest.fn()
const mockContext = jest.fn()
jest.mock('./assistantSuperNotePatch', () => ({ assistantSuperRevision: async () => ({ contentHash: 'snapshot' }) }))
jest.mock('./tools', () => ({
  AssistantTools: class {
    constructor(_app: unknown, context: unknown) {
      mockContext(context)
    }
    call = mockCall
  },
}))
jest.mock('./assistantNoteChanges', () => ({
  flushAssistantNoteEditors: jest.fn(async () => {}),
  captureAssistantNoteSnapshot: (note: unknown) => note,
}))
const note = {
  uuid: 'note-1',
  content_type: ContentType.TYPES.Note,
  text: 'Existing text',
  title: 'Existing',
  noteType: 'plain',
}
const app = () =>
  ({
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: 'user-1' }) },
    items: { findItem: () => note },
    isAuthorizedToRenderItem: () => true,
  }) as unknown as WebApplication
beforeEach(() => {
  mockCall.mockReset()
  mockContext.mockReset()
})
it('appends without replacing existing plain text and authorizes only the selected note', async () => {
  mockCall.mockResolvedValue({ ok: true, note: { uuid: 'note-1' } })
  await saveResearchReport(app(), {
    report: 'Findings [1]',
    reportId: 'report',
    target: { kind: 'existing', noteUuid: 'note-1' },
  })
  expect(mockCall).toHaveBeenCalledWith('notes.update', { uuid: 'note-1', text: 'Existing text\n\nFindings [1]' })
  expect([...mockContext.mock.calls[0][0].selectedNoteUuids]).toEqual(['note-1'])
  expect(mockContext.mock.calls[0][0].expectedNoteSnapshots.has('note-1')).toBe(true)
})
it('reports a conflict instead of claiming a save or creating a fallback note', async () => {
  mockCall.mockResolvedValue({ ok: false, status: 'conflict', reason: 'Note changed' })
  await expect(
    saveResearchReport(app(), {
      report: 'Findings',
      reportId: 'report',
      target: { kind: 'existing', noteUuid: 'note-1' },
    }),
  ).rejects.toThrow('Note changed')
  expect(mockCall).toHaveBeenCalledTimes(1)
})
it('refuses inaccessible notes and cancelled saves before tools', async () => {
  const application = app()
  application.isAuthorizedToRenderItem = () => false
  await expect(
    saveResearchReport(application, {
      report: 'Findings',
      reportId: 'report',
      target: { kind: 'existing', noteUuid: 'note-1' },
    }),
  ).rejects.toThrow('not available')
  const signal = AbortSignal.abort()
  await expect(
    saveResearchReport(app(), { report: 'Findings', reportId: 'report', target: { kind: 'new', title: '' } }, signal),
  ).rejects.toThrow('cancelled')
  expect(mockCall).not.toHaveBeenCalled()
})

it('appends at the last rich block with a fresh matching revision and preserves report Markdown', async () => {
  const application = app()
  const rich = {
    ...note,
    noteType: NoteType.Super,
    text: JSON.stringify({ root: { children: [{ type: 'paragraph' }, { type: 'mermaid', code: 'graph TD' }] } }),
  }
  application.items.findItem = jest.fn(() => rich) as never
  mockCall
    .mockResolvedValueOnce({ revision: { contentHash: 'snapshot' } })
    .mockResolvedValueOnce({ ok: true, note: { uuid: note.uuid } })
  await saveResearchReport(application, {
    report: '## Findings\n[Source](https://example.com)',
    reportId: 'report',
    target: { kind: 'existing', noteUuid: note.uuid },
  })
  expect(mockCall.mock.calls[1]).toEqual([
    'notes.patchBlocks',
    {
      uuid: note.uuid,
      base: { contentHash: 'snapshot' },
      operations: [
        {
          type: 'insert',
          position: 'after',
          target: { path: [1] },
          block: { kind: 'markdown-fragment', markdown: '## Findings\n[Source](https://example.com)' },
        },
      ],
    },
  ])
})
it('refuses mismatched rich snapshots and oversized append without truncating', async () => {
  const application = app()
  application.items.findItem = jest.fn(() => ({
    ...note,
    noteType: NoteType.Super,
    text: '{"root":{"children":[]}}',
  })) as never
  mockCall.mockResolvedValue({ revision: { contentHash: 'different' } })
  await expect(
    saveResearchReport(application, {
      report: 'Findings',
      reportId: 'report',
      target: { kind: 'existing', noteUuid: note.uuid },
    }),
  ).rejects.toThrow('note changed')
  expect(mockCall).toHaveBeenCalledTimes(1)
  mockCall.mockClear()
  await expect(
    saveResearchReport(application, {
      report: 'x'.repeat(16385),
      reportId: 'report',
      target: { kind: 'existing', noteUuid: note.uuid },
    }),
  ).rejects.toThrow('new note instead')
  expect(mockCall).not.toHaveBeenCalled()
})
