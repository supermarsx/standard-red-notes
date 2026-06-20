import { ContentType, DecryptedItemInterface } from '@standardnotes/snjs'
import { findItemsReferencingItem } from './findItemsReferencingItem'

const makeItem = (uuid: string, referencedUuids: string[] = []): DecryptedItemInterface => {
  return {
    uuid,
    content_type: ContentType.TYPES.Note,
    references: referencedUuids.map((u) => ({ uuid: u, reference_type: 'note-to-note' })),
  } as unknown as DecryptedItemInterface
}

describe('findItemsReferencingItem', () => {
  it('returns items that reference the target', () => {
    const target = makeItem('target')
    const referencingA = makeItem('a', ['target'])
    const referencingB = makeItem('b', ['target', 'other'])
    const unrelated = makeItem('c', ['other'])

    const result = findItemsReferencingItem([target, referencingA, referencingB, unrelated], target)

    expect(result.map((i) => i.uuid).sort()).toEqual(['a', 'b'])
  })

  it('excludes the target itself even if it self-references', () => {
    const target = makeItem('target', ['target'])
    const referencing = makeItem('a', ['target'])

    const result = findItemsReferencingItem([target, referencing], target)

    expect(result.map((i) => i.uuid)).toEqual(['a'])
  })

  it('returns an empty array when nothing references the target', () => {
    const target = makeItem('target')
    const other = makeItem('a', ['somethingElse'])

    const result = findItemsReferencingItem([target, other], target)

    expect(result).toEqual([])
  })

  it('returns an empty array for an invalid target', () => {
    const other = makeItem('a', ['target'])

    expect(findItemsReferencingItem([other], { uuid: '' })).toEqual([])
  })
})
