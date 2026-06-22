import { NoteViewController } from './Controller/NoteViewController'

/**
 * Standard Red Notes: NoteView dealloc-lifecycle guard.
 *
 * NoteView holds a `controller` (a {@link NoteViewController}) whose `dealloced`
 * flag flips to `true` when the view is torn down — e.g. a transient template
 * note on a smart view, or rapid tab switching. Several NoteView methods resolve
 * ASYNCHRONOUSLY (an awaited `onAppLaunch`, a queued `setTimeout` template
 * autofocus, a `reloadPreferences`/`reloadLineWidth` re-entrant call) and can
 * therefore fire AFTER `deinit` has nulled the controller/application. Touching
 * `this.application`/`this.note` at that point dereferences a torn-down view and
 * crashes the React tree (the NoteView dealloc race).
 *
 * Every such method must bail out unless the view is still active. This predicate
 * IS that single decision, extracted so it can be unit-tested in isolation without
 * instantiating the (very heavy) NoteView component or its editor stack. It is a
 * pure mirror of the inlined `if (!this.controller || this.controller.dealloced)`
 * guard — behaviour-identical — so the methods and this helper can never drift.
 *
 * A view is active iff it still has a controller AND that controller has not been
 * dealloced.
 */
export function isViewActive(controller: NoteViewController | undefined | null): boolean {
  return !!controller && !controller.dealloced
}
