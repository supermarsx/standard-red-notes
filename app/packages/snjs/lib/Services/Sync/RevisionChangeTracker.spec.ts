import { RevisionChangeTracker } from './RevisionChangeTracker'

const note = (text = 'body', timestamp = 1) => ({
  uuid: 'note',
  content_type: 'Note',
  updated_at_timestamp: timestamp,
  content: {
    title: 'Title',
    text,
    appData: { 'org.standardnotes.sn': { client_updated_at: 'first', collaborationRevision: { v: 1 } } },
  },
})
const upload = () => ({ uuid: 'note', content_type: 'Note', content: 'ciphertext' })
describe('revision significance without plaintext server metadata', () => {
  it('marks metadata-only changes but preserves body, title, and collaborative comment changes', () => {
    const tracker = new RevisionChangeTracker()
    tracker.observe(note())
    const metadata = note()
    metadata.content.appData['org.standardnotes.sn'].client_updated_at = 'later'
    metadata.content.appData['org.standardnotes.sn'].collaborationRevision.v = 2
    Object.assign(metadata.content.appData['org.standardnotes.sn'], { pinned: true, archived: true, locked: true })
    expect(tracker.prepare(metadata, upload())).toBe('metadata')
    expect(tracker.prepare(note('changed'), upload())).toBe('automatic')
    expect(tracker.prepare({ ...metadata, content: { ...metadata.content, title: 'Renamed' } }, upload())).toBe(
      'automatic',
    )
    expect(
      tracker.prepare(
        { ...metadata, content: { ...metadata.content, appData: { comments: ['new comment'] } } },
        upload(),
      ),
    ).toBe('automatic')
    const wire = upload()
    tracker.prepare(metadata, wire)
    expect(wire).toEqual({ uuid: 'note', content_type: 'Note', content: 'ciphertext' })
  })
  it('does not suppress unacknowledged edits after a failed save or another metadata edit', () => {
    const tracker = new RevisionChangeTracker()
    tracker.observe(note())
    const changed = note('changed')
    expect(tracker.prepare(changed, upload())).toBe('automatic')
    expect(tracker.prepare(changed, upload())).toBe('automatic')
    tracker.acknowledge([upload()], [{ uuid: 'other', updated_at_timestamp: 2 }])
    expect(tracker.prepare(changed, upload())).toBe('automatic')
    const sent = upload()
    tracker.prepare(changed, sent)
    tracker.acknowledge([sent], [{ uuid: 'note', updated_at_timestamp: 2 }])
    expect(tracker.prepare(changed, upload())).toBe('metadata')
  })
  it('associates exact uploads despite equal base timestamps and ignores stale responses', () => {
    const tracker = new RevisionChangeTracker()
    const older = upload(),
      newer = upload()
    tracker.prepare(note('older'), older)
    tracker.prepare(note('newer'), newer)
    tracker.acknowledge([newer], [{ uuid: 'note', updated_at_timestamp: 30 }])
    tracker.acknowledge([older], [{ uuid: 'note', updated_at_timestamp: 20 }])
    tracker.observe(note('stale download', 10))
    expect(tracker.prepare(note('newer'), upload())).toBe('metadata')
    expect(tracker.prepare(note('older'), upload())).toBe('automatic')
  })
  it('is conservative for unknown, oversized, recovered uploads and after teardown', () => {
    const tracker = new RevisionChangeTracker()
    expect(tracker.prepare(note(), upload())).toBe('automatic')
    tracker.observe(note('x'.repeat(70000)))
    expect(tracker.prepare(note('x'.repeat(70000)), upload())).toBe('automatic')
    expect(tracker.prepare({ ...note(), deleted: true }, upload())).toBeUndefined()
    tracker.acknowledge([upload()], [{ uuid: 'note', updated_at_timestamp: 2 }])
    expect(tracker.prepare(note(), upload())).toBe('automatic')
    tracker.observe(note())
    tracker.clear()
    expect(tracker.prepare(note(), upload())).toBe('automatic')
  })
})
