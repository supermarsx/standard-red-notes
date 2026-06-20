// AI-driven "auto-organize": proposes a folder + tag structure for the current note
// or for the whole library, the user reviews a preview, and only on explicit confirm
// is it applied. NOTHING here mutates the app or hits the network on its own — the
// prompt-building, digest-building, and response-parsing are PURE functions of their
// inputs so they can be unit-tested without a WebApplication. The model call reuses
// the same one-shot provider layer as the editor's selection actions, AI-tags, and
// narration (see selectionActions.ts -> runOneShotCompletion).
//
// Safety model: organizing is ADDITIVE. We only create folders/tags and add folder
// membership / tag links. We never trash, delete, or strip existing tags. For large
// libraries we cap how many notes we send to the model and report the cap to the UI.

import { WebApplication } from '@/Application/WebApplication'
import { runOneShotCompletion } from './selectionActions'

/** ~4 chars per token; 16k chars (~4k tokens) of digest is a conservative cap for the all-notes plan. */
export const DEFAULT_ORGANIZE_BUDGET = 16_000

/** Hard cap on how many notes we ever include in an all-notes digest, regardless of budget. */
export const DEFAULT_MAX_NOTES = 200

/** Max characters of a single note's snippet inside the all-notes digest. */
export const MAX_SNIPPET_CHARS = 280

/** Max folders / tags we accept from a plan, and max tags per note. */
export const MAX_PLAN_FOLDERS = 40
export const MAX_PLAN_TAGS = 60
export const MAX_TAGS_PER_NOTE = 5

/** Max characters of a single folder/tag name (junk guard). */
export const MAX_NAME_LENGTH = 60

/** A single note to consider, as fed into the digest. */
export interface OrganizeNoteInput {
  /** Stable id the model echoes back in its plan. Caller maps this to a real note. */
  id: string
  title: string
  /** Already plain text (Super notes extracted best-effort before they reach here). */
  plaintext: string
}

/** Result of building the budgeted all-notes digest. */
export interface OrganizeDigest {
  /** The text block to send to the model. */
  text: string
  /** Ids actually included (after the cap + budget cut). Order preserved. */
  includedIds: string[]
  /** Number of notes included. */
  includedCount: number
  /** Number of notes dropped because of the note cap or the char budget. */
  omittedCount: number
}

const normalize = (value: string): string => (value ?? '').replace(/\r\n?/g, '\n').trim()

const clampName = (value: string): string => {
  const cleaned = normalize(value).replace(/\s+/g, ' ')
  return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH).trim() : cleaned
}

const snippet = (plaintext: string, max = MAX_SNIPPET_CHARS): string => {
  const body = normalize(plaintext).replace(/\s+/g, ' ')
  if (body.length <= max) {
    return body
  }
  return `${body.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Build a budgeted digest of notes for the all-notes plan. PURE.
 *
 * - Caps the number of notes at `maxNotes` (extras counted as omitted).
 * - Each included note contributes `[id] Title — snippet`, snippet capped at
 *   MAX_SNIPPET_CHARS, and the whole block is capped at `budget` chars; once the
 *   budget is hit remaining notes are dropped and counted as omitted.
 */
export function buildOrganizeDigest(
  notes: OrganizeNoteInput[],
  options: { budget?: number; maxNotes?: number } = {},
): OrganizeDigest {
  const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : DEFAULT_ORGANIZE_BUDGET
  const maxNotes = options.maxNotes && options.maxNotes > 0 ? Math.floor(options.maxNotes) : DEFAULT_MAX_NOTES

  const cleaned = (notes ?? [])
    .filter((note): note is OrganizeNoteInput => !!note && typeof note.id === 'string' && note.id.length > 0)
    .map((note) => ({
      id: note.id,
      title: clampName(note.title ?? '') || 'Untitled note',
      snippet: snippet(note.plaintext ?? ''),
    }))

  // Apply the note-count cap first; everything past it is omitted before we even
  // consider the char budget.
  const capped = cleaned.slice(0, maxNotes)
  let omittedCount = cleaned.length - capped.length

  const lines: string[] = []
  const includedIds: string[] = []
  let used = 0
  for (const note of capped) {
    const line = note.snippet ? `[${note.id}] ${note.title} — ${note.snippet}` : `[${note.id}] ${note.title}`
    if (used + line.length + 1 > budget && lines.length > 0) {
      omittedCount += 1
      continue
    }
    lines.push(line)
    includedIds.push(note.id)
    used += line.length + 1
  }

  return {
    text: lines.join('\n'),
    includedIds,
    includedCount: includedIds.length,
    omittedCount,
  }
}

const ALL_NOTES_SYSTEM_PROMPT =
  'You are an organization assistant for a note-taking app. You are given a list of notes, each prefixed with an ' +
  'id in square brackets like [n3]. Propose a clean folder structure and a small set of topic tags, and assign ' +
  'each note to exactly one folder plus zero or more tags. Prefer reusing the user\'s existing folders and tags ' +
  '(listed below) over inventing near-duplicates. Reply with ONLY a JSON object of the shape: ' +
  '{"folders":["Work","Personal"],"tags":["budget","travel"],"assignments":[{"id":"n3","folder":"Work","tags":["budget"]}]}. ' +
  'Use the exact ids from the list. Do not include notes you were not given. ' +
  'No preamble, no explanation, no markdown code fences.'

const CURRENT_NOTE_SYSTEM_PROMPT =
  'You are an organization assistant for a note-taking app. Given a single note, propose ONE folder for it (reuse ' +
  'an existing folder when one fits, otherwise suggest a new one) and up to a few topic tags. Prefer reusing the ' +
  "user's existing folders and tags over inventing near-duplicates. Reply with ONLY a JSON object of the shape: " +
  '{"folder":"Work","tags":["budget","travel"]}. No preamble, no explanation, no markdown code fences.'

const existingBlock = (label: string, names: string[]): string => {
  const cleaned = (names ?? []).map((n) => clampName(n)).filter((n) => n.length > 0)
  if (cleaned.length === 0) {
    return `The user has no existing ${label} yet.\n`
  }
  return `Existing ${label} (reuse an exact match when it fits):\n${cleaned.map((n) => `- ${n}`).join('\n')}\n`
}

/** Build the {system,user} messages for the all-notes plan. PURE. */
export function buildAllNotesPrompt(input: {
  digest: string
  existingFolders: string[]
  existingTags: string[]
}): { system: string; user: string } {
  const user =
    'Organize the following notes.\n\n' +
    existingBlock('folders', input.existingFolders) +
    '\n' +
    existingBlock('tags', input.existingTags) +
    `\nNotes:\n${input.digest}`
  return { system: ALL_NOTES_SYSTEM_PROMPT, user }
}

/** Build the {system,user} messages for the current-note plan. PURE. */
export function buildCurrentNotePrompt(input: {
  title: string
  plaintext: string
  existingFolders: string[]
  existingTags: string[]
}): { system: string; user: string } {
  const title = clampName(input.title ?? '')
  const body = snippet(input.plaintext ?? '', DEFAULT_ORGANIZE_BUDGET)
  const titleBlock = title ? `Title: ${title}\n\n` : ''
  const user =
    'Suggest a folder and tags for the following note.\n\n' +
    existingBlock('folders', input.existingFolders) +
    '\n' +
    existingBlock('tags', input.existingTags) +
    `\n${titleBlock}Note:\n---\n${body}`
  return { system: CURRENT_NOTE_SYSTEM_PROMPT, user }
}

/** A per-note assignment in a parsed plan. */
export interface ParsedAssignment {
  id: string
  /** Folder name (may be empty meaning "no folder"). */
  folder: string
  tags: string[]
}

/** A parsed, validated all-notes plan. */
export interface ParsedPlan {
  /** All folder names referenced (deduped, validated). */
  folders: string[]
  /** All tag names referenced (deduped, validated). */
  tags: string[]
  /** Per-note assignments, filtered to ids the caller actually sent. */
  assignments: ParsedAssignment[]
}

/** A parsed current-note plan. */
export interface ParsedCurrentNotePlan {
  /** Proposed folder name, or '' for none. */
  folder: string
  tags: string[]
}

/**
 * Pull the first balanced JSON object out of a model reply. Tolerates code fences and
 * surrounding prose. Returns the parsed value or undefined. PURE.
 */
function extractJsonObject(reply: string): unknown {
  const text = (reply ?? '').trim()
  if (!text) {
    return undefined
  }
  const start = text.indexOf('{')
  if (start === -1) {
    return undefined
  }
  // Walk to find the matching closing brace, respecting strings/escapes so braces
  // inside string values don't end the object early.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** Coerce + clamp a list of name strings, dedupe case-insensitively (first casing wins). */
function cleanNameList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const name = clampName(typeof raw === 'string' ? raw : raw == null ? '' : String(raw))
    if (!name) {
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(name)
    if (out.length >= cap) {
      break
    }
  }
  return out
}

/**
 * Parse + validate an all-notes plan from a model reply. PURE.
 *
 * - Tolerates code fences / surrounding prose (finds the first JSON object).
 * - Validates assignment ids against `validIds`; unknown ids are dropped.
 * - Dedupes assignments by id (first wins) and clamps tags per note.
 * - Caps total folders/tags. Folder/tag names referenced by surviving assignments
 *   are merged into the folders/tags lists so the preview shows everything created.
 *
 * Returns a plan with empty arrays if the reply is unusable — callers treat that as
 * "no plan".
 */
export function parseOrganizePlan(reply: string, validIds: Iterable<string>): ParsedPlan {
  const parsed = extractJsonObject(reply)
  if (!parsed || typeof parsed !== 'object') {
    return { folders: [], tags: [], assignments: [] }
  }
  const obj = parsed as Record<string, unknown>
  const validSet = new Set(validIds)

  const folderSet = new Map<string, string>() // lowercased -> display
  const tagSet = new Map<string, string>()
  const addFolder = (name: string) => {
    const key = name.toLowerCase()
    if (name && !folderSet.has(key) && folderSet.size < MAX_PLAN_FOLDERS) {
      folderSet.set(key, name)
    }
  }
  const addTag = (name: string) => {
    const key = name.toLowerCase()
    if (name && !tagSet.has(key) && tagSet.size < MAX_PLAN_TAGS) {
      tagSet.set(key, name)
    }
  }

  for (const f of cleanNameList(obj.folders, MAX_PLAN_FOLDERS)) {
    addFolder(f)
  }
  for (const t of cleanNameList(obj.tags, MAX_PLAN_TAGS)) {
    addTag(t)
  }

  const assignments: ParsedAssignment[] = []
  const seenIds = new Set<string>()
  const rawAssignments = Array.isArray(obj.assignments) ? obj.assignments : []
  for (const raw of rawAssignments) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const rec = raw as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id.trim() : rec.id == null ? '' : String(rec.id).trim()
    if (!id || !validSet.has(id) || seenIds.has(id)) {
      continue
    }
    seenIds.add(id)
    const folder = clampName(typeof rec.folder === 'string' ? rec.folder : '')
    const tags = cleanNameList(rec.tags, MAX_TAGS_PER_NOTE)
    if (folder) {
      addFolder(folder)
    }
    for (const t of tags) {
      addTag(t)
    }
    assignments.push({ id, folder, tags })
  }

  return {
    folders: [...folderSet.values()],
    tags: [...tagSet.values()],
    assignments,
  }
}

/** Parse + validate a current-note plan from a model reply. PURE. */
export function parseCurrentNotePlan(reply: string): ParsedCurrentNotePlan {
  const parsed = extractJsonObject(reply)
  if (!parsed || typeof parsed !== 'object') {
    return { folder: '', tags: [] }
  }
  const obj = parsed as Record<string, unknown>
  const folder = clampName(typeof obj.folder === 'string' ? obj.folder : '')
  const tags = cleanNameList(obj.tags, MAX_TAGS_PER_NOTE)
  return { folder, tags }
}

export interface OrganizeRequestOptions {
  signal?: AbortSignal
}

/**
 * Run the all-notes organize completion through the existing provider layer and parse
 * the plan. The note titles + snippets ARE sent to the configured AI provider —
 * callers must surface that to the user first.
 */
export async function requestOrganizePlan(
  application: WebApplication,
  input: { digest: string; validIds: Iterable<string>; existingFolders: string[]; existingTags: string[] },
  options: OrganizeRequestOptions = {},
): Promise<ParsedPlan> {
  const { system, user } = buildAllNotesPrompt({
    digest: input.digest,
    existingFolders: input.existingFolders,
    existingTags: input.existingTags,
  })
  const reply = await runOneShotCompletion(application, system, user, { signal: options.signal })
  return parseOrganizePlan(reply, input.validIds)
}

/**
 * Run the current-note organize completion through the existing provider layer and
 * parse the plan. The note title + text ARE sent to the configured AI provider.
 */
export async function requestCurrentNotePlan(
  application: WebApplication,
  input: { title: string; plaintext: string; existingFolders: string[]; existingTags: string[] },
  options: OrganizeRequestOptions = {},
): Promise<ParsedCurrentNotePlan> {
  const { system, user } = buildCurrentNotePrompt(input)
  const reply = await runOneShotCompletion(application, system, user, { signal: options.signal })
  return parseCurrentNotePlan(reply)
}
