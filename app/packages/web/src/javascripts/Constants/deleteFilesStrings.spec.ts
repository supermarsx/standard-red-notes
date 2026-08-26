import { StringUtils } from './Strings'

describe('permanent file deletion confirmation', () => {
  it('names the exact number of files so a large accidental selection is visible', () => {
    expect(StringUtils.deleteFiles(12)).toContain('12 files')
    expect(StringUtils.deleteFiles(2)).toContain('2 files')
  })

  it('is honest that the deletion cannot be recovered', () => {
    const text = StringUtils.deleteFiles(3)

    expect(text).toContain('cannot be undone')
    expect(text).toContain('not moved to the trash')
    expect(text).toContain('cannot be recovered')
  })

  it('says the same about a single file', () => {
    expect(StringUtils.deleteFile('notes.txt')).toContain('cannot be undone')
  })
})
