// Application-wired entry point for AI deep research.
//
// Ties together: (1) the existing assistant provider availability check +
// one-shot completion primitive (the SAME
// provider the rest of the assistant uses — no new provider, no new agent
// framework), (3) the user's own decrypted notes as the corpus (same items access
// as the assistant context source), and (4) the pure bounded loop in
// deepResearch.ts.
//
// Optional public-web evidence uses the existing authenticated server tools,
// with explicit approval before each query/page. Local note excerpts never
// become search queries. Both corpora are bounded before provider synthesis.

import { ContentType, SNNote, isNote, isLitePayload } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { DeepResearchOptions, DeepResearchReport, ResearchNote, runDeepResearch } from './deepResearch'
import { assistantSessionPrincipalMatches, captureAssistantSessionPrincipal } from './assistantSessionPrincipal'
import { gatherResearchWebEvidence, ResearchWebOptions } from './researchWebEvidence'

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
function readableNote(application: WebApplication, note: SNNote): boolean {
  if (!isNote(note) || note.trashed || note.locked || isLitePayload(note.payload)) {
    return false
  }
  try {
    return typeof application.isAuthorizedToRenderItem === 'function' && application.isAuthorizedToRenderItem(note)
  } catch {
    return false
  }
}

function buildCorpus(application: WebApplication): ResearchNote[] {
  return application.items
    .getItems<SNNote>(ContentType.TYPES.Note)
    .filter((note) => readableNote(application, note))
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
  options: Pick<DeepResearchOptions, 'limits' | 'onProgress' | 'signal'> & {
    includeWeb?: boolean
    requestConfirmation?: ResearchWebOptions['requestConfirmation']
  } = {},
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

  let corpus: ResearchNote[] = []
  const assertCurrentReadAccess = () => {
    if (!principalIsCurrent()) {
      throw new Error('Deep research stopped because the active account changed.')
    }
    if (corpus.length) {
      const live = new Map(application.items.getItems<SNNote>(ContentType.TYPES.Note).map((note) => [note.uuid, note]))
      if (corpus.some((snapshot) => !live.has(snapshot.uuid) || !readableNote(application, live.get(snapshot.uuid)!))) {
        throw new Error('Deep research stopped because access to its source notes changed.')
      }
    }
  }
  const complete = async (system: string, user: string) => {
    assertCurrentReadAccess()
    const response = await runOneShotCompletion(application, system, user, { signal: options.signal })
    assertCurrentReadAccess()
    return response
  }

  const webEvidence = options.includeWeb
    ? await (async () => {
        options.onProgress?.({ kind: 'searching-web' })
        return gatherResearchWebEvidence(application, question, {
          signal: options.signal,
          isCurrent: principalIsCurrent,
          requestConfirmation: options.requestConfirmation,
        })
      })()
    : undefined
  if (!principalIsCurrent()) {
    return null
  }
  corpus = buildCorpus(application)
  const report = await runDeepResearch(question, corpus, complete, {
    limits: options.limits,
    onProgress: options.onProgress,
    signal: options.signal,
    webEvidence,
  })
  if (!principalIsCurrent()) {
    return null
  }
  assertCurrentReadAccess()
  return report
}
