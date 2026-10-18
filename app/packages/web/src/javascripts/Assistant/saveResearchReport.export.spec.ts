import {
  ContentType,
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { saveResearchReport } from './saveResearchReport'
jest.mock('@/Components/SuperEditor/Tools/HeadlessSuperConverter', () => ({ HeadlessSuperConverter: class {} }))
function harness() {
  let userUuid = 'account-a'
  const saved = new Map<string, SNNote>()
  const items = {
    createTemplateItem: (_type: string, content: NoteContent) =>
      new SNNote(
        new DecryptedPayload<NoteContent>(
          {
            uuid: 'exported-note',
            content_type: ContentType.TYPES.Note,
            content: FillItemContent(content),
            ...PayloadTimestampDefaults(),
          },
          PayloadSource.Constructor,
        ),
      ),
    findItem: (uuid: string) => saved.get(uuid),
  }
  const mutator = {
    insertItem: jest.fn(async (note: SNNote) => {
      saved.set(note.uuid, note)
      return note
    }),
    setItemToBeDeleted: jest.fn(async (note: SNNote) => {
      saved.delete(note.uuid)
    }),
  }
  const application = {
    items,
    mutator,
    sessions: { isSignedIn: () => true, getUser: () => ({ uuid: userUuid }), isCurrentSessionReadOnly: () => false },
  } as unknown as WebApplication
  return {
    application,
    items,
    mutator,
    saved,
    changeAccount: () => {
      userUuid = 'account-b'
    },
  }
}
it('exports a full large report through real note construction, without reversible tool truncation', async () => {
  const h = harness()
  const report =
    '# Findings\n' +
    'Research findings. '.repeat(5000) +
    '\n## Sources\n' +
    Array.from({ length: 600 }, (_, index) => `- [Source ${index}](https://example.com/${index})`).join('\n')
  expect(report.length).toBeGreaterThan(85_000)
  const uuid = await saveResearchReport(h.application, {
    report,
    reportId: 'report',
    target: { kind: 'new', title: 'Findings' },
  })
  expect(h.saved.get(uuid)).toBeInstanceOf(SNNote)
  expect(h.saved.get(uuid)?.text).toBe(report)
  expect(h.saved.get(uuid)?.title).toBe('Findings')
  expect(h.mutator.setItemToBeDeleted).not.toHaveBeenCalled()
})
it('compensates insertion using captured services if account changes during save', async () => {
  const h = harness()
  const nextAccountDelete = jest.fn()
  h.mutator.insertItem.mockImplementationOnce(async (note) => {
    h.saved.set(note.uuid, note)
    h.changeAccount()
    Object.assign(h.application, { mutator: { setItemToBeDeleted: nextAccountDelete } })
    return note
  })
  await expect(
    saveResearchReport(h.application, {
      report: 'Private report',
      reportId: 'report',
      target: { kind: 'new', title: 'Findings' },
    }),
  ).rejects.toThrow('account changed')
  expect(h.saved.size).toBe(0)
  expect(h.mutator.setItemToBeDeleted).toHaveBeenCalledTimes(1)
  expect(nextAccountDelete).not.toHaveBeenCalled()
})
it('removes partially inserted exports on persistence failure', async () => {
  const h = harness()
  h.mutator.insertItem.mockImplementationOnce(async (note) => {
    h.saved.set(note.uuid, note)
    throw new Error('storage failed')
  })
  await expect(
    saveResearchReport(h.application, { report: 'Report', reportId: 'report', target: { kind: 'new', title: '' } }),
  ).rejects.toThrow('storage failed')
  expect(h.saved.size).toBe(0)
})
it('does not create an export in a read-only session', async () => {
  const h = harness()
  h.application.sessions.isCurrentSessionReadOnly = () => true
  await expect(
    saveResearchReport(h.application, { report: 'Report', reportId: 'report', target: { kind: 'new', title: '' } }),
  ).rejects.toThrow('read-only')
  expect(h.mutator.insertItem).not.toHaveBeenCalled()
})
