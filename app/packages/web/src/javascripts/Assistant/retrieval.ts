// Local, dependency-free relevance retrieval over the user's notes ("RAG-like").
//
// Notes are end-to-end encrypted and only decrypted in the browser, so retrieval
// must run entirely client-side with no external embedding service. This uses
// BM25 ranking over note paragraphs (chunks): it scores passages by term
// frequency, term rarity (IDF) and length normalization, then returns the most
// relevant snippets with their note uuids. That gives the agent focused context
// to answer a question without reading every note, and ranks better than a plain
// substring search — while staying private and offline.

export interface RetrievalDoc {
  uuid: string
  title: string
  text: string
}

export interface RetrievalHit {
  noteUuid: string
  noteTitle: string
  /** The most relevant passage from the note, truncated for prompt economy. */
  snippet: string
  /** BM25 relevance score (higher is more relevant). */
  score: number
  chunkIndex: number
}

export interface RetrieveOptions {
  /** Max passages to return (default 5). */
  limit?: number
  /** Collapse to the single best passage per note before taking the top results. */
  perNote?: boolean
}

// A small, conservative stopword list. Kept short on purpose: aggressive
// stopword removal hurts short-note retrieval more than it helps.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'at', 'by',
  'be', 'this', 'that', 'are', 'was', 'from', 'but', 'not', 'i', 'you', 'we', 'they', 'he', 'she',
])

const MAX_CHUNK_CHARS = 600
const SNIPPET_CHARS = 400
const BM25_K1 = 1.5
const BM25_B = 0.75

function tokenize(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9]+/g)
  if (!matches) {
    return []
  }
  return matches.filter((token) => token.length > 1)
}

/**
 * Split a note into passage-sized chunks: paragraphs first, then windowed if a
 * paragraph is very long. The title is prepended so a query matching the title
 * surfaces the note's opening passage.
 */
function chunkNote(title: string, text: string): string[] {
  const full = `${title ? `${title}\n` : ''}${text ?? ''}`.trim()
  if (!full) {
    return []
  }
  const paragraphs = full
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  const chunks: string[] = []
  for (const paragraph of paragraphs) {
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      chunks.push(paragraph)
    } else {
      for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARS) {
        chunks.push(paragraph.slice(offset, offset + MAX_CHUNK_CHARS))
      }
    }
  }
  return chunks.length > 0 ? chunks : [full]
}

interface ScoredChunk {
  noteUuid: string
  noteTitle: string
  chunkIndex: number
  text: string
  length: number
  termFrequencies: Map<string, number>
}

export function retrieve(docs: RetrievalDoc[], query: string, options: RetrieveOptions = {}): RetrievalHit[] {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 5
  const queryTerms = [...new Set(tokenize(query).filter((term) => !STOPWORDS.has(term)))]
  if (queryTerms.length === 0) {
    return []
  }

  const chunks: ScoredChunk[] = []
  for (const doc of docs) {
    chunkNote(doc.title, doc.text).forEach((chunkText, chunkIndex) => {
      const tokens = tokenize(chunkText)
      if (tokens.length === 0) {
        return
      }
      const termFrequencies = new Map<string, number>()
      for (const token of tokens) {
        termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1)
      }
      chunks.push({
        noteUuid: doc.uuid,
        noteTitle: doc.title,
        chunkIndex,
        text: chunkText,
        length: tokens.length,
        termFrequencies,
      })
    })
  }

  const totalChunks = chunks.length
  if (totalChunks === 0) {
    return []
  }

  const averageLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0) / totalChunks

  // Document frequency: how many chunks contain each query term.
  const documentFrequency = new Map<string, number>()
  for (const term of queryTerms) {
    let count = 0
    for (const chunk of chunks) {
      if (chunk.termFrequencies.has(term)) {
        count += 1
      }
    }
    documentFrequency.set(term, count)
  }

  const idf = (term: string): number => {
    const n = documentFrequency.get(term) ?? 0
    return Math.log(1 + (totalChunks - n + 0.5) / (n + 0.5))
  }

  const scored = chunks
    .map((chunk) => {
      let score = 0
      for (const term of queryTerms) {
        const frequency = chunk.termFrequencies.get(term) ?? 0
        if (frequency === 0) {
          continue
        }
        const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.length) / (averageLength || 1))
        score += idf(term) * ((frequency * (BM25_K1 + 1)) / denominator)
      }
      return { chunk, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)

  let ranked = scored
  if (options.perNote) {
    const bestPerNote = new Map<string, (typeof scored)[number]>()
    for (const entry of scored) {
      const current = bestPerNote.get(entry.chunk.noteUuid)
      if (!current || entry.score > current.score) {
        bestPerNote.set(entry.chunk.noteUuid, entry)
      }
    }
    ranked = [...bestPerNote.values()].sort((a, b) => b.score - a.score)
  }

  return ranked.slice(0, limit).map((entry) => ({
    noteUuid: entry.chunk.noteUuid,
    noteTitle: entry.chunk.noteTitle,
    snippet:
      entry.chunk.text.length > SNIPPET_CHARS ? `${entry.chunk.text.slice(0, SNIPPET_CHARS)}…` : entry.chunk.text,
    score: Math.round(entry.score * 1000) / 1000,
    chunkIndex: entry.chunk.chunkIndex,
  }))
}
