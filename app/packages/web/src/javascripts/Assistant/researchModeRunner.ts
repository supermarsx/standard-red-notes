// Application-wired entry point for AI RESEARCH MODE.
//
// Ties together: (1) the web-local enabled toggle (default OFF), (2) the existing
// assistant provider availability check + one-shot completion primitive (the SAME
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
import { isResearchModeEnabled } from './researchModeSettings'
import { runResearchMode, ResearchModeOptions, ResearchModeResult } from './researchMode'

export interface ResearchModeAvailability {
  /** Whether a research run can start right now. */
  available: boolean
  /** Present when not available: a short, user-facing reason. */
  reason?: string
}

/**
 * Whether research mode can run: the web-local toggle is on AND a provider is
 * configured (reuses the assistant's own availability check, which also enforces
 * the proxy-mode sign-in gate). Used to gate / disable the "Research mode" action.
 */
export function getResearchModeAvailability(application: WebApplication): ResearchModeAvailability {
  if (!isResearchModeEnabled()) {
    return { available: false, reason: 'Enable Research mode in Preferences → Assistant.' }
  }
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
 * when the feature is off / unconfigured (a no-op) or when the topic is empty.
 */
export async function runResearchModeForApplication(
  application: WebApplication,
  topic: string,
  options: ResearchModeOptions = {},
): Promise<ResearchModeRunResult | null> {
  if (!getResearchModeAvailability(application).available) {
    return null
  }

  const complete = (system: string, user: string) =>
    runOneShotCompletion(application, system, user, { signal: options.signal })

  const result = await runResearchMode(topic, complete, options)
  if (!result || options.signal?.aborted) {
    return null
  }

  const template = application.items.createTemplateItem<NoteContent, SNNote>(ContentType.TYPES.Note, {
    title: result.title,
    text: result.body,
    references: [],
  })
  const note = await application.mutator.insertItem<SNNote>(template)

  return { result, noteUuid: note.uuid }
}
