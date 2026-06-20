import {
  buildNoteNeighborhood,
  selectConstellationNoteUuids,
  NoteAdjacency,
  ScopeNote,
} from './selectConstellationNotes'

// A small linked-note fixture:
//   a — b — c
//   |
//   d        e (isolated)
const links: Record<string, string[]> = {
  a: ['b', 'd'],
  b: ['a', 'c'],
  c: ['b'],
  d: ['a'],
  e: [],
}
const adjacency: NoteAdjacency = (uuid) => links[uuid] ?? []
const allNotes: ScopeNote[] = ['a', 'b', 'c', 'd', 'e'].map((uuid) => ({ uuid }))

describe('buildNoteNeighborhood', () => {
  it('returns the root plus its direct neighbors at 1 hop', () => {
    const result = buildNoteNeighborhood('a', adjacency, { hops: 1 })
    expect([...result].sort()).toEqual(['a', 'b', 'd'])
  })

  it('expands to 2 hops', () => {
    const result = buildNoteNeighborhood('a', adjacency, { hops: 2 })
    expect([...result].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns just the root for an isolated note', () => {
    const result = buildNoteNeighborhood('e', adjacency, { hops: 2 })
    expect([...result]).toEqual(['e'])
  })

  it('respects the maxNodes cap', () => {
    const result = buildNoteNeighborhood('a', adjacency, { hops: 2, maxNodes: 2 })
    expect(result.size).toBe(2)
    expect(result.has('a')).toBe(true)
  })

  it('clamps hops to the supported maximum', () => {
    const oneThroughTen: Record<string, string[]> = {}
    for (let i = 0; i < 10; i++) {
      oneThroughTen[`n${i}`] = [`n${i + 1}`]
    }
    const chain: NoteAdjacency = (uuid) => oneThroughTen[uuid] ?? []
    // hops requested 99 but max is 2, so only n0,n1,n2 are reachable.
    const result = buildNoteNeighborhood('n0', chain, { hops: 99 })
    expect([...result].sort()).toEqual(['n0', 'n1', 'n2'])
  })
})

describe('selectConstellationNoteUuids', () => {
  it('global returns every note', () => {
    const result = selectConstellationNoteUuids({ scope: { kind: 'global' }, allNotes })
    expect([...result].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('current returns the active note neighborhood', () => {
    const result = selectConstellationNoteUuids({
      scope: { kind: 'current' },
      allNotes,
      activeNoteUuid: 'a',
      adjacency,
      hops: 1,
    })
    expect([...result].sort()).toEqual(['a', 'b', 'd'])
  })

  it('current returns an empty set when there is no active note', () => {
    const result = selectConstellationNoteUuids({ scope: { kind: 'current' }, allNotes, adjacency })
    expect(result.size).toBe(0)
  })

  it('current ignores an active note that is not displayable', () => {
    const result = selectConstellationNoteUuids({
      scope: { kind: 'current' },
      allNotes,
      activeNoteUuid: 'ghost',
      adjacency,
    })
    expect(result.size).toBe(0)
  })

  it('tag restricts to the collection notes that still exist', () => {
    const result = selectConstellationNoteUuids({
      scope: { kind: 'tag', collectionUuid: 'tag-1' },
      allNotes,
      collectionNoteUuids: ['a', 'c', 'deleted'],
    })
    expect([...result].sort()).toEqual(['a', 'c'])
  })

  it('folder behaves like tag', () => {
    const result = selectConstellationNoteUuids({
      scope: { kind: 'folder', collectionUuid: 'folder-1' },
      allNotes,
      collectionNoteUuids: ['b', 'd'],
    })
    expect([...result].sort()).toEqual(['b', 'd'])
  })

  it('tag/folder return empty when no collection is selected', () => {
    const result = selectConstellationNoteUuids({ scope: { kind: 'tag' }, allNotes })
    expect(result.size).toBe(0)
  })
})
