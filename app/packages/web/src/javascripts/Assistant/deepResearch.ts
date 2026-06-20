// AI DEEP RESEARCH over the user's OWN NOTES (a local corpus) — NOT the public
// web. There is no web-search tool in this client, so this researches only the
// notes already on the device. It is a BOUNDED agentic loop, not unlimited
// research: a hard cap on rounds, on how many notes are read, and on per-note
// snippet length keep both token use and data exposure controlled.
//
// The loop:
//   1. Retrieve candidate notes for the question (reuses the existing local BM25
//      retrieval — the SAME primitive the assistant uses for note context).
//   2. Read a bounded set of the most relevant notes (truncated snippets).
//   3. Iterate a small, capped number of rounds where the model may request a
//      few MORE specific notes by number, or signal it has enough.
//   4. Synthesize a structured report: summary + findings + a list of the cited
//      source notes the user can open.
//
// Everything here is a PURE function of its inputs: the note corpus, an injected
// `retrieve` (defaults to the shared BM25 retriever) and an injected `complete`
// (one-shot provider call). That keeps the provider mockable and the
// step/notes/snippet caps + termination unit-testable in isolation. The
// application wiring (real provider + real notes) lives in deepResearchRunner.ts.

import { retrieve as defaultRetrieve, RetrievalDoc } from './retrieval'

/** A note available to the research loop (already plain text, decrypted upstream). */
export interface ResearchNote {
  uuid: string
  title: string
  text: string
}

/** A source note that was read and is cited in the report. */
export interface CitedSource {
  uuid: string
  title: string
  /** Short snippet shown next to the citation so the user knows why it was used. */
  snippet: string
}

export interface DeepResearchReport {
  question: string
  /** The synthesized prose report (summary + findings) from the model. */
  report: string
  /** The notes actually read and cited, in the order they were selected. */
  sources: CitedSource[]
  /** How many model rounds the loop actually ran (≤ maxRounds). */
  rounds: number
  /** Why the loop stopped. */
  stopReason: 'model-finished' | 'max-rounds' | 'no-new-notes' | 'no-candidates' | 'aborted'
}

export interface DeepResearchLimits {
  /** Hard cap on model rounds (refinement steps). Default 4, clamped to [1, 5]. */
  maxRounds: number
  /** Hard cap on total notes read/cited across the whole run. Default 8, clamped to [1, 20]. */
  maxNotes: number
  /** Notes selected from retrieval in the very first read. Default 6. */
  initialNotes: number
  /** Max additional notes the model may pull in per refine round. Default 3. */
  notesPerRound: number
  /** Max characters of each note's body included in a prompt. Default 700. */
  snippetChars: number
}

export const DEFAULT_DEEP_RESEARCH_LIMITS: DeepResearchLimits = {
  maxRounds: 4,
  maxNotes: 8,
  initialNotes: 6,
  notesPerRound: 3,
  snippetChars: 700,
}

/** Absolute ceilings — even an explicit caller-supplied limit cannot exceed these. */
const HARD_MAX_ROUNDS = 5
const HARD_MAX_NOTES = 20

function clampLimits(partial?: Partial<DeepResearchLimits>): DeepResearchLimits {
  const merged = { ...DEFAULT_DEEP_RESEARCH_LIMITS, ...(partial ?? {}) }
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
  return {
    maxRounds: clamp(merged.maxRounds, 1, HARD_MAX_ROUNDS, DEFAULT_DEEP_RESEARCH_LIMITS.maxRounds),
    maxNotes: clamp(merged.maxNotes, 1, HARD_MAX_NOTES, DEFAULT_DEEP_RESEARCH_LIMITS.maxNotes),
    initialNotes: clamp(merged.initialNotes, 1, HARD_MAX_NOTES, DEFAULT_DEEP_RESEARCH_LIMITS.initialNotes),
    notesPerRound: clamp(merged.notesPerRound, 1, HARD_MAX_NOTES, DEFAULT_DEEP_RESEARCH_LIMITS.notesPerRound),
    snippetChars: clamp(merged.snippetChars, 80, 4000, DEFAULT_DEEP_RESEARCH_LIMITS.snippetChars),
  }
}

/** Injected one-shot completion: takes (system, user) and resolves the reply. */
export type CompleteFn = (system: string, user: string) => Promise<string>

/** Injected retrieval over the corpus (defaults to the shared BM25 retriever). */
export type RetrieveFn = (docs: RetrievalDoc[], query: string, limit: number) => RetrievalHitLike[]

interface RetrievalHitLike {
  noteUuid: string
  noteTitle: string
}

/** Progress callback so the UI can surface "searching… reading N notes… synthesizing…". */
export type ProgressFn = (phase: DeepResearchProgress) => void

export type DeepResearchProgress =
  | { kind: 'searching' }
  | { kind: 'reading'; noteCount: number; round: number }
  | { kind: 'refining'; round: number }
  | { kind: 'synthesizing' }

export interface DeepResearchOptions {
  limits?: Partial<DeepResearchLimits>
  retrieve?: RetrieveFn
  onProgress?: ProgressFn
  signal?: AbortSignal
}

export const DEEP_RESEARCH_REFINE_SYSTEM_PROMPT =
  'You are a research assistant working ONLY over the user\'s own notes (a local, private corpus — you have NO web ' +
  'access). You are given a research question and a numbered set of note excerpts already read. Decide whether you ' +
  'have enough to answer. Reply with ONLY a compact JSON object: ' +
  '{"done": true} when you have enough, or {"done": false, "more": [n, ...]} listing the numbers of UNREAD candidate ' +
  'notes (from the "Other candidate notes" list, if shown) you want to read next. No prose, no code fences.'

export const DEEP_RESEARCH_SYNTHESIS_SYSTEM_PROMPT =
  'You are a research assistant writing a final report over the user\'s OWN NOTES only (a local corpus; you have no ' +
  'web access — do not invent outside facts). Using ONLY the provided note excerpts, write a structured report with ' +
  'these sections in Markdown:\n' +
  '## Summary — 2-4 sentences answering the question.\n' +
  '## Findings — concise bullet points, each grounded in the notes; cite the source note by its [n] number.\n' +
  'If the notes do not contain enough to answer, say so plainly. Do not fabricate. Keep it focused. Do not add a ' +
  'Sources section — the application appends the cited note list itself.'

function snippetOf(text: string, max: number): string {
  const body = (text ?? '').replace(/\s+/g, ' ').trim()
  return body.length > max ? `${body.slice(0, max)}…` : body
}

/** Render the read notes as a numbered list for a prompt. */
function renderReadNotes(notes: ResearchNote[], snippetChars: number): string {
  return notes
    .map((note, index) => {
      const title = (note.title || 'Untitled note').trim()
      return `[${index + 1}] ${title}\n${snippetOf(note.text, snippetChars)}`
    })
    .join('\n\n')
}

/** Render still-unread candidate notes (titles only) for the refine prompt. */
function renderCandidates(notes: ResearchNote[], offset: number): string {
  return notes.map((note, index) => `${offset + index + 1}. ${note.title || 'Untitled note'}`).join('\n')
}

interface RefineDecision {
  done: boolean
  /** 1-based candidate numbers (in the candidate list's own numbering) to read next. */
  more: number[]
}

/**
 * Parse the refine reply. Tolerant: accepts the requested JSON object, and also
 * falls back to "done" if it cannot find a request for more notes, so a chatty
 * model never traps the loop. Returns done=true on anything unparseable.
 */
export function parseRefineDecision(reply: string): RefineDecision {
  if (!reply) {
    return { done: true, more: [] }
  }
  const objectMatch = reply.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]) as { done?: unknown; more?: unknown }
      const more = Array.isArray(parsed.more)
        ? parsed.more.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : []
      // Explicit done, or no request for more notes → stop.
      if (parsed.done === true || more.length === 0) {
        return { done: true, more: [] }
      }
      return { done: false, more }
    } catch {
      /* fall through */
    }
  }
  return { done: true, more: [] }
}

/**
 * Run the bounded deep-research loop over the supplied corpus and return a cited
 * report. Pure aside from the injected `complete`/`retrieve`/`onProgress`. Never
 * reads more than `maxNotes` notes, never runs more than `maxRounds` model
 * rounds, and truncates every excerpt to `snippetChars` — so token use and data
 * exposure are bounded regardless of corpus size.
 */
export async function runDeepResearch(
  question: string,
  corpus: ResearchNote[],
  complete: CompleteFn,
  options: DeepResearchOptions = {},
): Promise<DeepResearchReport> {
  const limits = clampLimits(options.limits)
  const retrieveFn = options.retrieve ?? ((docs, query, limit) => defaultRetrieve(docs, query, { limit, perNote: true }))
  const onProgress = options.onProgress
  const aborted = () => options.signal?.aborted === true

  const trimmedQuestion = question.trim()
  const baseReport = (
    report: string,
    sources: CitedSource[],
    rounds: number,
    stopReason: DeepResearchReport['stopReason'],
  ): DeepResearchReport => ({ question: trimmedQuestion, report, sources, rounds, stopReason })

  if (!trimmedQuestion) {
    return baseReport('', [], 0, 'no-candidates')
  }

  // 1. Retrieve candidate notes (bounded: at most maxNotes considered overall).
  onProgress?.({ kind: 'searching' })
  const corpusByUuid = new Map(corpus.map((note) => [note.uuid, note]))
  const docs: RetrievalDoc[] = corpus.map((note) => ({ uuid: note.uuid, title: note.title, text: note.text }))
  const hits = retrieveFn(docs, trimmedQuestion, limits.maxNotes)
  const rankedCandidates: ResearchNote[] = []
  const candidateSeen = new Set<string>()
  for (const hit of hits) {
    if (candidateSeen.has(hit.noteUuid)) {
      continue
    }
    const note = corpusByUuid.get(hit.noteUuid)
    if (note) {
      candidateSeen.add(hit.noteUuid)
      rankedCandidates.push(note)
    }
    if (rankedCandidates.length >= limits.maxNotes) {
      break
    }
  }

  if (rankedCandidates.length === 0) {
    return baseReport(
      'No notes in your library matched this question, so there was nothing to research. Try rephrasing, or broaden the question.',
      [],
      0,
      'no-candidates',
    )
  }

  // 2. Read the initial bounded set; the rest stay as "unread candidates".
  const read: ResearchNote[] = rankedCandidates.slice(0, Math.min(limits.initialNotes, limits.maxNotes))
  let unread: ResearchNote[] = rankedCandidates.slice(read.length)
  const readUuids = new Set(read.map((note) => note.uuid))

  let rounds = 0
  let stopReason: DeepResearchReport['stopReason'] = 'max-rounds'

  // 3. Bounded refine loop. Each round optionally pulls in more notes, capped by
  //    maxNotes and notesPerRound, until the model is done or limits are hit.
  for (let round = 1; round <= limits.maxRounds; round++) {
    if (aborted()) {
      return baseReport('', toSources(read, limits.snippetChars), rounds, 'aborted')
    }
    onProgress?.({ kind: round === 1 ? 'reading' : 'refining', noteCount: read.length, round } as DeepResearchProgress)
    rounds = round

    // No more notes to offer, or we've hit the global note budget → stop refining.
    if (unread.length === 0 || read.length >= limits.maxNotes) {
      stopReason = unread.length === 0 ? 'no-new-notes' : 'model-finished'
      // Still give the model one decision opportunity? No — without unread notes,
      // refining cannot add anything, so proceed straight to synthesis.
      break
    }

    const readBlock = renderReadNotes(read, limits.snippetChars)
    const candidateBlock = renderCandidates(unread, read.length)
    const user =
      `Research question: ${trimmedQuestion}\n\n` +
      `Notes already read:\n${readBlock}\n\n` +
      `Other candidate notes (not yet read):\n${candidateBlock}\n\n` +
      `You have read ${read.length} of a maximum ${limits.maxNotes} notes. ` +
      `Reply with {"done": true} or {"done": false, "more": [...]} (numbers from the candidate list above, at most ${limits.notesPerRound}).`

    const reply = await complete(DEEP_RESEARCH_REFINE_SYSTEM_PROMPT, user)
    if (aborted()) {
      return baseReport('', toSources(read, limits.snippetChars), rounds, 'aborted')
    }

    const decision = parseRefineDecision(reply)
    if (decision.done) {
      stopReason = 'model-finished'
      break
    }

    // Resolve requested candidate numbers (which are 1-based over the WHOLE list:
    // read.length + position in unread) back to unread notes, bounded per round.
    const requestedNotes: ResearchNote[] = []
    for (const number of decision.more) {
      const unreadIndex = number - 1 - read.length
      const candidate = unread[unreadIndex]
      if (candidate && !readUuids.has(candidate.uuid)) {
        requestedNotes.push(candidate)
      }
      if (requestedNotes.length >= limits.notesPerRound) {
        break
      }
    }

    if (requestedNotes.length === 0) {
      // Model asked for notes we couldn't map; nothing new to add → stop.
      stopReason = 'model-finished'
      break
    }

    for (const note of requestedNotes) {
      if (read.length >= limits.maxNotes) {
        break
      }
      read.push(note)
      readUuids.add(note.uuid)
    }
    unread = unread.filter((note) => !readUuids.has(note.uuid))

    if (round === limits.maxRounds) {
      stopReason = 'max-rounds'
    }
  }

  // 4. Synthesize the final cited report from the notes actually read.
  if (aborted()) {
    return baseReport('', toSources(read, limits.snippetChars), rounds, 'aborted')
  }
  onProgress?.({ kind: 'synthesizing' })

  const numbered = read
    .map((note, index) => `[${index + 1}] ${note.title || 'Untitled note'}\n${snippetOf(note.text, limits.snippetChars)}`)
    .join('\n\n')
  const synthUser =
    `Research question: ${trimmedQuestion}\n\n` +
    `Note excerpts (cite by [n]):\n${numbered}\n\n` +
    `Write the report now using only these notes.`
  const report = await complete(DEEP_RESEARCH_SYNTHESIS_SYSTEM_PROMPT, synthUser)

  return baseReport(report.trim(), toSources(read, limits.snippetChars), rounds, stopReason)
}

function toSources(read: ResearchNote[], snippetChars: number): CitedSource[] {
  return read.map((note) => ({
    uuid: note.uuid,
    title: note.title || 'Untitled note',
    snippet: snippetOf(note.text, Math.min(snippetChars, 200)),
  }))
}
