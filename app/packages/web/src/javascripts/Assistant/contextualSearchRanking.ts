// AI-assisted CONTEXTUAL search re-ranking.
//
// This builds ON the existing algorithmic search (operator filter + local
// relevance / inverted-index / BM25 ordering in ItemListController). It does NOT
// replace any of that: the algorithmic pipeline first narrows and orders the
// candidate notes; this module optionally takes the TOP-N of those candidates and
// asks the configured AI provider to re-rank just those few by semantic relevance
// to the query, then the controller applies that ordering on top.
//
// Bounded exposure: only the top-N candidates' titles + short snippets and the
// query are ever sent — never the whole library, never full note bodies. This is
// provider-dependent re-ranking of a small candidate set, NOT a semantic index
// over all notes (that would require an embeddings store and is out of scope).
//
// Everything here is a PURE function of its inputs (candidate records, a query,
// and an injected "complete" function), so the provider can be mocked and the
// candidate-bounding / ordering logic unit-tested in isolation.

/** Default cap on how many algorithmic candidates are sent to the model. */
export const DEFAULT_AI_RERANK_CANDIDATE_LIMIT = 20

/** Max characters of the snippet sent per candidate, to bound prompt size. */
export const AI_RERANK_SNIPPET_CHARS = 280

/** A single candidate note presented to the model for re-ranking. */
export interface RerankCandidate {
  uuid: string
  title: string
  /** Plain-text snippet (already extracted from Super/rich notes upstream). */
  text: string
}

export interface SelectCandidatesOptions {
  /** Max candidates to keep (default DEFAULT_AI_RERANK_CANDIDATE_LIMIT). */
  limit?: number
  /** Max snippet chars per candidate (default AI_RERANK_SNIPPET_CHARS). */
  snippetChars?: number
}

/**
 * Take the TOP-N already-ordered algorithmic candidates and shape them into the
 * bounded records sent to the model: title kept, body truncated to a short
 * snippet. Preserves the incoming (algorithmic) order. This is the single point
 * that bounds what leaves the device.
 */
export function selectCandidates(
  items: RerankCandidate[],
  options: SelectCandidatesOptions = {},
): RerankCandidate[] {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_AI_RERANK_CANDIDATE_LIMIT
  const snippetChars =
    options.snippetChars && options.snippetChars > 0 ? Math.floor(options.snippetChars) : AI_RERANK_SNIPPET_CHARS

  return items.slice(0, limit).map((item) => {
    const title = (item.title ?? '').trim()
    const body = (item.text ?? '').replace(/\s+/g, ' ').trim()
    const snippet = body.length > snippetChars ? `${body.slice(0, snippetChars)}…` : body
    return { uuid: item.uuid, title, text: snippet }
  })
}

export const AI_RERANK_SYSTEM_PROMPT =
  'You are a search re-ranking assistant. You are given a search query and a numbered list of candidate notes ' +
  '(title and a short snippet each). Re-order the candidates from most to least relevant to the query, judging by ' +
  'meaning and intent rather than exact word overlap. Reply with ONLY a JSON array of the candidate numbers in your ' +
  'preferred order, e.g. [3,1,2]. Include every number exactly once. No prose, no code fences.'

/**
 * Build the user message listing the bounded candidates for the given query.
 * Candidates are numbered 1..N so the model returns a compact ordering of numbers
 * (cheaper and easier to parse than echoing uuids/titles).
 */
export function buildRerankPrompt(query: string, candidates: RerankCandidate[]): string {
  const lines = candidates.map((candidate, index) => {
    const title = candidate.title || 'Untitled note'
    const snippet = candidate.text ? ` — ${candidate.text}` : ''
    return `${index + 1}. ${title}${snippet}`
  })
  return `Query: ${query}\n\nCandidates:\n${lines.join('\n')}`
}

/**
 * Parse the model's reply into an ordering of candidate uuids. Accepts a JSON
 * array of 1-based indices (the requested format) and also tolerates a
 * loosely-formatted list of numbers. Out-of-range / duplicate indices are
 * ignored; any candidate the model omitted is appended in its original order, so
 * the result is always a complete, stable permutation of the input uuids.
 *
 * Returns null when nothing usable could be parsed, so the caller can keep the
 * existing algorithmic order untouched.
 */
export function parseRerankResponse(response: string, candidates: RerankCandidate[]): string[] | null {
  if (!response || candidates.length === 0) {
    return null
  }

  const numbers = extractOrderingNumbers(response)
  if (numbers.length === 0) {
    return null
  }

  const ordered: string[] = []
  const seen = new Set<number>()
  for (const n of numbers) {
    const index = n - 1
    if (index < 0 || index >= candidates.length || seen.has(index)) {
      continue
    }
    seen.add(index)
    ordered.push(candidates[index].uuid)
  }

  if (ordered.length === 0) {
    return null
  }

  // Append any candidates the model left out, keeping their original order so
  // nothing the algorithmic search surfaced disappears.
  for (let index = 0; index < candidates.length; index++) {
    if (!seen.has(index)) {
      ordered.push(candidates[index].uuid)
    }
  }

  return ordered
}

function extractOrderingNumbers(response: string): number[] {
  const trimmed = response.trim()

  // Preferred path: a JSON array somewhere in the reply.
  const arrayMatch = trimmed.match(/\[[\s\S]*?\]/)
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown
      if (Array.isArray(parsed)) {
        const nums = parsed
          .map((value) => (typeof value === 'number' ? value : Number(value)))
          .filter((value) => Number.isInteger(value))
        if (nums.length > 0) {
          return nums
        }
      }
    } catch {
      /* fall through to loose parsing */
    }
  }

  // Loose fallback: pull integers out of the text in order.
  const loose = trimmed.match(/\d+/g)
  if (loose) {
    return loose.map((value) => Number(value)).filter((value) => Number.isInteger(value))
  }
  return []
}

/**
 * Apply an ordering of uuids to the full item list. Items whose uuid is in
 * `orderedUuids` are placed first in that order; everything else keeps its
 * existing relative order after them (stable). A no-op returning the input
 * unchanged when there is no ordering — so the default-off path is exactly the
 * existing algorithmic ordering.
 */
export function applyAiOrdering<T extends { uuid: string }>(items: T[], orderedUuids: string[] | null): T[] {
  if (!orderedUuids || orderedUuids.length === 0 || items.length === 0) {
    return items
  }
  const rankByUuid = new Map<string, number>()
  orderedUuids.forEach((uuid, index) => rankByUuid.set(uuid, index))

  return [...items].sort((a, b) => {
    const rankA = rankByUuid.has(a.uuid) ? (rankByUuid.get(a.uuid) as number) : Number.MAX_SAFE_INTEGER
    const rankB = rankByUuid.has(b.uuid) ? (rankByUuid.get(b.uuid) as number) : Number.MAX_SAFE_INTEGER
    return rankA - rankB
  })
}

/** Injected one-shot completion: takes (system, user) and resolves the reply. */
export type CompleteFn = (system: string, user: string) => Promise<string>

export interface RerankResult {
  /** Complete, stable permutation of the candidate uuids, best match first. */
  orderedUuids: string[]
}

/**
 * Run a single bounded re-rank completion over the given candidates and return
 * the resulting uuid ordering. The provider call is injected via `complete` so
 * this stays testable. Returns null when there is nothing to rank or the model's
 * reply could not be parsed (caller keeps the algorithmic order).
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
  complete: CompleteFn,
  options: SelectCandidatesOptions = {},
): Promise<RerankResult | null> {
  const trimmedQuery = query.trim()
  if (trimmedQuery.length === 0) {
    return null
  }
  const bounded = selectCandidates(candidates, options)
  // Fewer than two candidates: nothing to re-order; don't spend a model call.
  if (bounded.length < 2) {
    return null
  }

  const user = buildRerankPrompt(trimmedQuery, bounded)
  const reply = await complete(AI_RERANK_SYSTEM_PROMPT, user)
  const orderedUuids = parseRerankResponse(reply, bounded)
  if (!orderedUuids) {
    return null
  }
  return { orderedUuids }
}
