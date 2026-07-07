import { Challenge } from '@standardnotes/snjs'

/**
 * Pure reducers for ApplicationView's list of open (on-screen) challenges.
 *
 * These live in their own module — separate from the ApplicationView component —
 * for two reasons:
 *
 * 1. Testability: they can be exercised in isolation (see challengeList.spec.ts)
 *    without rendering ApplicationView and its large provider/component tree.
 *
 * 2. Correctness at the call site: both are always applied through a FUNCTIONAL
 *    `setChallenges((prev) => ...)` updater. The `receiveChallenge` handler is
 *    registered once (its effect has dep `[application]`), so a closure that read
 *    the `challenges` state variable directly would capture the INITIAL (empty)
 *    snapshot for the lifetime of the app. A second challenge arriving while a
 *    first is still open would then be appended to that stale empty array and
 *    REPLACE the first challenge — dropping a still-open (possibly gating
 *    unlock/2FA) challenge and potentially wedging the app. Deriving the next
 *    array from `prev` (the latest state) is what makes stacking correct.
 *
 * Both return a NEW array and never mutate the input list.
 */

export const addChallengeToList = (list: Challenge[], challenge: Challenge): Challenge[] => [...list, challenge]

/**
 * Remove a challenge by object identity — the dismissed challenge is the exact
 * object we appended and handed to ChallengeModal, so reference equality removes
 * only that one and leaves any other open challenges untouched.
 */
export const removeChallengeFromList = (list: Challenge[], challenge: Challenge): Challenge[] =>
  list.filter((existing) => existing !== challenge)
