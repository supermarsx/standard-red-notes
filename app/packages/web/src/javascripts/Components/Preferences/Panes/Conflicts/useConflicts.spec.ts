import { SNNote } from '@standardnotes/snjs'
import { buildConflictPairs, ConflictPair, isComparableConflictPair } from './useConflicts'

/**
 * The conflict list used to require the original note to still exist before it would
 * show a conflicted copy. That hid exactly the copies that matter most: when the
 * original is gone, the copy is the only surviving carrier of the user's content, so
 * it is the one case where staying silent loses the work in practice even though the
 * sync layer preserved it.
 */
const note = (uuid: string, conflictOf?: string) => ({ uuid, conflictOf }) as unknown as SNNote

const findIn =
  (...notes: SNNote[]) =>
  (uuid: string) =>
    notes.find((candidate) => candidate.uuid === uuid)

describe('buildConflictPairs', () => {
  it('lists a conflicted copy whose original was deleted, with no original attached', () => {
    const copy = note('copy-uuid', 'original-uuid')

    const pairs = buildConflictPairs([copy], findIn(copy))

    expect(pairs).toHaveLength(1)
    expect(pairs[0].id).toEqual('copy-uuid')
    expect(pairs[0].conflictedCopy).toBe(copy)
    expect(pairs[0].original).toBeUndefined()
    expect(isComparableConflictPair(pairs[0])).toBe(false)
  })

  it('still pairs a conflicted copy with its original when the original survives', () => {
    const original = note('original-uuid')
    const copy = note('copy-uuid', 'original-uuid')

    const pairs = buildConflictPairs([original, copy], findIn(original, copy))

    expect(pairs).toHaveLength(1)
    expect(pairs[0].original).toBe(original)
    expect(pairs[0].conflictedCopy).toBe(copy)
    expect(isComparableConflictPair(pairs[0])).toBe(true)
  })

  it('ignores notes that are not conflicted copies', () => {
    const plain = note('plain-uuid')
    const other = note('other-uuid')

    expect(buildConflictPairs([plain, other], findIn(plain, other))).toEqual([])
  })

  it('lists both an orphaned copy and an ordinary pair together', () => {
    const original = note('original-uuid')
    const pairedCopy = note('paired-copy', 'original-uuid')
    const orphanedCopy = note('orphaned-copy', 'long-gone-uuid')

    const pairs = buildConflictPairs([original, pairedCopy, orphanedCopy], findIn(original, pairedCopy, orphanedCopy))

    expect(pairs.map((pair) => pair.id)).toEqual(['paired-copy', 'orphaned-copy'])
    expect(pairs.filter(isComparableConflictPair)).toHaveLength(1)
  })
})

describe('isComparableConflictPair', () => {
  it('narrows only when an original is present', () => {
    const original = note('original-uuid')
    const withOriginal = { id: 'a', original, conflictedCopy: note('a') } as ConflictPair
    const withoutOriginal = { id: 'b', original: undefined, conflictedCopy: note('b') } as ConflictPair

    expect(isComparableConflictPair(withOriginal)).toBe(true)
    expect(isComparableConflictPair(withoutOriginal)).toBe(false)
  })
})
