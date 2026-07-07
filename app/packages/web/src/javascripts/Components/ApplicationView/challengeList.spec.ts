import { Challenge } from '@standardnotes/snjs'
import { addChallengeToList, removeChallengeFromList } from './challengeList'

/**
 * Standard Red Notes: regression guard for STACKED challenges.
 *
 * ApplicationView keeps every open challenge in a single `challenges` array and
 * mutates it exclusively through these two pure reducers, always via a
 * functional `setChallenges((prev) => ...)` updater. The bug they fix: the
 * `receiveChallenge` handler is registered once and used to close over the
 * initial (empty) `challenges` state, so a SECOND challenge arriving while a
 * first was still open replaced the first instead of appending — which could
 * drop a gating unlock/2FA challenge and wedge the app.
 *
 * These tests pin the reducer contract the functional updater relies on:
 * appending stacks (never replaces) and removing one leaves the others intact.
 * The reducers only ever compare/return the challenge objects, so lightweight
 * stand-ins cast to Challenge are sufficient.
 */

const makeChallenge = (id: string): Challenge => ({ id }) as unknown as Challenge

describe('challengeList reducers', () => {
  describe('addChallengeToList', () => {
    it('appends onto an empty list', () => {
      const a = makeChallenge('a')
      expect(addChallengeToList([], a)).toEqual([a])
    })

    it('STACKS a second challenge instead of replacing the first (the bug)', () => {
      const first = makeChallenge('first')
      const second = makeChallenge('second')

      const afterFirst = addChallengeToList([], first)
      const afterSecond = addChallengeToList(afterFirst, second)

      expect(afterSecond).toEqual([first, second])
      // Both are present — the gating first challenge is NOT lost.
      expect(afterSecond).toContain(first)
      expect(afterSecond).toContain(second)
    })

    it('does not mutate the input list', () => {
      const first = makeChallenge('first')
      const list = [first]
      const result = addChallengeToList(list, makeChallenge('second'))
      expect(list).toEqual([first])
      expect(result).not.toBe(list)
    })
  })

  describe('removeChallengeFromList', () => {
    it('removes the dismissed challenge and KEEPS the others', () => {
      const first = makeChallenge('first')
      const second = makeChallenge('second')

      const remaining = removeChallengeFromList([first, second], first)

      expect(remaining).toEqual([second])
      expect(remaining).toContain(second)
      expect(remaining).not.toContain(first)
    })

    it('removes by object identity, not by value', () => {
      const first = makeChallenge('first')
      const second = makeChallenge('second')
      const firstLookalike = makeChallenge('first')

      // A different object (even with the same id) must not remove `first`.
      expect(removeChallengeFromList([first, second], firstLookalike)).toEqual([first, second])
    })

    it('is a no-op when the challenge is absent', () => {
      const first = makeChallenge('first')
      expect(removeChallengeFromList([first], makeChallenge('other'))).toEqual([first])
    })

    it('does not mutate the input list', () => {
      const first = makeChallenge('first')
      const second = makeChallenge('second')
      const list = [first, second]
      const result = removeChallengeFromList(list, first)
      expect(list).toEqual([first, second])
      expect(result).not.toBe(list)
    })
  })

  it('add-then-remove round trip keeps a concurrently-open challenge (end-to-end)', () => {
    const gating = makeChallenge('gating-unlock')
    const later = makeChallenge('later')

    // Two challenges stack while both are open.
    let list = addChallengeToList([], gating)
    list = addChallengeToList(list, later)
    expect(list).toEqual([gating, later])

    // Dismissing the later one must NOT drop the still-open gating challenge.
    list = removeChallengeFromList(list, later)
    expect(list).toEqual([gating])
  })
})
