import { SNNote } from '@standardnotes/snjs'
import { decisionForConflictTab } from './conflictTabDecision'

/**
 * Standard Red Notes: conflict view-tab with a missing note regression.
 *
 * `NoteGroupView.renderActiveViewTab` for a `kind: 'conflict'` tab looks the
 * note up by uuid. If the note no longer exists (deleted, conflict resolved
 * elsewhere, never synced) the tab must be closed and nothing rendered —
 * rendering NoteConflictResolutionView with an undefined `currentNote`
 * dereferences undefined and crashes the whole NoteGroupView.
 *
 * The branch delegates to the pure `decisionForConflictTab(lookedUpNote)`, which
 * returns 'close' for a missing note and 'render' for a present one. Testing the
 * decision directly avoids needing a live application or React render.
 */

const fakeNote = { uuid: 'note-1' } as unknown as SNNote

describe('decisionForConflictTab', () => {
  it("returns 'close' when the looked-up note is missing", () => {
    expect(decisionForConflictTab(undefined)).toBe('close')
    expect(decisionForConflictTab(null)).toBe('close')
  })

  it("returns 'render' when the looked-up note exists", () => {
    expect(decisionForConflictTab(fakeNote)).toBe('render')
  })

  it('never throws regardless of the lookup result', () => {
    expect(() => decisionForConflictTab(undefined)).not.toThrow()
    expect(() => decisionForConflictTab(null)).not.toThrow()
    expect(() => decisionForConflictTab(fakeNote)).not.toThrow()
  })

  it('drives the close-then-return-null branch only when the note is gone', () => {
    // Mirrors the caller: close + return null on 'close', else render.
    let closed = false
    const render = (lookedUp: unknown): 'rendered' | null => {
      if (decisionForConflictTab(lookedUp) === 'close') {
        closed = true
        return null
      }
      return 'rendered'
    }

    expect(render(undefined)).toBeNull()
    expect(closed).toBe(true)

    closed = false
    expect(render(fakeNote)).toBe('rendered')
    expect(closed).toBe(false)
  })
})
