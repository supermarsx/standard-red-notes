// Application-wired entry point for AI RESEARCH MODE.
//
// Ties together: (1) the existing assistant provider availability check +
// one-shot completion primitive (the SAME
// provider the rest of the assistant uses — no new provider, no web access), and
// (3) the pure research pass in researchMode.ts, then creates and opens a note
// with the resulting structured report.
//
// Honest scope: there is NO web-search tool in this client, so the report is
// written from the model's training data and carries a mandatory "verify this"
// disclaimer (appended in researchMode.ts, not by the model). getResearchModeAvailability
// reports why the feature is unavailable so the UI can disable it cleanly.

import { ContentType, NoteContent, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { getSelectionAIAvailability, runOneShotCompletion } from './selectionActions'
import { runResearchMode, ResearchModeOptions, ResearchModeResult } from './researchMode'
import { assistantSessionPrincipalMatches, captureAssistantSessionPrincipal } from './assistantSessionPrincipal'
import { getAssistantAccountScope, getPersona } from './personaSettings'

export interface ResearchModeAvailability {
  /** Whether a research run can start right now. */
  available: boolean
  /** Present when not available: a short, user-facing reason. */
  reason?: string
}

/**
 * Whether research mode can run with the currently configured assistant
 * provider (including the proxy-mode sign-in gate). The action itself is always
 * present.
 */
export function getResearchModeAvailability(application: WebApplication): ResearchModeAvailability {
  const ai = getSelectionAIAvailability(application)
  if (!ai.available) {
    return { available: false, reason: ai.reason }
  }
  return { available: true }
}

/** Outcome of a wired research run: the report plus the created note's uuid. */
export interface ResearchModeRunResult {
  result: ResearchModeResult
  noteUuid: string
}

/**
 * Run research mode for a topic using the configured assistant provider, then
 * create a new note with the structured report and return its uuid. Returns null
 * when the provider is unconfigured, the topic is empty, or the initiating
 * account is no longer active.
 */
export async function runResearchModeForApplication(
  application: WebApplication,
  topic: string,
  options: ResearchModeOptions = {},
): Promise<ResearchModeRunResult | null> {
  if (!getResearchModeAvailability(application).available) {
    return null
  }

  const principal = captureAssistantSessionPrincipal(application.sessions)
  const scope = getAssistantAccountScope(application)
  if (!principal.valid || !scope) {
    return null
  }
  const persona = getPersona(scope)

  const principalIsCurrent = () =>
    !options.signal?.aborted &&
    assistantSessionPrincipalMatches(principal, captureAssistantSessionPrincipal(application.sessions))

  const complete = async (system: string, user: string) => {
    if (!principalIsCurrent()) {
      throw new Error('Research mode stopped because the active account changed.')
    }
    const response = await runOneShotCompletion(application, system, user, { signal: options.signal })
    if (!principalIsCurrent()) {
      throw new Error('Research mode stopped because the active account changed.')
    }
    return response
  }

  const result = await runResearchMode(topic, complete, { ...options, persona })
  if (!result || !principalIsCurrent()) {
    return null
  }

  /**
   * Keep creation, insertion, and any compensating deletion on the same service
   * instances. Account transitions can replace the application's active
   * dependencies while insertItem is pending; looking the mutator up again after
   * that await could otherwise try to clean up through the next account's
   * services.
   */
  const items = application.items
  const mutator = application.mutator
  const template = items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
    title: result.title,
    text: result.body,
    references: [],
  })
  if (!principalIsCurrent()) {
    return null
  }

  const discardCreatedNote = async () => {
    /**
     * Delete by the UUID of the exact unmanaged template passed to insertItem,
     * never by a title lookup or an object returned from an untrusted async
     * boundary. setItemToBeDeleted is a no-op when insertion did not reach the
     * item manager, which also makes it safe on a partially-failed insert.
     */
    await mutator.setItemToBeDeleted(template)
    if (items.findItem(template.uuid)) {
      throw new Error('Research mode could not safely discard its generated note after the active account changed.')
    }
  }

  let note: SNNote
  try {
    note = await mutator.insertItem<SNNote>(template)
  } catch (error) {
    await discardCreatedNote()
    throw error
  }

  if (!principalIsCurrent()) {
    await discardCreatedNote()
    return null
  }

  return { result, noteUuid: note.uuid }
}
