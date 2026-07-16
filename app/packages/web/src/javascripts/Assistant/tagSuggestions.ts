// Suggests up to 4 tags for a note via a ONE-SHOT (non-agentic) completion. The
// prompt-building and response-parsing here are PURE functions of their inputs so
// they can be unit-tested without a WebApplication or network.
//
// The model call reuses the same provider layer as the editor's selection actions
// and narration (see selectionActions.ts -> runOneShotCompletion). This is a single
// text -> tags transform; we deliberately avoid the agentic tool loop.

import { WebApplication } from '@/Application/WebApplication'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { runOneShotCompletion } from './selectionActions'

/** Hard cap on how many tags we ever propose / accept from the model. */
export const MAX_SUGGESTED_TAGS = 4

/**
 * ~4 chars per token. 8k chars (~2k tokens) of note text is plenty to decide on a
 * handful of tags while keeping the request small for local models. Longer notes are
 * truncated silently — tag inference rarely needs the tail of a long note.
 */
export const DEFAULT_TAG_INPUT_BUDGET = 8_000

/**
 * Max characters of a single suggested tag. Standard Notes tag titles can be long,
 * but AI-suggested tags should stay short and human; anything longer is junk.
 */
export const MAX_TAG_LENGTH = 60

const SYSTEM_PROMPT =
  'You are a tagging assistant for a note-taking app. Given a note, propose a small set of short, relevant ' +
  "topic tags that would help the user find and group this note later. Prefer reusing the user's existing tags " +
  'when one fits, instead of inventing a near-duplicate. ' +
  `Reply with ONLY a JSON array of at most ${MAX_SUGGESTED_TAGS} tag strings, e.g. ["work","budget"]. ` +
  'Each tag should be 1-3 words, lowercase unless a proper noun, with no leading "#". ' +
  'No preamble, no explanation, no markdown code fences.'

export interface TagPromptInput {
  /** Note title (may be empty). */
  title: string
  /** Plain text of the note, already extracted from Super/Lexical if needed. */
  plaintext: string
  /** Existing tag titles to prefer reusing (deduped, order preserved by caller). */
  existingTags: string[]
}

/**
 * Clamp note plain text to the tag-input budget. Pure: no app/network. Cuts on a
 * whitespace boundary near the limit when possible.
 */
export function prepareTagInputText(plaintext: string, budget = DEFAULT_TAG_INPUT_BUDGET): string {
  const normalized = (plaintext ?? '').replace(/\r\n?/g, '\n').trim()
  const cap = budget > 0 ? Math.floor(budget) : DEFAULT_TAG_INPUT_BUDGET
  if (normalized.length <= cap) {
    return normalized
  }
  const slice = normalized.slice(0, cap)
  const lastBreak = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'))
  return (lastBreak > cap * 0.6 ? slice.slice(0, lastBreak) : slice).trimEnd()
}

/**
 * Build the {system, user} messages for a one-shot tag-suggestion completion. Pure
 * function of its inputs so it can be unit-tested. The existing tag list is included
 * verbatim so the model is nudged to reuse those names over inventing duplicates.
 */
export function buildTagSuggestionPrompt(
  input: TagPromptInput,
  budget = DEFAULT_TAG_INPUT_BUDGET,
): {
  system: string
  user: string
} {
  const title = (input.title ?? '').trim()
  const body = prepareTagInputText(input.plaintext ?? '', budget)

  const existing = (input.existingTags ?? []).map((t) => (t ?? '').trim()).filter((t) => t.length > 0)

  const existingBlock =
    existing.length > 0
      ? `The user already has these tags — strongly prefer reusing an exact match from this list when it fits:\n${existing
          .map((t) => `- ${t}`)
          .join('\n')}\n\n`
      : 'The user has no existing tags yet.\n\n'

  const titleBlock = title ? `Title: ${title}\n\n` : ''

  const user =
    `Suggest up to ${MAX_SUGGESTED_TAGS} tags for the following note.\n\n` +
    existingBlock +
    `${titleBlock}Note:\n---\n${body}`

  return { system: SYSTEM_PROMPT, user }
}

/**
 * Sanitize a single candidate tag string. Returns a cleaned tag, or '' if the
 * candidate is not usable. Pure.
 *  - trims, strips a leading "#", collapses internal whitespace
 *  - strips wrapping quotes/brackets left over from sloppy formats
 *  - drops empties and anything longer than MAX_TAG_LENGTH after cleaning
 */
export function sanitizeTag(raw: string): string {
  if (typeof raw !== 'string') {
    return ''
  }
  let tag = raw.trim()
  // Strip wrapping brackets a model might leave when emitting a pseudo-JSON list
  // that we split on delimiters (e.g. "['work" / "budget']").
  tag = tag.replace(/^[[\]]+|[[\]]+$/g, '').trim()
  // Strip wrapping quotes a model might leave on a comma list element.
  tag = tag.replace(/^["'`]+|["'`]+$/g, '')
  // Strip a leading hashtag and any leading list markers ("- ", "* ", "1. ").
  tag = tag
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^#+/, '')
  // Collapse internal whitespace/newlines.
  tag = tag.replace(/\s+/g, ' ').trim()
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
    return ''
  }
  return tag
}

/**
 * Robustly parse the model's reply into up to MAX_SUGGESTED_TAGS tags. Pure.
 *
 * Tolerates:
 *  - a clean JSON array: ["a","b"]
 *  - JSON wrapped in ```json code fences or surrounded by prose
 *  - a comma- or newline-separated list when no JSON array is present
 *  - stray "#", quotes, list bullets, and duplicate/empty entries
 *
 * Dedupe is case-insensitive but preserves the first-seen casing. Caps at 4.
 *
 * Robustness limits: this does NOT understand free-form sentences like
 * "I would tag this as work and budget"; if there's no JSON array it falls back to
 * splitting on commas/newlines, which can mis-handle prose. Callers should treat an
 * empty result as "no good suggestions".
 */
export function parseSuggestedTags(reply: string): string[] {
  const text = (reply ?? '').trim()
  if (!text) {
    return []
  }

  const candidates = extractRawCandidates(text)

  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const tag = sanitizeTag(candidate)
    if (!tag) {
      continue
    }
    const key = tag.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_SUGGESTED_TAGS) {
      break
    }
  }
  return out
}

/** Pull the raw (pre-sanitize) candidate strings out of a model reply. */
function extractRawCandidates(text: string): string[] {
  // 1) Prefer the first JSON array of strings anywhere in the reply (handles code
  //    fences and surrounding prose since we search for the bracketed substring).
  const arrayMatch = text.match(/\[[\s\S]*?\]/)
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown
      if (Array.isArray(parsed)) {
        return parsed.map((v) => (typeof v === 'string' ? v : v == null ? '' : String(v)))
      }
    } catch {
      // Malformed JSON-looking array — fall through to delimiter splitting below.
    }
  }

  // 2) No usable JSON array: strip code fences, then split on commas/newlines.
  const stripped = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '')
  return stripped.split(/[,\n]/)
}

export interface SuggestTagsOptions {
  signal?: AbortSignal
  budget?: number
}

/**
 * Generate up to 4 suggested tags for a note by running a single completion through
 * the existing provider layer (direct or proxy). The note's title + text ARE sent to
 * the configured AI provider — callers must surface that to the user first.
 *
 * Returns the parsed/sanitized tag list (possibly empty if the model returned junk).
 */
export async function suggestTagsForNote(
  application: WebApplication,
  input: { title: string; plaintext: string; existingTags: string[] },
  options: SuggestTagsOptions = {},
): Promise<string[]> {
  const { system, user } = buildTagSuggestionPrompt(input, options.budget)
  const reply = await runOneShotCompletion(application, system, user, { signal: options.signal })
  return parseSuggestedTags(reply)
}

/** Convenience: extract a note's plain text the same way the assistant context does. */
export function notePlaintextForTags(
  noteText: string,
  noteType: Parameters<typeof extractPlaintextFromNoteText>[1],
): string {
  return extractPlaintextFromNoteText(noteText ?? '', noteType)
}

// ---------------------------------------------------------------------------
// File variant
// ---------------------------------------------------------------------------
//
// Files are first-class synced items and can be tagged exactly like notes. Unlike
// a note, a file's decrypted bytes are usually NOT readable text — so the honest
// signal the model gets is the plaintext metadata (filename + mime type + size)
// ALWAYS, plus on-device-extracted text ONLY for text-like files (see
// fileTextExtraction.ts). The exposure warning in the modal states exactly this.

/** System prompt for the file variant. Same contract as notes, retargeted to files. */
const FILE_SYSTEM_PROMPT =
  'You are a tagging assistant for a note-taking app. Given a file (its name, type, and any readable text), ' +
  'propose a small set of short, relevant topic tags that would help the user find and group this file later. ' +
  "Prefer reusing the user's existing tags when one fits, instead of inventing a near-duplicate. " +
  `Reply with ONLY a JSON array of at most ${MAX_SUGGESTED_TAGS} tag strings, e.g. ["invoices","2024"]. ` +
  'Each tag should be 1-3 words, lowercase unless a proper noun, with no leading "#". ' +
  'No preamble, no explanation, no markdown code fences.'

export interface FileTagPromptInput {
  /** File name (plaintext metadata on the item). */
  name: string
  /** File mime type (plaintext metadata). */
  mimeType: string
  /** Human-readable size label, e.g. "1.2 MB" (plaintext metadata). */
  sizeLabel: string
  /**
   * Text extracted on-device from the file, or '' when none is available (encrypted
   * binaries, or PDFs with OCR off). Empty text is stated explicitly in the prompt.
   */
  extractedText: string
  /** Existing tag titles to prefer reusing (deduped, order preserved by caller). */
  existingTags: string[]
}

/**
 * Build the {system, user} messages for a one-shot file tag-suggestion completion.
 * Pure function of its inputs. Filename + mime type + size are ALWAYS included;
 * extracted text is appended when present, and its absence is stated so the model
 * knows to lean on the filename/type alone.
 */
export function buildFileTagSuggestionPrompt(
  input: FileTagPromptInput,
  budget = DEFAULT_TAG_INPUT_BUDGET,
): { system: string; user: string } {
  const name = (input.name ?? '').trim()
  const mimeType = (input.mimeType ?? '').trim()
  const sizeLabel = (input.sizeLabel ?? '').trim()
  const extracted = prepareTagInputText(input.extractedText ?? '', budget)

  const existing = (input.existingTags ?? []).map((t) => (t ?? '').trim()).filter((t) => t.length > 0)

  const existingBlock =
    existing.length > 0
      ? `The user already has these tags — strongly prefer reusing an exact match from this list when it fits:\n${existing
          .map((t) => `- ${t}`)
          .join('\n')}\n\n`
      : 'The user has no existing tags yet.\n\n'

  const metadataBlock =
    `Filename: ${name || '(unnamed)'}\n` +
    `Type: ${mimeType || '(unknown)'}\n` +
    (sizeLabel ? `Size: ${sizeLabel}\n` : '')

  const textBlock = extracted
    ? `\nReadable text extracted from the file:\n---\n${extracted}`
    : '\nNo readable text could be extracted; suggest from the filename and type.'

  const user =
    `Suggest up to ${MAX_SUGGESTED_TAGS} tags for the following file.\n\n` + existingBlock + metadataBlock + textBlock

  return { system: FILE_SYSTEM_PROMPT, user }
}

/**
 * Generate up to 4 suggested tags for a file. Mirrors {@link suggestTagsForNote}:
 * a single completion through the existing provider layer, then the shared
 * parse/sanitize. The file's metadata (and any extracted text) ARE sent to the
 * configured AI provider — callers must surface that to the user first.
 */
export async function suggestTagsForFile(
  application: WebApplication,
  input: FileTagPromptInput,
  options: SuggestTagsOptions = {},
): Promise<string[]> {
  const { system, user } = buildFileTagSuggestionPrompt(input, options.budget)
  const reply = await runOneShotCompletion(application, system, user, { signal: options.signal })
  return parseSuggestedTags(reply)
}
