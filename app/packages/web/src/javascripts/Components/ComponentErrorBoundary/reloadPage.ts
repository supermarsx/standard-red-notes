/**
 * Fetch the whole document again.
 *
 * For a code-split chunk that failed to load this is not one remedy among
 * several, it is the only one. React's `lazyInitializer` consults a `lazy()`
 * factory exactly once — the Pending transition overwrites the stored factory
 * with the in-flight thenable — and a rejection parks the payload at Rejected,
 * from which every later render re-throws the stored error. Nothing inside the
 * page can undo that: not re-rendering, not resetting an error boundary, not
 * re-creating the wrapper, because the factory is no longer reachable from the
 * lazy object at all. A new document is the only thing that re-requests the
 * chunk.
 *
 * `target` defaults to the page's own window, which is what product code uses;
 * naming it keeps the behaviour of this function observable.
 */
export const reloadPage = (target: Pick<Window, 'location'> = window): void => {
  target.location.reload()
}

export default reloadPage
