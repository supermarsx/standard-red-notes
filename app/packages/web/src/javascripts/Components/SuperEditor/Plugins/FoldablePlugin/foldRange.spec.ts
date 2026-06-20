import { computeHiddenBlockKeys, computeHiddenListItemKeys, FoldBlock, FoldListItem } from './foldRange'

/** Build a heading block. */
const h = (key: string, level: number): FoldBlock => ({ key, headingLevel: level })
/** Build a non-heading block (paragraph/list/etc). */
const p = (key: string): FoldBlock => ({ key, headingLevel: null })

describe('computeHiddenBlockKeys', () => {
  it('hides nothing when no heading is collapsed', () => {
    const blocks = [h('h1', 1), p('p1'), p('p2')]
    expect([...computeHiddenBlockKeys(blocks, new Set())]).toEqual([])
  })

  it('hides following blocks until a same-level heading', () => {
    const blocks = [h('a', 1), p('p1'), p('p2'), h('b', 1), p('p3')]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['a']))
    expect([...hidden].sort()).toEqual(['p1', 'p2'])
  })

  it('hides following blocks until a higher-level heading', () => {
    // Collapsing an h2 stops at the next h1 (higher level).
    const blocks = [h('a', 2), p('p1'), h('b', 1), p('p2')]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['a']))
    expect([...hidden]).toEqual(['p1'])
  })

  it('hides deeper headings and their content within the fold', () => {
    // Collapsing h1 hides the nested h2 + its content too.
    const blocks = [h('a', 1), p('p1'), h('b', 2), p('p2'), h('c', 1), p('p3')]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['a']))
    expect([...hidden].sort()).toEqual(['b', 'p1', 'p2'])
  })

  it('hides to end of document when no terminating heading follows', () => {
    const blocks = [p('intro'), h('a', 1), p('p1'), p('p2')]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['a']))
    expect([...hidden].sort()).toEqual(['p1', 'p2'])
    expect(hidden.has('intro')).toBe(false)
  })

  it('handles overlapping folds (nested collapsed headings) without double counting', () => {
    const blocks = [h('a', 1), p('p1'), h('b', 2), p('p2'), h('c', 1)]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['a', 'b']))
    // a hides p1, b, p2; b would hide p2 — set dedupes.
    expect([...hidden].sort()).toEqual(['b', 'p1', 'p2'])
  })

  it('ignores collapsed keys that are not headings in the block list', () => {
    const blocks = [h('a', 1), p('p1')]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['p1', 'ghost']))
    expect([...hidden]).toEqual([])
  })

  it('keeps the collapsed heading itself visible', () => {
    const blocks = [h('a', 1), p('p1')]
    const hidden = computeHiddenBlockKeys(blocks, new Set(['a']))
    expect(hidden.has('a')).toBe(false)
  })
})

describe('computeHiddenListItemKeys', () => {
  const item = (key: string, childKeys: string[]): FoldListItem => ({ key, childKeys })

  it('hides nothing when nothing is collapsed', () => {
    const items = [item('li1', ['nestedList', 'child1', 'child2'])]
    expect([...computeHiddenListItemKeys(items, new Set())]).toEqual([])
  })

  it('hides the entire nested subtree of a collapsed item', () => {
    const items = [item('li1', ['nestedList', 'child1', 'child2'])]
    const hidden = computeHiddenListItemKeys(items, new Set(['li1']))
    expect([...hidden].sort()).toEqual(['child1', 'child2', 'nestedList'])
  })

  it('does not hide the collapsed item itself', () => {
    const items = [item('li1', ['nestedList', 'child1'])]
    const hidden = computeHiddenListItemKeys(items, new Set(['li1']))
    expect(hidden.has('li1')).toBe(false)
  })

  it('dedupes overlapping nested folds (ancestor + descendant collapsed)', () => {
    // li1's subtree includes li2 and its children; both collapsed.
    const items = [
      item('li1', ['nl1', 'li2', 'nl2', 'li3']),
      item('li2', ['nl2', 'li3']),
    ]
    const hidden = computeHiddenListItemKeys(items, new Set(['li1', 'li2']))
    expect([...hidden].sort()).toEqual(['li2', 'li3', 'nl1', 'nl2'])
  })

  it('ignores collapsed keys with no matching foldable item', () => {
    const items = [item('li1', ['nl1', 'c1'])]
    const hidden = computeHiddenListItemKeys(items, new Set(['ghost']))
    expect([...hidden]).toEqual([])
  })
})
