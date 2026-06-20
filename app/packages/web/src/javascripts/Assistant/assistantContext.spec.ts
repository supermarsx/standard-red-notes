import {
  buildAssistantContext,
  ContextNote,
  DEFAULT_ASSISTANT_CONTEXT_BUDGET,
} from './assistantContext'

const note = (uuid: string, title: string, text: string): ContextNote => ({ uuid, title, text })

describe('buildAssistantContext', () => {
  it('returns empty context when there are no notes', () => {
    const result = buildAssistantContext('current-note', [])
    expect(result.text).toBe('')
    expect(result.noteCount).toBe(0)
    expect(result.characters).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('includes the current note title and body untruncated when within budget', () => {
    const result = buildAssistantContext('current-note', [note('n1', 'Shopping', 'Milk and eggs')])
    expect(result.noteCount).toBe(1)
    expect(result.omittedNoteCount).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('## Shopping')
    expect(result.text).toContain('Milk and eggs')
    expect(result.characters).toBe(result.text.length)
  })

  it('labels untitled notes', () => {
    const result = buildAssistantContext('current-note', [note('n1', '   ', 'body')])
    expect(result.text).toContain('## Untitled note')
  })

  it('drops notes that have neither title nor body', () => {
    const result = buildAssistantContext('collection', [note('n1', '', ''), note('n2', 'Real', 'content')])
    expect(result.noteCount).toBe(1)
    expect(result.text).toContain('Real')
  })

  it('caps total output at the character budget', () => {
    const big = 'x'.repeat(5000)
    const notes = Array.from({ length: 20 }, (_, i) => note(`n${i}`, `Note ${i}`, big))
    const budget = 4000
    const result = buildAssistantContext('all-notes', notes, { budget })
    // Output should stay within roughly the budget (heading/footer add a little).
    expect(result.characters).toBeLessThanOrEqual(budget + 400)
    expect(result.truncated).toBe(true)
  })

  it('shares the budget across notes so later notes still appear', () => {
    const body = 'y'.repeat(2000)
    const notes = Array.from({ length: 6 }, (_, i) => note(`n${i}`, `Title${i}`, body))
    const result = buildAssistantContext('all-notes', notes, { budget: 6000 })
    // Every note should at least contribute its header rather than the first note
    // eating the entire budget.
    for (let i = 0; i < 6; i++) {
      expect(result.text).toContain(`## Title${i}`)
    }
    expect(result.truncated).toBe(true)
  })

  it('reports omitted notes when the budget runs out before all notes fit', () => {
    const body = 'z'.repeat(2000)
    const notes = Array.from({ length: 50 }, (_, i) => note(`n${i}`, `T${i}`, body))
    const result = buildAssistantContext('all-notes', notes, { budget: 1000 })
    expect(result.noteCount).toBeLessThan(50)
    expect(result.omittedNoteCount).toBe(50 - result.noteCount)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain('more note')
  })

  it('uses a collection label in the heading when provided', () => {
    const result = buildAssistantContext('collection', [note('n1', 'A', 'a')], { collectionLabel: 'Work' })
    expect(result.text).toContain('"Work"')
  })

  it('defaults to the documented budget when none is given', () => {
    const big = 'x'.repeat(50_000)
    const result = buildAssistantContext('current-note', [note('n1', 'Big', big)])
    expect(result.characters).toBeLessThanOrEqual(DEFAULT_ASSISTANT_CONTEXT_BUDGET + 200)
    expect(result.truncated).toBe(true)
  })
})
