// Turns a note's plain text into clean, listenable narration text via a ONE-SHOT
// (non-agentic) completion. The prompt-building + budgeting here are PURE functions
// of their inputs so they can be unit-tested without a WebApplication or network.
//
// The actual model call reuses the same provider layer as the editor's selection
// actions (see selectionActions.ts -> runSelectionAction). We deliberately do NOT
// go through the agentic tool loop: narration is a single text->text transform.

import { WebApplication } from '@/Application/WebApplication'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { runOneShotCompletion } from './selectionActions'

/** The kinds of narration rewrite the user can pick. */
export type NarrationStyleId = 'faithful' | 'summary' | 'storytelling' | 'explainer' | 'formal'

export interface NarrationStyle {
  id: NarrationStyleId
  label: string
  /** One-line description shown in the picker / settings. */
  description: string
  /** Instruction appended to the system prompt to shape the rewrite. */
  instruction: string
}

export const NARRATION_STYLES: NarrationStyle[] = [
  {
    id: 'faithful',
    label: 'Faithful read',
    description: 'Read the note closely, just smoothed out for listening.',
    instruction:
      'Rewrite the note so it can be read aloud naturally. Preserve all of the original meaning and detail. ' +
      'Expand abbreviations and acronyms on first use, turn bullet lists and markdown into flowing sentences, ' +
      'spell out symbols where a listener would expect words, and remove formatting artifacts. Do not summarize ' +
      'or omit content.',
  },
  {
    id: 'summary',
    label: 'Summary',
    description: 'A concise spoken summary of the key points.',
    instruction:
      'Produce a concise spoken-word summary of the note that captures the key points. Use natural, flowing ' +
      'sentences suitable for listening. Drop minor detail; keep the essential information.',
  },
  {
    id: 'storytelling',
    label: 'Storytelling',
    description: 'A warm, narrative retelling.',
    instruction:
      'Retell the content of the note as a warm, engaging spoken narrative. Keep the facts accurate but use a ' +
      'natural, conversational storytelling voice with smooth transitions between ideas.',
  },
  {
    id: 'explainer',
    label: 'Explainer',
    description: 'A clear, teacher-like explanation.',
    instruction:
      'Explain the content of the note clearly, as a knowledgeable teacher would when reading it aloud. Define ' +
      'jargon, give brief context where helpful, and use plain, well-paced sentences. Stay faithful to the source.',
  },
  {
    id: 'formal',
    label: 'Formal',
    description: 'A polished, professional reading.',
    instruction:
      'Rewrite the note in a polished, formal register suitable for a professional spoken reading. Use complete, ' +
      'well-structured sentences and a measured tone. Preserve the meaning; do not add opinions.',
  },
]

export const DEFAULT_NARRATION_STYLE: NarrationStyleId = 'faithful'

export function getNarrationStyle(id: NarrationStyleId): NarrationStyle {
  return NARRATION_STYLES.find((style) => style.id === id) ?? NARRATION_STYLES[0]
}

/**
 * ~4 chars per token. 16k chars (~4k tokens) of input keeps a one-shot narration
 * request well within the context window of small local models while still covering
 * the large majority of hand-written notes. Longer notes are truncated with a notice.
 */
export const DEFAULT_NARRATION_INPUT_BUDGET = 16_000

const SYSTEM_PROMPT_BASE =
  'You are a narration assistant. You convert a note into clean, natural text meant to be READ ALOUD by a ' +
  'text-to-speech voice. Reply with ONLY the narration text — no preamble, no titles, no markdown, no bullet ' +
  'points, and no code fences. Write in plain prose sentences.'

const TRUNCATION_NOTICE = '\n\n[Note truncated for narration — the full note is longer than the narration limit.]'

export interface NarrationInput {
  /** Plain text of the note (already extracted from Super/Lexical if needed). */
  text: string
  /** Whether the text was cut to fit the budget. */
  truncated: boolean
  /** Characters of the (possibly truncated) text actually used. */
  characters: number
}

/**
 * Clamp note plain text to the narration input budget. Pure function: no app/network.
 * When the text exceeds the budget it is cut on a word/whitespace boundary near the
 * limit and a human-readable notice is appended so the listener knows it was shortened.
 */
export function prepareNarrationInput(plaintext: string, budget = DEFAULT_NARRATION_INPUT_BUDGET): NarrationInput {
  const normalized = (plaintext ?? '').replace(/\r\n?/g, '\n').trim()
  const cap = budget > 0 ? Math.floor(budget) : DEFAULT_NARRATION_INPUT_BUDGET

  if (normalized.length <= cap) {
    return { text: normalized, truncated: false, characters: normalized.length }
  }

  // Cut at the last whitespace before the cap so we don't split a word; fall back to
  // a hard cut if there is no whitespace in range.
  const slice = normalized.slice(0, cap)
  const lastBreak = slice.lastIndexOf(' ')
  const lastNewline = slice.lastIndexOf('\n')
  const breakAt = Math.max(lastBreak, lastNewline)
  const body = (breakAt > cap * 0.6 ? slice.slice(0, breakAt) : slice).trimEnd()

  return { text: `${body}${TRUNCATION_NOTICE}`, truncated: true, characters: body.length }
}

/**
 * Build the {system, user} messages for a one-shot narration completion.
 * Pure function of (style, text) so it can be unit-tested in isolation.
 */
export function buildNarrationPrompt(styleId: NarrationStyleId, noteText: string): { system: string; user: string } {
  const style = getNarrationStyle(styleId)
  const system = `${SYSTEM_PROMPT_BASE}\n\nNarration style — ${style.label}: ${style.instruction}`
  const user = `Convert the following note into narration text.\n\n---\n${noteText}`
  return { system, user }
}

export interface GenerateNarrationOptions {
  signal?: AbortSignal
  onDelta?: (full: string) => void
  budget?: number
}

export interface GeneratedNarration {
  narration: string
  truncated: boolean
  /** Characters of source note text sent to the provider. */
  sourceCharacters: number
}

/**
 * Generate narration text for the given note plain text by running a single
 * completion through the existing provider layer (direct or proxy). The note's
 * content IS sent to the configured AI provider — callers must surface that.
 */
export async function generateNarration(
  application: WebApplication,
  styleId: NarrationStyleId,
  notePlaintext: string,
  options: GenerateNarrationOptions = {},
): Promise<GeneratedNarration> {
  const input = prepareNarrationInput(notePlaintext, options.budget)
  const { system, user } = buildNarrationPrompt(styleId, input.text)

  // One-shot completion (no tools) through the same provider layer the editor's
  // selection actions use — direct (browser -> endpoint) or server proxy.
  const narration = await runOneShotCompletion(application, system, user, {
    signal: options.signal,
    onDelta: options.onDelta,
  })

  return { narration, truncated: input.truncated, sourceCharacters: input.characters }
}

/** Convenience: extract a note's plain text the same way the assistant context does. */
export function notePlaintext(noteText: string, noteType: Parameters<typeof extractPlaintextFromNoteText>[1]): string {
  return extractPlaintextFromNoteText(noteText ?? '', noteType)
}
