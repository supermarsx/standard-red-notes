import { NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import {
  noteToMarkdown,
  parseOwnerRepo,
  publishNoteToGitHub,
  PUBLISH_ENDPOINT,
  sanitizeFileName,
  sanitizeRepoPath,
} from './GitHubPublish'

/**
 * Standard Red Notes: tests for the "Publish note to GitHub" client.
 *
 * Covers the pure path/name/owner-repo sanitizers, the markdown conversion branch
 * selection (super vs plaintext), and the publish request -> outcome mapping
 * (success / server-error / thrown). The Super converter and plaintext extractor
 * are mocked so noteToMarkdown is deterministic without lexical/headless deps.
 */

// NOTE: jest.config sets resetMocks: true, which would wipe a jest.fn()'s
// mockResolvedValue before each test. Use a plain async method so the stub
// survives the per-test reset.
jest.mock('@/Components/SuperEditor/Tools/HeadlessSuperConverter', () => ({
  HeadlessSuperConverter: class {
    async convertSuperStringToOtherFormat() {
      return '# Super Markdown'
    }
  },
}))

jest.mock('@/Utils/NoteStats', () => ({
  extractPlaintextFromNoteText: (text: string) => `plain:${text}`,
}))

describe('sanitizeFileName', () => {
  it('replaces illegal characters and collapses whitespace to dashes (case preserved)', () => {
    expect(sanitizeFileName('My: Note/Title?')).toBe('My-Note-Title.md')
  })

  it('falls back to untitled.md for empty/only-illegal input', () => {
    expect(sanitizeFileName('')).toBe('untitled.md')
    expect(sanitizeFileName('   ')).toBe('untitled.md')
    expect(sanitizeFileName('///')).toBe('untitled.md')
  })

  it('does not double an existing .md extension (case-insensitive check, case preserved)', () => {
    expect(sanitizeFileName('notes.md')).toBe('notes.md')
    expect(sanitizeFileName('Notes.MD')).toBe('Notes.MD')
  })

  it('trims leading/trailing dots and dashes', () => {
    expect(sanitizeFileName('..hidden..')).toBe('hidden.md')
    expect(sanitizeFileName('-edge-')).toBe('edge.md')
  })

  it('appends .md to a plain title', () => {
    expect(sanitizeFileName('Hello World')).toBe('Hello-World.md')
  })
})

describe('sanitizeRepoPath', () => {
  it('removes leading slashes and traversal segments', () => {
    expect(sanitizeRepoPath('/notes/../docs/./a')).toBe('notes/docs/a')
  })

  it('normalizes backslashes to forward slashes', () => {
    expect(sanitizeRepoPath('notes\\sub\\a')).toBe('notes/sub/a')
  })

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeRepoPath('/../.')).toBe('')
    expect(sanitizeRepoPath('')).toBe('')
  })

  it('trims whitespace around segments and drops empty ones', () => {
    expect(sanitizeRepoPath('  a / / b ')).toBe('a/b')
  })
})

describe('parseOwnerRepo', () => {
  it('parses a plain owner/repo', () => {
    expect(parseOwnerRepo('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' })
  })

  it('strips a github.com URL prefix and a .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/octocat/Hello.git')).toEqual({
      owner: 'octocat',
      repo: 'Hello',
    })
  })

  it('returns null for malformed input', () => {
    expect(parseOwnerRepo('not-a-repo')).toBeNull()
    expect(parseOwnerRepo('owner/repo/extra')).toBeNull()
    expect(parseOwnerRepo('')).toBeNull()
  })
})

describe('noteToMarkdown', () => {
  const makeApp = () => ({ items: { findItem: jest.fn() } }) as unknown as WebApplication

  it('uses the Super converter for non-empty Super notes', async () => {
    const note = { noteType: NoteType.Super, text: '{"root":{}}' } as unknown as SNNote
    const result = await noteToMarkdown(makeApp(), note)
    expect(result).toEqual({ markdown: '# Super Markdown', source: 'super' })
  })

  it('uses extracted plaintext for non-Super notes', async () => {
    const note = { noteType: undefined, text: 'hello' } as unknown as SNNote
    const result = await noteToMarkdown(makeApp(), note)
    expect(result).toEqual({ markdown: 'plain:hello', source: 'plaintext' })
  })

  it('uses plaintext for a Super note with empty text', async () => {
    const note = { noteType: NoteType.Super, text: '' } as unknown as SNNote
    const result = await noteToMarkdown(makeApp(), note)
    expect(result.source).toBe('plaintext')
  })
})

describe('publishNoteToGitHub', () => {
  const params = {
    token: 't',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    path: 'notes/a.md',
    message: 'msg',
    content: '# Hi',
  }

  const makeApp = (serverJsonRequest: jest.Mock) =>
    ({ serverJsonRequest }) as unknown as WebApplication

  it('maps a successful response to an ok outcome', async () => {
    const req = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { created: true, path: 'notes/a.md', contentUrl: 'c', commitUrl: 'm' },
    })
    const result = await publishNoteToGitHub(makeApp(req), params)
    expect(req).toHaveBeenCalledWith(PUBLISH_ENDPOINT, params, undefined)
    expect(result).toEqual({ ok: true, created: true, path: 'notes/a.md', contentUrl: 'c', commitUrl: 'm' })
  })

  it('falls back to the request path when the response omits it', async () => {
    const req = jest.fn().mockResolvedValue({ ok: true, status: 200, data: {} })
    const result = await publishNoteToGitHub(makeApp(req), params)
    expect(result).toMatchObject({ ok: true, created: false, path: 'notes/a.md' })
  })

  it('maps a server error response to an error outcome with tag/message', async () => {
    const req = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      data: { error: { message: 'bad token', tag: 'auth' } },
    })
    const result = await publishNoteToGitHub(makeApp(req), params)
    expect(result).toEqual({ ok: false, tag: 'auth', message: 'bad token' })
  })

  it('synthesizes a message from status when the error body lacks one', async () => {
    const req = jest.fn().mockResolvedValue({ ok: false, status: 500, data: {} })
    const result = await publishNoteToGitHub(makeApp(req), params)
    expect(result).toEqual({ ok: false, tag: undefined, message: 'Publishing failed (status 500).' })
  })

  it('maps a thrown error to an error outcome', async () => {
    const req = jest.fn().mockRejectedValue(new Error('network down'))
    const result = await publishNoteToGitHub(makeApp(req), params)
    expect(result).toEqual({ ok: false, message: 'network down' })
  })
})
