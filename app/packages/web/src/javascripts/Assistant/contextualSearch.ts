// Application-wired entry point for AI-assisted contextual search.
//
// Ties together: (1) the web-local enabled toggle (default OFF), (2) the existing
// assistant provider availability check + one-shot completion primitive (the SAME
// provider the rest of the assistant uses — no new dependency, no new provider),
// and (3) the pure re-ranking logic in contextualSearchRanking.ts.
//
// The provider call is a single, bounded, debounced/submit-triggered completion
// over the TOP-N algorithmic candidates only. Degrades gracefully: if the AI
// toggle is off or no provider is configured, it returns "unavailable" and the
// caller leaves the algorithmic ordering untouched.

import { WebApplication } from '@/Application/WebApplication'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { isContextualSearchEnabled } from './contextualSearchSettings'
import {
  RerankCandidate,
  rerankCandidates,
  SelectCandidatesOptions,
} from './contextualSearchRanking'

export interface ContextualSearchAvailability {
  /** Whether a "Search with AI" re-rank can run right now. */
  available: boolean
  /** Present when not available: a short, user-facing reason. */
  reason?: string
}

/**
 * Whether AI contextual search can run: the web-local toggle is on AND a provider
 * is configured (reuses the assistant's own availability check). Used to gate /
 * disable the "Search with AI" action and to decide whether to fire a model call.
 */
export function getContextualSearchAvailability(application: WebApplication): ContextualSearchAvailability {
  if (!isContextualSearchEnabled()) {
    return { available: false, reason: 'Enable AI contextual search in Preferences → Assistant.' }
  }
  const ai = getSelectionAIAvailability(application)
  if (!ai.available) {
    return { available: false, reason: ai.reason }
  }
  return { available: true }
}

/**
 * Run one bounded re-rank over the supplied algorithmic candidates and return the
 * resulting uuid ordering (best match first), or null when it could not / should
 * not run (off, no provider, nothing to rank, unparseable reply, or aborted).
 *
 * Only the top-N candidates' titles + short snippets and the query leave the
 * device — never the whole library, never full bodies.
 */
export async function runContextualRerank(
  application: WebApplication,
  query: string,
  candidates: RerankCandidate[],
  options: { signal?: AbortSignal; candidateOptions?: SelectCandidatesOptions } = {},
): Promise<string[] | null> {
  if (!getContextualSearchAvailability(application).available) {
    return null
  }

  const complete = (system: string, user: string) =>
    runOneShotCompletion(application, system, user, { signal: options.signal })

  const result = await rerankCandidates(query, candidates, complete, options.candidateOptions)
  return result?.orderedUuids ?? null
}
