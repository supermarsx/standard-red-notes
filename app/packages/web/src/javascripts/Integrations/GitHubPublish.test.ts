import { parseOwnerRepo, sanitizeFileName, sanitizeRepoPath } from './GitHubPublish'

describe('sanitizeFileName', () => {
  it('appends a single .md extension and preserves title case', () => {
    expect(sanitizeFileName('My Note')).toBe('My-Note.md')
    expect(sanitizeFileName('Already.md')).toBe('Already.md')
    // A differently-cased extension still counts as already having one.
    expect(sanitizeFileName('Already.MD')).toBe('Already.MD')
  })

  it('replaces path separators and illegal characters with dashes', () => {
    expect(sanitizeFileName('a/b:c*d?')).toBe('a-b-c-d.md')
    expect(sanitizeFileName('weird<>|name')).toBe('weird-name.md')
  })

  it('collapses whitespace and trims leading/trailing separators', () => {
    expect(sanitizeFileName('  spaced   out  ')).toBe('spaced-out.md')
    expect(sanitizeFileName('--edge--')).toBe('edge.md')
  })

  it('falls back to untitled.md when nothing usable remains', () => {
    expect(sanitizeFileName('')).toBe('untitled.md')
    expect(sanitizeFileName('///')).toBe('untitled.md')
  })
})

describe('sanitizeRepoPath', () => {
  it('strips leading slashes and traversal segments', () => {
    expect(sanitizeRepoPath('/notes/../x/note.md')).toBe('notes/x/note.md')
    expect(sanitizeRepoPath('./a/./b')).toBe('a/b')
  })

  it('normalizes backslashes and collapses empty segments', () => {
    expect(sanitizeRepoPath('notes\\\\sub')).toBe('notes/sub')
    expect(sanitizeRepoPath('a//b///c')).toBe('a/b/c')
  })
})

describe('parseOwnerRepo', () => {
  it('parses owner/repo', () => {
    expect(parseOwnerRepo('octocat/notes')).toEqual({ owner: 'octocat', repo: 'notes' })
  })

  it('strips a github.com URL prefix and a .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/octocat/notes.git')).toEqual({ owner: 'octocat', repo: 'notes' })
  })

  it('returns null for malformed input', () => {
    expect(parseOwnerRepo('octocat')).toBeNull()
    expect(parseOwnerRepo('a/b/c')).toBeNull()
    expect(parseOwnerRepo('bad owner/repo')).toBeNull()
  })
})
