import { NoteViewController } from './Controller/NoteViewController'
import { isViewActive } from './noteViewLifecycle'

/**
 * Standard Red Notes: NoteView dealloc-lifecycle race regression.
 *
 * NoteView methods that resolve asynchronously — `onAppLaunch` (awaited),
 * `streamItems`, the template autofocus `setTimeout`, and the re-entrant
 * `reloadPreferences` / `reloadLineWidth` — can fire AFTER the view was torn
 * down (transient template note on a smart view, rapid tab switching). At that
 * point `deinit` has nulled the controller or flipped its `dealloced` flag, so
 * touching `this.application`/`this.note` crashes the React tree.
 *
 * Each of those methods is guarded by `if (!isViewActive(this.controller))
 * return`. NoteView itself is far too heavy to instantiate here (it pulls in the
 * whole editor/Super stack), so the guard decision is extracted into the pure
 * `isViewActive` helper and exercised directly. These tests assert the helper
 * reports a dealloced/missing controller as INACTIVE — which is exactly what
 * makes the guarded methods no-op rather than throw — and that the no-op path
 * never throws.
 */

const controllerWith = (dealloced: boolean): NoteViewController =>
  ({ dealloced }) as unknown as NoteViewController

describe('isViewActive — NoteView dealloc guard', () => {
  it('is active for a live (non-dealloced) controller', () => {
    expect(isViewActive(controllerWith(false))).toBe(true)
  })

  it('is INACTIVE for a dealloced controller (the torn-down race)', () => {
    expect(isViewActive(controllerWith(true))).toBe(false)
  })

  it('is INACTIVE for a missing controller (deinit nulled it)', () => {
    expect(isViewActive(undefined)).toBe(false)
    expect(isViewActive(null)).toBe(false)
  })

  it('never throws on any controller shape', () => {
    expect(() => isViewActive(undefined)).not.toThrow()
    expect(() => isViewActive(null)).not.toThrow()
    expect(() => isViewActive(controllerWith(true))).not.toThrow()
    expect(() => isViewActive(controllerWith(false))).not.toThrow()
  })
})

/**
 * Demonstrates the guarded-method contract: a method that bails on
 * `!isViewActive(controller)` before touching the (now torn-down) application
 * must be a no-op and MUST NOT throw when the view is dealloced. This mirrors the
 * exact guard order used by `onAppLaunch`/`streamItems`/`reloadPreferences`/
 * `reloadLineWidth` and the template autofocus timeout.
 */
describe('guarded async method — no-op when dealloced', () => {
  const guardedReload = (controller: NoteViewController | undefined | null): boolean => {
    if (!isViewActive(controller)) {
      return false
    }
    // Stand-in for `this.application.notesController...` — would throw if the
    // view were torn down; reaching it means the guard let an inactive view
    // through.
    throw new Error('touched torn-down application')
  }

  it('does NOT run its body (and does not throw) for a dealloced controller', () => {
    expect(() => guardedReload(controllerWith(true))).not.toThrow()
    expect(guardedReload(controllerWith(true))).toBe(false)
  })

  it('does NOT run its body for a missing controller', () => {
    expect(() => guardedReload(undefined)).not.toThrow()
    expect(guardedReload(undefined)).toBe(false)
  })

  it('runs its body only for a live controller', () => {
    expect(() => guardedReload(controllerWith(false))).toThrow('touched torn-down application')
  })
})
