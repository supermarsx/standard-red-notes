/**
 * @jest-environment jsdom
 *
 * The block catalog is the single source of truth for which block types a
 * typography profile can carry. These tests lock in its COMPLETENESS (the guard
 * against the original BLOCK_KEYS-was-incomplete bug), its grouping and its order.
 */
import { DEFAULT_TYPOGRAPHY_PROFILE, type BlockTypeKey } from '@standardnotes/models'
import {
  BLOCK_CATALOG,
  BLOCK_CATALOG_GROUPS,
  BLOCK_CATALOG_KEYS,
  BLOCK_GROUP_ORDER,
  blockCatalogIndex,
  blockLabel,
  isBlockCatalogKey,
} from './typographyProfileBlockCatalog'

// The full block universe from the model, listed independently so a drift between
// the model and the catalog is caught here.
const ALL_BLOCK_KEYS: BlockTypeKey[] = [
  'paragraph',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'quote',
  'code',
  'callout',
  'bulletList',
  'numberedList',
  'checkList',
  'title',
  'normalSpaced',
  'accented',
  'strong',
  'emphasis',
]

describe('typographyProfileBlockCatalog', () => {
  it('covers EVERY block key in the model (completeness guard)', () => {
    expect([...BLOCK_CATALOG_KEYS].sort()).toEqual([...ALL_BLOCK_KEYS].sort())
    expect(BLOCK_CATALOG).toHaveLength(ALL_BLOCK_KEYS.length)
  })

  it('includes the blocks the old BLOCK_KEYS bug dropped', () => {
    for (const key of ['h4', 'h5', 'title', 'normalSpaced', 'accented', 'strong', 'emphasis'] as BlockTypeKey[]) {
      expect(BLOCK_CATALOG_KEYS).toContain(key)
    }
  })

  it('covers every block the Default profile styles', () => {
    for (const key of Object.keys(DEFAULT_TYPOGRAPHY_PROFILE.blocks) as BlockTypeKey[]) {
      expect(BLOCK_CATALOG_KEYS).toContain(key)
    }
  })

  it('has no duplicate keys', () => {
    expect(new Set(BLOCK_CATALOG_KEYS).size).toBe(BLOCK_CATALOG_KEYS.length)
  })

  it('groups the paragraph variants under "Variants" and the rest under "Blocks"', () => {
    const groupOf = (key: BlockTypeKey) => BLOCK_CATALOG.find((e) => e.key === key)!.group
    for (const key of ['title', 'normalSpaced', 'accented', 'strong', 'emphasis'] as BlockTypeKey[]) {
      expect(groupOf(key)).toBe('variants')
    }
    for (const key of ['paragraph', 'h1', 'h4', 'quote', 'code', 'callout', 'bulletList'] as BlockTypeKey[]) {
      expect(groupOf(key)).toBe('blocks')
    }
  })

  it('exposes ordered groups whose entries reconstruct the full catalog', () => {
    expect(BLOCK_CATALOG_GROUPS.map((g) => g.id)).toEqual(BLOCK_GROUP_ORDER)
    const recombined = BLOCK_CATALOG_GROUPS.flatMap((g) => g.entries.map((e) => e.key))
    expect(new Set(recombined)).toEqual(new Set(BLOCK_CATALOG_KEYS))
  })

  it('provides labels and a working key guard', () => {
    expect(blockLabel('h4')).toBe('Heading 4')
    expect(blockLabel('normalSpaced')).toBe('Normal (spaced)')
    expect(blockLabel('notAKey')).toBe('notAKey')
    expect(isBlockCatalogKey('paragraph')).toBe(true)
    expect(isBlockCatalogKey('notAKey')).toBe(false)
    expect(blockCatalogIndex('paragraph')).toBe(0)
    expect(blockCatalogIndex('notAKey')).toBe(-1)
  })
})
