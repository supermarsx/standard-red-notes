// Standard Red Notes: client side of the optional, server-mediated
// "Publish note to GitHub" feature.
//
// PRIVACY: publishing converts the note to Markdown (decrypted) and POSTs it,
// together with a GitHub Personal Access Token, to OUR server, which forwards
// both to GitHub. The published copy is stored UNENCRYPTED in the repo and the
// server sees the plaintext and the PAT in transit. This removes the end-to-end
// encryption guarantee for whatever is published. The modal surfaces this; this
// module only performs the action the user explicitly requested.

import { FileItem, NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { HeadlessSuperConverter } from '@/Components/SuperEditor/Tools/HeadlessSuperConverter'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'

const headlessSuperConverter = new HeadlessSuperConverter()

export const PUBLISH_ENDPOINT = '/v1/integrations/github/publish'

export interface GitHubPublishParams {
  token: string
  owner: string
  repo: string
  branch: string
  path: string
  message: string
  content: string
}

export interface GitHubPublishOk {
  ok: true
  created: boolean
  path: string
  contentUrl?: string
  commitUrl?: string
}

export interface GitHubPublishError {
  ok: false
  message: string
  tag?: string
}

export type GitHubPublishOutcome = GitHubPublishOk | GitHubPublishError

/**
 * Converts a note to Markdown for publishing.
 *  - Super notes: rendered to real Markdown via the headless Super converter
 *    (tables, headings, lists, etc. are preserved as Markdown).
 *  - Everything else: the note text IS Markdown/plain text already, so we use
 *    its extracted plaintext as-is.
 *
 * Returns the chosen `source` so callers/tests can assert which path ran.
 */
export async function noteToMarkdown(
  application: WebApplication,
  note: SNNote,
): Promise<{ markdown: string; source: 'super' | 'plaintext' }> {
  if (note.noteType === NoteType.Super && note.text && note.text.length > 0) {
    const markdown = await headlessSuperConverter.convertSuperStringToOtherFormat(note.text, 'md', {
      embedBehavior: 'reference',
      getFileItem: (id) => application.items.findItem<FileItem>(id),
    })
    return { markdown, source: 'super' }
  }

  return { markdown: extractPlaintextFromNoteText(note.text ?? '', note.noteType), source: 'plaintext' }
}

/**
 * Derives a safe repo file path from a note title:
 *  - strips characters illegal in paths / problematic on GitHub,
 *  - collapses whitespace to single dashes,
 *  - trims, lowercases nothing (titles can stay mixed case),
 *  - ensures a single trailing `.md`,
 *  - falls back to `untitled.md` when nothing usable remains.
 */
export function sanitizeFileName(title: string): string {
  const base = (title || '')
    .trim()
    // Replace path separators and characters GitHub/most filesystems dislike.
    .replace(/[\\/:*?"<>|]+/g, ' ')
    // Drop control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  const name = base.length > 0 ? base : 'untitled'
  // Avoid doubling an existing .md the user may have typed into a title.
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`
}

/**
 * Normalizes a user-entered repo path: trims, removes leading slashes, drops
 * `.`/`..` traversal segments. Mirrors the server-side guard so the UI shows the
 * effective path. Returns '' when nothing usable remains.
 */
export function sanitizeRepoPath(rawPath: string): string {
  return (rawPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/')
}

/** Parses an "owner/repo" string. Returns null when it isn't well formed. */
export function parseOwnerRepo(value: string): { owner: string; repo: string } | null {
  const trimmed = (value || '').trim().replace(/^https?:\/\/github\.com\//i, '')
  const match = trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/)
  if (!match) {
    return null
  }
  return { owner: match[1], repo: match[2] }
}

/**
 * Performs the authenticated POST to the server publish endpoint and maps the
 * response into a discriminated outcome. The PAT and content live only in the
 * request body; nothing is logged here.
 */
export async function publishNoteToGitHub(
  application: WebApplication,
  params: GitHubPublishParams,
  signal?: AbortSignal,
): Promise<GitHubPublishOutcome> {
  try {
    const { status, ok, data } = await application.serverJsonRequest<{
      created?: boolean
      path?: string
      contentUrl?: string
      commitUrl?: string
      error?: { message?: string; tag?: string }
    }>(PUBLISH_ENDPOINT, params, signal)

    if (ok) {
      return {
        ok: true,
        created: Boolean(data.created),
        path: data.path ?? params.path,
        contentUrl: data.contentUrl,
        commitUrl: data.commitUrl,
      }
    }

    return {
      ok: false,
      tag: data.error?.tag,
      message: data.error?.message ?? `Publishing failed (status ${status}).`,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
