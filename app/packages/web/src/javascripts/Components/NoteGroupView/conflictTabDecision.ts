/**
 * Standard Red Notes: conflict view-tab render/close decision.
 *
 * A `kind: 'conflict'` view tab references a note by uuid. By the time the tab is
 * rendered that note may no longer exist — it was deleted, the conflict was
 * resolved/merged elsewhere, or the item never synced. Rendering the conflict
 * resolution view with a missing `currentNote` dereferences `undefined` and
 * crashes the whole NoteGroupView render; the tab must instead be closed and
 * nothing rendered.
 *
 * `renderActiveViewTab` looks the note up (`application.items.findItem(uuid)`)
 * and passes the result here. This predicate is the single, pure decision —
 * extracted so it is unit-testable without a live application or React render,
 * and a behaviour-identical mirror of the inlined `if (!note) { close } else
 * { render }` branch so the two can never drift.
 *
 * Returns `'render'` when the looked-up note exists, `'close'` when it does not
 * (null/undefined). The caller closes the tab on `'close'` and returns null.
 */
export type ConflictTabDecision = 'render' | 'close'

export function decisionForConflictTab(lookedUpNote: unknown): ConflictTabDecision {
  return lookedUpNote ? 'render' : 'close'
}
