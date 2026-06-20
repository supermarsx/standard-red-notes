// AI-assisted conflict merge: builds a one-shot prompt that asks the model to
// reconcile TWO conflicting versions of a note into a single merged version, and
// post-processes the model's reply back into a title/text pair.
//
// IMPORTANT: prompt-building, input budgeting, and response post-processing here
// are PURE functions of their inputs so they can be unit-tested without a
// WebApplication or network. The actual model call lives in runAiConflictMerge,
// which reuses the shared one-shot provider layer (selectionActions.runOneShotCompletion).
//
// Privacy: invoking the AI merge sends BOTH conflicting versions' content to the
// configured AI provider. Callers MUST surface that to the user first and MUST
// show the AI's proposed merge for review before applying it.

import { WebApplication } from '@/Application/WebApplication'
import { runOneShotCompletion } from '@/Assistant/selectionActions'

/**
 * ~4 chars per token. 8k chars (~2k tokens) per side keeps a two-version merge
 * request reasonable for local models while covering the vast majority of notes.
 * Each side is budgeted independently so a huge version on one side can't starve
 * the other.
 */
export const DEFAULT_CONFLICT_INPUT_BUDGET = 8_000

const SYSTEM_PROMPT =
  'You are a careful merge assistant for a note-taking app. You are given TWO conflicting versions of the ' +
  'same note (an "A" version and a "B" version). Reconcile them into a SINGLE merged note that preserves ' +
  'all meaningful content from BOTH versions: keep additions from each side, avoid dropping information, ' +
  'and do not duplicate content that is the same in both. Resolve direct contradictions by keeping both ' +
  'pieces of information rather than silently choosing one. ' +
  'Reply with ONLY the merged note text. The FIRST line is the note title; everything after the first ' +
  'line is the note body. No preamble, no explanation, and no markdown code fences unless the note itself ' +
  'is code.'

export interface ConflictMergeInput {
  /** Title + body of the local (conflicted copy) version, as diffable plain text. */
  localText: string
  /** Title + body of the remote (original) version, as diffable plain text. */
  remoteText: string
}

/**
 * Clamp one version's text to the per-side budget. Pure: no app/network. Cuts on a
 * whitespace boundary near the limit when possible so we don't slice mid-word.
 */
export function prepareConflictInputText(text: string, budget = DEFAULT_CONFLICT_INPUT_BUDGET): string {
  const normalized = (text ?? '').replace(/\r\n?/g, '\n').trim()
  const cap = budget > 0 ? Math.floor(budget) : DEFAULT_CONFLICT_INPUT_BUDGET
  if (normalized.length <= cap) {
    return normalized
  }
  const slice = normalized.slice(0, cap)
  const lastBreak = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'))
  return (lastBreak > cap * 0.6 ? slice.slice(0, lastBreak) : slice).trimEnd()
}

/**
 * Build the {system, user} messages for a one-shot AI conflict merge. Pure function
 * of its inputs so it can be unit-tested. Each side is budgeted independently and
 * the two versions are clearly delimited so the model can tell them apart.
 */
export function buildConflictMergePrompt(
  input: ConflictMergeInput,
  budget = DEFAULT_CONFLICT_INPUT_BUDGET,
): { system: string; user: string } {
  const versionA = prepareConflictInputText(input.localText ?? '', budget)
  const versionB = prepareConflictInputText(input.remoteText ?? '', budget)

  const user =
    'Merge these two conflicting versions of a note into one reconciled note that keeps all meaningful ' +
    'content from both.\n\n' +
    '===== VERSION A (this device / local) =====\n' +
    `${versionA}\n\n` +
    '===== VERSION B (other device / remote) =====\n' +
    `${versionB}\n\n` +
    '===== END =====\n' +
    'Return ONLY the merged note (first line = title).'

  return { system: SYSTEM_PROMPT, user }
}

/**
 * Strip a wrapping markdown code fence (```lang ... ```) a model might emit around
 * the whole reply, and normalize line endings/trailing whitespace. Pure.
 *
 * Only strips a fence that wraps the ENTIRE reply, so a note that legitimately
 * contains a fenced code block partway through is left untouched.
 */
export function postProcessMergeReply(reply: string): string {
  const normalized = (reply ?? '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) {
    return ''
  }
  const fenceMatch = normalized.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/)
  if (fenceMatch) {
    return fenceMatch[1].replace(/\s+$/, '')
  }
  return normalized.replace(/\s+$/, '')
}

/**
 * Decide whether a post-processed merge reply is usable. Pure. Guards against the
 * model returning junk (empty, or a refusal/apology with no merged content). The
 * caller falls back to a manual merge when this returns false.
 *
 * Heuristic only: we require non-empty content and reject the most common refusal
 * shapes. We deliberately keep this conservative so a legitimately short merged
 * note (e.g. a one-line note) is still accepted.
 */
export function isUsableMergeReply(processed: string): boolean {
  const text = (processed ?? '').trim()
  if (text.length === 0) {
    return false
  }
  // Reject obvious refusals/apologies that no real note would start with.
  const lowered = text.toLowerCase()
  const refusalPrefixes = [
    "i'm sorry",
    'i am sorry',
    'i cannot',
    "i can't",
    'i am unable',
    "i'm unable",
    'as an ai',
    'sorry, ',
  ]
  if (refusalPrefixes.some((prefix) => lowered.startsWith(prefix))) {
    return false
  }
  return true
}

/**
 * Run the AI conflict merge for one pair and return the post-processed merged text
 * (title on the first line, body after) ready to drop into the manual-merge editor.
 *
 * Returns `null` when the model returned junk/unusable output, so the caller can
 * fall back to the manual merge and toast.
 *
 * NOTE: this sends BOTH versions' content to the configured AI provider. Callers
 * MUST have surfaced that and MUST review the result before applying it.
 */
export async function runAiConflictMerge(
  application: WebApplication,
  input: ConflictMergeInput,
  options: { signal?: AbortSignal; budget?: number; onDelta?: (full: string) => void } = {},
): Promise<string | null> {
  const { system, user } = buildConflictMergePrompt(input, options.budget)
  const reply = await runOneShotCompletion(application, system, user, {
    signal: options.signal,
    onDelta: options.onDelta,
  })
  const processed = postProcessMergeReply(reply)
  return isUsableMergeReply(processed) ? processed : null
}
