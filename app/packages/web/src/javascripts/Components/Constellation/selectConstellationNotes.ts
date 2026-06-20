/**
 * Pure scoping helpers for the Constellation graph.
 *
 * These functions decide *which* note uuids belong in the graph for a given
 * scope. They are deliberately free of any snjs/application dependency so they
 * can be unit-tested in isolation. The caller (ConstellationView) is responsible
 * for resolving the actual note objects and their links into the simple shapes
 * consumed here.
 */

export type ConstellationScopeKind = 'current' | 'global' | 'tag' | 'folder'

export type ConstellationScope = {
  kind: ConstellationScopeKind
  /** For 'tag' / 'folder' scopes: the uuid of the selected tag or folder. */
  collectionUuid?: string
}

/** Minimal note shape needed for scoping. */
export type ScopeNote = { uuid: string }

/**
 * Adjacency provider: given a note uuid, returns the uuids of notes it is
 * linked to *or* linked from (an undirected note-to-note neighborhood). The
 * caller merges `referencesForItem` (outgoing links) and `itemsReferencingItem`
 * (backlinks) so the neighborhood is symmetric.
 */
export type NoteAdjacency = (uuid: string) => string[]

/**
 * Number of hops to expand outward from the active note for the 'current'
 * scope. 1 = the note plus its direct links/backlinks. We allow up to 2 so the
 * immediate neighborhood is visible while staying bounded for performance.
 */
export const CURRENT_SCOPE_DEFAULT_HOPS = 1
export const CURRENT_SCOPE_MAX_HOPS = 2

/** Hard cap on the number of nodes a scoped neighborhood may include. */
export const CURRENT_SCOPE_MAX_NODES = 400

/**
 * Build the bounded neighborhood of a note: the note itself plus every note
 * reachable within `hops` undirected note-to-note links. The traversal is a
 * breadth-first walk capped at `maxNodes` so a densely linked note can never
 * blow up the graph.
 */
export function buildNoteNeighborhood(
  rootUuid: string,
  adjacency: NoteAdjacency,
  options: { hops?: number; maxNodes?: number } = {},
): Set<string> {
  const hops = Math.max(1, Math.min(options.hops ?? CURRENT_SCOPE_DEFAULT_HOPS, CURRENT_SCOPE_MAX_HOPS))
  const maxNodes = options.maxNodes ?? CURRENT_SCOPE_MAX_NODES

  const included = new Set<string>([rootUuid])
  let frontier = [rootUuid]

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const uuid of frontier) {
      for (const neighbor of adjacency(uuid)) {
        if (included.has(neighbor)) {
          continue
        }
        included.add(neighbor)
        next.push(neighbor)
        if (included.size >= maxNodes) {
          return included
        }
      }
    }
    frontier = next
  }

  return included
}

/**
 * Resolve the set of note uuids that should appear in the graph for the given
 * scope.
 *
 * - 'global': every note.
 * - 'current': the active note's bounded neighborhood (see buildNoteNeighborhood).
 *   Returns an empty set when there is no active note.
 * - 'tag' / 'folder': the notes belonging to the selected collection. Returns an
 *   empty set when no collection is selected.
 *
 * `collectionNoteUuids` is the precomputed membership for the selected tag/folder
 * (the caller derives it from `tag.noteReferences` / `referencesForItem`).
 */
export function selectConstellationNoteUuids(params: {
  scope: ConstellationScope
  allNotes: ScopeNote[]
  activeNoteUuid?: string
  adjacency?: NoteAdjacency
  collectionNoteUuids?: string[]
  hops?: number
  maxNodes?: number
}): Set<string> {
  const { scope, allNotes, activeNoteUuid, adjacency, collectionNoteUuids } = params
  const all = new Set(allNotes.map((n) => n.uuid))

  switch (scope.kind) {
    case 'global':
      return all

    case 'current': {
      if (!activeNoteUuid || !all.has(activeNoteUuid) || !adjacency) {
        return new Set<string>()
      }
      const neighborhood = buildNoteNeighborhood(activeNoteUuid, adjacency, {
        hops: params.hops,
        maxNodes: params.maxNodes,
      })
      // Only keep uuids that are real, displayable notes.
      return new Set([...neighborhood].filter((uuid) => all.has(uuid)))
    }

    case 'tag':
    case 'folder': {
      if (!scope.collectionUuid || !collectionNoteUuids) {
        return new Set<string>()
      }
      return new Set(collectionNoteUuids.filter((uuid) => all.has(uuid)))
    }

    default:
      return all
  }
}
