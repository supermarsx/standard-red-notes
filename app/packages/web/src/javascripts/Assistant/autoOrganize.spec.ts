import {
  buildAllNotesPrompt,
  buildCurrentNotePrompt,
  buildOrganizeDigest,
  DEFAULT_MAX_NOTES,
  MAX_PLAN_FOLDERS,
  MAX_TAGS_PER_NOTE,
  parseCurrentNotePlan,
  parseOrganizePlan,
} from './autoOrganize'

describe('buildOrganizeDigest', () => {
  it('emits one [id] Title — snippet line per note', () => {
    const digest = buildOrganizeDigest([
      { id: 'n1', title: 'Budget', plaintext: 'Money stuff' },
      { id: 'n2', title: 'Trip', plaintext: 'Flights and hotels' },
    ])
    expect(digest.includedIds).toEqual(['n1', 'n2'])
    expect(digest.includedCount).toBe(2)
    expect(digest.omittedCount).toBe(0)
    expect(digest.text).toContain('[n1] Budget — Money stuff')
    expect(digest.text).toContain('[n2] Trip — Flights and hotels')
  })

  it('defaults a blank title to "Untitled note" and handles empty body', () => {
    const digest = buildOrganizeDigest([{ id: 'n1', title: '   ', plaintext: '' }])
    expect(digest.text).toBe('[n1] Untitled note')
  })

  it('skips notes without a usable id', () => {
    const digest = buildOrganizeDigest([
      { id: '', title: 'x', plaintext: 'y' },
      { id: 'n2', title: 'ok', plaintext: 'z' },
    ])
    expect(digest.includedIds).toEqual(['n2'])
  })

  it('caps the number of notes and reports the rest as omitted', () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, title: `t${i}`, plaintext: 'body' }))
    const digest = buildOrganizeDigest(notes, { maxNotes: 3 })
    expect(digest.includedCount).toBe(3)
    expect(digest.omittedCount).toBe(2)
  })

  it('respects the char budget and counts dropped notes as omitted', () => {
    const notes = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      title: `Title ${i}`,
      plaintext: 'x'.repeat(200),
    }))
    const digest = buildOrganizeDigest(notes, { budget: 200 })
    expect(digest.text.length).toBeLessThanOrEqual(260) // ~one line, within slack
    expect(digest.includedCount).toBeGreaterThanOrEqual(1)
    expect(digest.includedCount + digest.omittedCount).toBe(20)
    expect(digest.omittedCount).toBeGreaterThan(0)
  })

  it('truncates over-long snippets with an ellipsis', () => {
    const digest = buildOrganizeDigest([{ id: 'n1', title: 'T', plaintext: 'y'.repeat(1000) }])
    expect(digest.text).toContain('…')
    expect(digest.text.length).toBeLessThan(400)
  })

  it('uses the default max-notes when given a non-positive value', () => {
    const notes = Array.from({ length: DEFAULT_MAX_NOTES + 5 }, (_, i) => ({
      id: `n${i}`,
      title: 't',
      plaintext: 'b',
    }))
    const digest = buildOrganizeDigest(notes, { maxNotes: 0, budget: 10_000_000 })
    expect(digest.includedCount).toBe(DEFAULT_MAX_NOTES)
    expect(digest.omittedCount).toBe(5)
  })
})

describe('buildAllNotesPrompt / buildCurrentNotePrompt', () => {
  it('all-notes prompt lists existing folders/tags and the digest', () => {
    const { system, user } = buildAllNotesPrompt({
      digest: '[n1] A — body',
      existingFolders: ['Work', '  Personal '],
      existingTags: ['budget'],
    })
    expect(system.toLowerCase()).toContain('json object')
    expect(user).toContain('- Work')
    expect(user).toContain('- Personal')
    expect(user).toContain('- budget')
    expect(user).toContain('[n1] A — body')
  })

  it('all-notes prompt notes when there are no existing folders/tags', () => {
    const { user } = buildAllNotesPrompt({ digest: 'd', existingFolders: [], existingTags: [] })
    expect(user).toContain('no existing folders')
    expect(user).toContain('no existing tags')
  })

  it('current-note prompt includes the title and body', () => {
    const { user } = buildCurrentNotePrompt({
      title: 'My Note',
      plaintext: 'Some content',
      existingFolders: ['Work'],
      existingTags: [],
    })
    expect(user).toContain('Title: My Note')
    expect(user).toContain('Some content')
    expect(user).toContain('- Work')
  })

  it('current-note prompt omits the title block when blank', () => {
    const { user } = buildCurrentNotePrompt({ title: '  ', plaintext: 'b', existingFolders: [], existingTags: [] })
    expect(user).not.toContain('Title:')
  })
})

describe('parseOrganizePlan', () => {
  const valid = ['n1', 'n2', 'n3']

  it('parses a clean JSON plan', () => {
    const reply = JSON.stringify({
      folders: ['Work', 'Personal'],
      tags: ['budget', 'travel'],
      assignments: [
        { id: 'n1', folder: 'Work', tags: ['budget'] },
        { id: 'n2', folder: 'Personal', tags: ['travel'] },
      ],
    })
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders).toEqual(['Work', 'Personal'])
    expect(plan.tags).toEqual(['budget', 'travel'])
    expect(plan.assignments).toEqual([
      { id: 'n1', folder: 'Work', tags: ['budget'] },
      { id: 'n2', folder: 'Personal', tags: ['travel'] },
    ])
  })

  it('parses a plan wrapped in code fences', () => {
    const reply = '```json\n{"folders":["Work"],"tags":[],"assignments":[{"id":"n1","folder":"Work","tags":[]}]}\n```'
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders).toEqual(['Work'])
    expect(plan.assignments).toEqual([{ id: 'n1', folder: 'Work', tags: [] }])
  })

  it('extracts a plan surrounded by prose', () => {
    const reply =
      'Sure, here is my plan: {"folders":["Ideas"],"tags":["x"],"assignments":[{"id":"n3","folder":"Ideas","tags":["x"]}]} Hope it helps!'
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders).toEqual(['Ideas'])
    expect(plan.assignments).toEqual([{ id: 'n3', folder: 'Ideas', tags: ['x'] }])
  })

  it('drops assignments referencing unknown ids', () => {
    const reply = JSON.stringify({
      folders: [],
      tags: [],
      assignments: [
        { id: 'n1', folder: 'Work', tags: [] },
        { id: 'nonexistent', folder: 'Ghost', tags: ['z'] },
      ],
    })
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.assignments.map((a) => a.id)).toEqual(['n1'])
    // Ghost folder / z tag came only from the dropped assignment, so they must not appear.
    expect(plan.folders).toEqual(['Work'])
    expect(plan.tags).toEqual([])
  })

  it('merges folder/tag names referenced only inside assignments', () => {
    const reply = JSON.stringify({
      folders: [],
      tags: [],
      assignments: [{ id: 'n1', folder: 'Discovered', tags: ['fresh'] }],
    })
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders).toEqual(['Discovered'])
    expect(plan.tags).toEqual(['fresh'])
  })

  it('dedupes folders/tags case-insensitively keeping first casing', () => {
    const reply = JSON.stringify({
      folders: ['Work', 'work', 'WORK'],
      tags: ['Budget', 'budget'],
      assignments: [],
    })
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders).toEqual(['Work'])
    expect(plan.tags).toEqual(['Budget'])
  })

  it('dedupes assignments by id (first wins) and clamps tags per note', () => {
    const reply = JSON.stringify({
      folders: [],
      tags: [],
      assignments: [
        { id: 'n1', folder: 'A', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
        { id: 'n1', folder: 'B', tags: ['z'] },
      ],
    })
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.assignments.length).toBe(1)
    expect(plan.assignments[0].folder).toBe('A')
    expect(plan.assignments[0].tags.length).toBe(MAX_TAGS_PER_NOTE)
  })

  it('caps the number of folders', () => {
    const folders = Array.from({ length: MAX_PLAN_FOLDERS + 10 }, (_, i) => `F${i}`)
    const reply = JSON.stringify({ folders, tags: [], assignments: [] })
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders.length).toBe(MAX_PLAN_FOLDERS)
  })

  it('returns an empty plan for non-JSON replies', () => {
    expect(parseOrganizePlan('I cannot help with that.', valid)).toEqual({ folders: [], tags: [], assignments: [] })
    expect(parseOrganizePlan('', valid)).toEqual({ folders: [], tags: [], assignments: [] })
  })

  it('does not break on braces inside string values', () => {
    const reply = '{"folders":["a {nested} b"],"tags":[],"assignments":[]}'
    const plan = parseOrganizePlan(reply, valid)
    expect(plan.folders).toEqual(['a {nested} b'])
  })
})

describe('parseCurrentNotePlan', () => {
  it('parses a clean current-note plan', () => {
    expect(parseCurrentNotePlan('{"folder":"Work","tags":["budget","travel"]}')).toEqual({
      folder: 'Work',
      tags: ['budget', 'travel'],
    })
  })

  it('tolerates fences and prose', () => {
    const reply = 'Here you go:\n```json\n{"folder":"Ideas","tags":["x"]}\n```'
    expect(parseCurrentNotePlan(reply)).toEqual({ folder: 'Ideas', tags: ['x'] })
  })

  it('defaults to empty folder/tags when missing or unusable', () => {
    expect(parseCurrentNotePlan('no json here')).toEqual({ folder: '', tags: [] })
    expect(parseCurrentNotePlan('{"tags":[]}')).toEqual({ folder: '', tags: [] })
  })
})
