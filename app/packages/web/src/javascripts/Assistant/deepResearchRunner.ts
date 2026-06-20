// Application-wired entry point for AI deep research.
//
// Ties together: (1) the web-local enabled toggle (default OFF), (2) the existing
// assistant provider availability check + one-shot completion primitive (the SAME
// provider the rest of the assistant uses — no new provider, no new agent
// framework), (3) the user's own decrypted notes as the corpus (same items access
// as the assistant context source), and (4) the pure bounded loop in
// deepResearch.ts.
//
// Honest scope: this researches the user's OWN NOTES only — there is no web-search
// tool in this client. It is a bounded agentic loop (capped rounds / notes /
// snippet length), not unlimited research. Degrades gracefully: if the toggle is
// off or no provider is configured, getDeepResearchAvailability reports why and
// the action stays disabled.

import { ContentType, SNNote, isNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { isDeepResearchEnabled } from './deepResearchSettings'
import {
  DeepResearchOptions,
  DeepResearchReport,
  ResearchNote,
  runDeepResearch,
} from './deepResearch'

export interface DeepResearchAvailability {
  /** Whether a deep-research run can start right now. */
  available: boolean
  /** Present when not available: a short, user-facing reason. */
  reason?: string
}

/**
 * Whether deep research can run: the web-local toggle is on AND a provider is
 * configured (reuses the assistant's own availability check). Used to gate /
 * disable the "Deep research" action.
 */
export function getDeepResearchAvailability(application: WebApplication): DeepResearchAvailability {
  if (!isDeepResearchEnabled()) {
    return { available: false, reason: 'Enable Deep research in Preferences → Assistant.' }
  }
  const ai = getSelectionAIAvailability(application)
  if (!ai.available) {
    return { available: false, reason: ai.reason }
  }
  return { available: true }
}

/** Collect the user's notes (decrypted, plain text) as the research corpus. */
function buildCorpus(application: WebApplication): ResearchNote[] {
  return application.items
    .getItems<SNNote>(ContentType.TYPES.Note)
    .filter((note) => isNote(note) && !note.trashed)
    .map((note) => ({
      uuid: note.uuid,
      title: note.title,
      text: extractPlaintextFromNoteText(note.text ?? '', note.noteType),
    }))
}

/**
 * Run a bounded deep-research pass over the user's notes for the given question,
 * using the configured assistant provider. Returns null when the feature is off
 * or no provider is configured (the default-off / unconfigured path is a no-op).
 */
export async function runDeepResearchForApplication(
  application: WebApplication,
  question: string,
  options: Pick<DeepResearchOptions, 'limits' | 'onProgress' | 'signal'> = {},
): Promise<DeepResearchReport | null> {
  if (!getDeepResearchAvailability(application).available) {
    return null
  }

  const complete = (system: string, user: string) =>
    runOneShotCompletion(application, system, user, { signal: options.signal })

  const corpus = buildCorpus(application)
  return runDeepResearch(question, corpus, complete, {
    limits: options.limits,
    onProgress: options.onProgress,
    signal: options.signal,
  })
}
