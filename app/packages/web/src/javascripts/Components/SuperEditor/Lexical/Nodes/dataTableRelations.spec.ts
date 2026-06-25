import {
  buildTableMap,
  effectiveKeyColumn,
  hasLinks,
  linkConfigAt,
  linkOptionsFor,
  linkedTargetIds,
  normalizeKey,
  resolveLink,
  type LinkColumnConfig,
  type RelationTable,
} from './dataTableRelations'

const people: RelationTable = {
  id: 'people',
  columns: ['Code', 'Name'],
  rows: [
    ['A1', 'Alice'],
    ['B2', 'Bob'],
    ['C3', ''], // empty display -> falls back to key
  ],
  keyColumn: 0,
}

const projects: RelationTable = {
  id: 'projects',
  columns: ['Project', 'Owner'],
  rows: [
    ['Apollo', 'A1'],
    ['Gemini', 'B2'],
    ['Mercury', 'Z9'], // no matching owner
  ],
}

const ownerLink: LinkColumnConfig = { targetTableId: 'people', targetKeyColumn: 0, displayColumn: 1 }

describe('normalizeKey', () => {
  it('trims and lower-cases, treats nullish as empty', () => {
    expect(normalizeKey('  A1 ')).toBe('a1')
    expect(normalizeKey('ALICE')).toBe('alice')
    expect(normalizeKey(null)).toBe('')
    expect(normalizeKey(undefined)).toBe('')
  })
})

describe('effectiveKeyColumn', () => {
  it('defaults to 0 for backward-compat tables without keyColumn', () => {
    expect(effectiveKeyColumn({})).toBe(0)
    expect(effectiveKeyColumn({ keyColumn: 2 })).toBe(2)
  })
})

describe('buildTableMap', () => {
  it('indexes tables by id and skips tables without an id (backward compat)', () => {
    const legacy: RelationTable = { columns: ['X'], rows: [['1']] } // no id
    const map = buildTableMap([people, projects, legacy])
    expect(map.size).toBe(2)
    expect(map.get('people')).toBe(people)
    expect(map.has('projects')).toBe(true)
  })

  it('keeps the first table on duplicate ids (deterministic)', () => {
    const dupe: RelationTable = { id: 'people', columns: ['Y'], rows: [['9']] }
    const map = buildTableMap([people, dupe])
    expect(map.size).toBe(1)
    expect(map.get('people')).toBe(people)
  })
})

describe('resolveLink', () => {
  const map = buildTableMap([people, projects])

  it('resolves a matching key to the display column', () => {
    const res = resolveLink('A1', ownerLink, map)
    expect(res).toEqual({ matched: true, display: 'Alice', rowIndex: 0, targetTableId: 'people' })
  })

  it('matches case- and whitespace-insensitively', () => {
    const res = resolveLink('  b2 ', ownerLink, map)
    expect(res.matched).toBe(true)
    expect(res.display).toBe('Bob')
    expect(res.rowIndex).toBe(1)
  })

  it('falls back to the raw key when the display cell is empty', () => {
    const res = resolveLink('C3', ownerLink, map)
    expect(res.matched).toBe(true)
    expect(res.display).toBe('C3')
  })

  it('shows raw text and stays unmatched when the key does not match (semi-structured)', () => {
    const res = resolveLink('Z9', ownerLink, map)
    expect(res).toEqual({ matched: false, display: 'Z9', rowIndex: -1, targetTableId: 'people' })
  })

  it('shows raw text when the target table is missing', () => {
    const res = resolveLink('A1', { targetTableId: 'ghost', targetKeyColumn: 0 }, map)
    expect(res).toEqual({ matched: false, display: 'A1', rowIndex: -1, targetTableId: 'ghost' })
  })

  it('returns raw value unmatched when there is no link config', () => {
    expect(resolveLink('A1', null, map)).toEqual({
      matched: false,
      display: 'A1',
      rowIndex: -1,
      targetTableId: null,
    })
  })

  it('treats an empty key as unmatched without crashing', () => {
    expect(resolveLink('   ', ownerLink, map).matched).toBe(false)
  })

  it('picks the first row on duplicate keys (deterministic)', () => {
    const dupKeys: RelationTable = {
      id: 'dups',
      columns: ['K', 'V'],
      rows: [
        ['x', 'first'],
        ['x', 'second'],
      ],
    }
    const dupMap = buildTableMap([dupKeys])
    const res = resolveLink('x', { targetTableId: 'dups', targetKeyColumn: 0, displayColumn: 1 }, dupMap)
    expect(res.display).toBe('first')
    expect(res.rowIndex).toBe(0)
  })

  it('defaults displayColumn to the key column', () => {
    const res = resolveLink('A1', { targetTableId: 'people', targetKeyColumn: 0 }, map)
    expect(res.display).toBe('A1')
  })
})

describe('linkConfigAt / hasLinks / linkedTargetIds', () => {
  const links: (LinkColumnConfig | null)[] = [null, ownerLink, { targetTableId: 'projects', targetKeyColumn: 0 }, ownerLink]

  it('returns the config at a column or null', () => {
    expect(linkConfigAt(links, 0)).toBeNull()
    expect(linkConfigAt(links, 1)).toBe(ownerLink)
    expect(linkConfigAt(undefined, 1)).toBeNull()
  })

  it('detects whether any link exists', () => {
    expect(hasLinks(links)).toBe(true)
    expect(hasLinks([null, null])).toBe(false)
    expect(hasLinks(undefined)).toBe(false)
  })

  it('lists distinct target ids in first-seen order', () => {
    expect(linkedTargetIds(links)).toEqual(['people', 'projects'])
    expect(linkedTargetIds(undefined)).toEqual([])
  })
})

describe('linkOptionsFor', () => {
  it('builds value/label options, skips empty keys, dedupes, falls back label to key', () => {
    const opts = linkOptionsFor(people, ownerLink)
    expect(opts).toEqual([
      { value: 'A1', label: 'Alice' },
      { value: 'B2', label: 'Bob' },
      { value: 'C3', label: 'C3' },
    ])
  })

  it('dedupes by normalized key keeping the first occurrence', () => {
    const t: RelationTable = { id: 't', columns: ['K', 'L'], rows: [['x', 'one'], ['X', 'two'], ['', 'skip']] }
    const opts = linkOptionsFor(t, { targetTableId: 't', targetKeyColumn: 0, displayColumn: 1 })
    expect(opts).toEqual([{ value: 'x', label: 'one' }])
  })
})
