import * as Y from 'yjs'
import {
  documentStateCovers,
  type CollaborationRevisionStamp,
  type CollaborativeDocumentState,
} from './CollaborationRevisionStamp'

/**
 * The live shared document of one note, as the rest of the app may see it: which room epoch it
 * belongs to, how much it contains, and when that changes. Never its content.
 */
export type LiveCollaborativeDocument = {
  epoch: string
  /**
   * Which operations the document holds and which of them it has deleted; `undefined` while the
   * document has not established its state (a newcomer still waiting for a peer's copy holds an
   * empty document, and an empty document proves nothing about what it will contain).
   */
  state(): CollaborativeDocumentState | undefined
  /** Called after every update applied to the document, local or remote. */
  subscribe(listener: () => void): () => void
}

/**
 * The state of a live document as plain data: its state vector and its delete set, which
 * together are what Yjs itself calls a snapshot.
 */
export function documentStateOf(document: Y.Doc): CollaborativeDocumentState {
  const snapshot = Y.snapshot(document)
  const deleted = new Map<number, Array<[number, number]>>()
  for (const [clientId, runs] of snapshot.ds.clients) {
    deleted.set(
      clientId,
      runs.map((run) => [run.clock, run.len] as [number, number]),
    )
  }
  return { stateVector: snapshot.sv, deleted }
}

type Clock = {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: Clock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * App-wide registry of the live shared documents, keyed by note uuid, fed by the collaboration
 * plugin that owns each one. It is how code outside the editor's Lexical tree — the save path,
 * the handler for a note retrieved from the server — can ask the one question it needs answered:
 * does the live document already contain everything in this stored revision?
 */
export class CollaborativeDocumentRegistryImpl {
  private readonly documents = new Map<string, LiveCollaborativeDocument>()

  constructor(private readonly clock: Clock = systemClock) {}

  /** Register the live document for a room. The returned function removes exactly this registration. */
  set(room: string, document: LiveCollaborativeDocument): () => void {
    this.documents.set(room, document)
    return () => {
      if (this.documents.get(room) === document) {
        this.documents.delete(room)
      }
    }
  }

  get(room: string): LiveCollaborativeDocument | undefined {
    return this.documents.get(room)
  }

  /**
   * True only when the live document of `room` is of the stamp's epoch, has established its
   * state, and has applied every insertion and every deletion the stamped revision was
   * serialized from.
   */
  covers(room: string, stamp: CollaborationRevisionStamp): boolean {
    const document = this.documents.get(room)
    if (!document || document.epoch !== stamp.epoch) {
      return false
    }
    let state: CollaborativeDocumentState | undefined
    try {
      state = document.state()
    } catch {
      return false
    }
    return state !== undefined && documentStateCovers(state, stamp)
  }

  /**
   * Resolve true as soon as the live document covers the stamp, or false once
   * `timeoutMilliseconds` have passed without it.
   *
   * A revision saved by someone who was offline holds operations the room has not seen, and the
   * room holds operations it has not: neither covers the other. That is not yet a conflict. The
   * author is reconnecting, and the relay delivers the difference a moment after the stored
   * revision arrives; this is the wait for that moment. Only if it never comes — the author is
   * gone, and so is the only document that could have merged — is the revision something the
   * live document cannot account for.
   */
  whenCovers(room: string, stamp: CollaborationRevisionStamp, timeoutMilliseconds: number): Promise<boolean> {
    if (this.covers(room, stamp)) {
      return Promise.resolve(true)
    }
    const document = this.documents.get(room)
    if (!document || document.epoch !== stamp.epoch || timeoutMilliseconds <= 0) {
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const waiting: { timeout?: unknown; unsubscribe?: () => void } = {}
      const settle = (covered: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        this.clock.clearTimeout(waiting.timeout)
        try {
          waiting.unsubscribe?.()
        } catch {
          // The document went away while this was waiting; the answer below still stands.
        }
        resolve(covered)
      }
      waiting.timeout = this.clock.setTimeout(() => settle(this.covers(room, stamp)), timeoutMilliseconds)
      try {
        waiting.unsubscribe = document.subscribe(() => {
          // A different document may have taken the room over while this waited (a remount);
          // `covers` reads whichever is registered now, which is the one that matters.
          if (this.covers(room, stamp)) {
            settle(true)
          }
        })
      } catch {
        settle(false)
        return
      }
      // The update that completes the merge may have landed between the first check and the
      // subscription.
      if (this.covers(room, stamp)) {
        settle(true)
      }
    })
  }
}

/** App-wide singleton. */
export const CollaborativeDocumentRegistry = new CollaborativeDocumentRegistryImpl()
