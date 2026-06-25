// Message protocol shared between the main thread and the search-index Web Worker
// (searchIndex.worker.ts). Kept in its own dependency-free module so both sides
// import the exact same types without pulling the worker's runtime into the main
// bundle (or vice-versa).

import { IndexableNote, SearchIndexOptions, SearchIndexSnapshot, SearchQueryOptions } from './SearchIndex'

/** Messages posted FROM the main thread TO the worker. */
export type SearchIndexWorkerRequest =
  | { type: 'configure'; requestId: number; options: SearchIndexOptions }
  | { type: 'rebuild'; requestId: number; notes: IndexableNote[] }
  | { type: 'updateMany'; requestId: number; changedOrInserted: IndexableNote[]; removed: string[] }
  | { type: 'search'; requestId: number; query: string; options: SearchQueryOptions }
  | { type: 'flush'; requestId: number }

/** Messages posted FROM the worker BACK TO the main thread. */
export type SearchIndexWorkerResponse =
  | { type: 'configured'; requestId: number }
  | { type: 'rebuilt'; requestId: number; size: number; snapshot: SearchIndexSnapshot | null }
  | { type: 'updated'; requestId: number; size: number; snapshot: SearchIndexSnapshot | null }
  | { type: 'searched'; requestId: number; result: string[] | null }
  | { type: 'flushed'; requestId: number }
  | { type: 'error'; requestId: number; message: string }
