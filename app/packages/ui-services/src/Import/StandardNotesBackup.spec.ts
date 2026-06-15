import { isStandardNotesBackupContent } from './Importer'

describe('isStandardNotesBackupContent', () => {
  it('detects a decrypted Standard Notes backup', () => {
    const backup = JSON.stringify({
      version: '004',
      items: [
        { uuid: 'a', content_type: 'Note', content: { title: 'A', text: 'x' } },
        { uuid: 'b', content_type: 'Tag', content: { title: 'T' } },
      ],
    })
    expect(isStandardNotesBackupContent(backup)).toBe(true)
  })

  it('detects an encrypted Standard Notes backup', () => {
    const backup = JSON.stringify({
      version: '004',
      keyParams: { version: '004', identifier: 'u@x.com' },
      items: [{ uuid: 'a', content_type: 'Note', content: '004:...:...', enc_item_key: '...' }],
    })
    expect(isStandardNotesBackupContent(backup)).toBe(true)
  })

  it('accepts an empty backup (items present but empty)', () => {
    expect(isStandardNotesBackupContent(JSON.stringify({ items: [] }))).toBe(true)
  })

  it('rejects plaintext / non-JSON', () => {
    expect(isStandardNotesBackupContent('just some note text')).toBe(false)
    expect(isStandardNotesBackupContent('# A markdown note\n\n- todo')).toBe(false)
  })

  it('rejects JSON that is not a backup', () => {
    expect(isStandardNotesBackupContent(JSON.stringify({ foo: 'bar' }))).toBe(false)
    expect(isStandardNotesBackupContent(JSON.stringify([1, 2, 3]))).toBe(false)
    expect(isStandardNotesBackupContent(JSON.stringify({ items: 'not-an-array' }))).toBe(false)
    // A Super-note export is a different shape (no top-level items array).
    expect(isStandardNotesBackupContent(JSON.stringify({ root: { children: [] } }))).toBe(false)
  })
})
