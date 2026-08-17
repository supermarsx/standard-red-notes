// Application-wired entry point for AI deep research.
//
// Ties together: (1) the existing assistant provider availability check +
// one-shot completion primitive (the SAME
// provider the rest of the assistant uses — no new provider, no new agent
// framework), (3) the user's own decrypted notes as the corpus (same items access
// as the assistant context source), and (4) the pure bounded loop in
// deepResearch.ts.
//
// Honest scope: this researches the user's OWN NOTES only — there is no web-search
// tool in this client. It is a bounded agentic loop (capped rounds / notes /
// snippet length), not unlimited research. The mode is always present in the
// assistant and degrades gracefully when no provider is configured.

import { ContentType, SNNote, isNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { DeepResearchOptions, DeepResearchReport, ResearchNote, runDeepResearch } from './deepResearch'
import { assistantSessionPrincipalMatches, captureAssistantSessionPrincipal } from './assistantSessionPrincipal'

export interface DeepResearchAvailability {
  /** Whether a deep-research run can start right now. */
  available: boolean
  /** Present when not available: a short, user-facing reason. */
  reason?: string
}

/**
 * Whether deep research can run with the currently configured assistant
 * provider. The action itself is always present.
 */
export function getDeepResearchAvailability(application: WebApplication): DeepResearchAvailability {
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
 * using the configured assistant provider. Returns null when the provider is not
 * configured or when the initiating account is no longer active.
 */
export async function runDeepResearchForApplication(
  application: WebApplication,
  question: string,
  options: Pick<DeepResearchOptions, 'limits' | 'onProgress' | 'signal'> = {},
): Promise<DeepResearchReport | null> {
  if (!getDeepResearchAvailability(application).available) {
    return null
  }

  const principal = captureAssistantSessionPrincipal(application.sessions)
  if (!principal.valid) {
    return null
  }

  const principalIsCurrent = () =>
    !options.signal?.aborted &&
    assistantSessionPrincipalMatches(principal, captureAssistantSessionPrincipal(application.sessions))

  const complete = async (system: string, user: string) => {
    if (!principalIsCurrent()) {
      throw new Error('Deep research stopped because the active account changed.')
    }
    const response = await runOneShotCompletion(application, system, user, { signal: options.signal })
    if (!principalIsCurrent()) {
      throw new Error('Deep research stopped because the active account changed.')
    }
    return response
  }

  const corpus = buildCorpus(application)
  const report = await runDeepResearch(question, corpus, complete, {
    limits: options.limits,
    onProgress: options.onProgress,
    signal: options.signal,
  })
  if (!principalIsCurrent()) {
    return null
  }
  return report
}
