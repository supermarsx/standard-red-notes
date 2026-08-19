/**
 * @jest-environment jsdom
 *
 * RENDER-PATH GUARD for the per-item schedule affordance (task t91).
 *
 * A conditionally-rendered control is exactly the category of thing that has
 * twice been added to this editor, typechecked and tested clean, and then not
 * actually shown to users. So the reveal is driven by an explicit DOM contract
 * (attributes set by `setActiveChecklistItemElement` /
 * `setChecklistDueShellRevealed`) rather than by CSS alone, and this spec
 * asserts that contract directly: absent on rows you are not on, present on the
 * row you are on, reachable from the keyboard, and never at the cost of an
 * already-scheduled row's visible state.
 *
 * The CSS half — hover and :focus-within for mouse users — cannot be observed in
 * jsdom, so `ChecklistDueControls.stylesheet.spec.ts` guards that separately by
 * reading the stylesheet.
 */
import {
  CHECKLIST_ACTIVE_ITEM_ATTR,
  CHECKLIST_DUE_ACTION_ATTR,
  CHECKLIST_DUE_REVEAL_ATTR,
  CHECKLIST_SCHEDULE_OPEN_ATTR,
  setActiveChecklistItemElement,
  setChecklistSchedulePanelOpen,
  syncChecklistDueShell,
} from './ChecklistDueControls'

/** A `<ul>` of `count` checklist rows, each already carrying its due shell. */
const buildList = (count: number, dueAt?: (index: number) => string | undefined) => {
  const list = document.createElement('ul')
  document.body.appendChild(list)
  const rows: HTMLElement[] = []
  for (let index = 0; index < count; index++) {
    const row = document.createElement('li')
    list.appendChild(row)
    syncChecklistDueShell(row, dueAt?.(index), false, true)
    rows.push(row)
  }
  return { root: list, rows }
}

const trigger = (row: HTMLElement) =>
  row.querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="edit-schedule"]`)!

const reveal = (row: HTMLElement) =>
  row.querySelector('[data-checklist-due-shell]')!.getAttribute(CHECKLIST_DUE_REVEAL_ATTR)

/** What a keyboard or screen-reader user can actually reach on this row. */
const isReachable = (row: HTMLElement) => {
  const button = trigger(row)
  return button.getAttribute('aria-hidden') !== 'true' && button.getAttribute('tabindex') !== '-1'
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('the schedule affordance appears only on the row you are on', () => {
  it('starts inactive on every row before the caret lands anywhere', () => {
    const { rows } = buildList(3)
    for (const row of rows) {
      expect(reveal(row)).toBe('inactive')
      expect(isReachable(row)).toBe(false)
    }
  })

  it('reveals it on the active row and NOT on the others', () => {
    const { root, rows } = buildList(3)
    setActiveChecklistItemElement(root, rows[1])

    expect(reveal(rows[1])).toBe('active')
    expect(isReachable(rows[1])).toBe(true)
    for (const index of [0, 2]) {
      expect(reveal(rows[index])).toBe('inactive')
      expect(isReachable(rows[index])).toBe(false)
    }
  })

  it('moves with the caret, leaving no stale active row behind', () => {
    const { root, rows } = buildList(3)
    setActiveChecklistItemElement(root, rows[0])
    setActiveChecklistItemElement(root, rows[2])

    expect(rows[0].hasAttribute(CHECKLIST_ACTIVE_ITEM_ATTR)).toBe(false)
    expect(rows[2].getAttribute(CHECKLIST_ACTIVE_ITEM_ATTR)).toBe('true')
    expect(reveal(rows[0])).toBe('inactive')
    expect(reveal(rows[2])).toBe('active')
    // Exactly one row is ever marked active.
    expect(root.querySelectorAll(`[${CHECKLIST_ACTIVE_ITEM_ATTR}]`)).toHaveLength(1)
  })

  it('clears every row when the caret leaves the checklist entirely', () => {
    const { root, rows } = buildList(2)
    setActiveChecklistItemElement(root, rows[0])
    setActiveChecklistItemElement(root, null)

    for (const row of rows) {
      expect(reveal(row)).toBe('inactive')
      expect(isReachable(row)).toBe(false)
    }
  })

  it('keeps the button in the DOM on inactive rows so nothing reflows', () => {
    // The reveal must never be `display`-based: the caret moving between rows
    // would make every row jump. The button keeps its box and is hidden with
    // visibility/opacity (see lists.scss), so it stays in the tree.
    const { root, rows } = buildList(2)
    setActiveChecklistItemElement(root, rows[0])

    expect(trigger(rows[1])).not.toBeNull()
    expect(trigger(rows[1]).isConnected).toBe(true)
    // Not the `hidden` attribute either — that is display:none in this sheet.
    expect(trigger(rows[1]).hidden).toBe(false)
  })

  it('survives the due-date refresh tick that re-syncs every row', () => {
    // syncChecklistDueShell runs on every editor update AND on an interval; it
    // must re-derive the reveal instead of resetting it, or the affordance
    // would blink off the active row once a second.
    const { root, rows } = buildList(2)
    setActiveChecklistItemElement(root, rows[1])

    syncChecklistDueShell(rows[0], undefined, false, true)
    syncChecklistDueShell(rows[1], undefined, false, true)

    expect(reveal(rows[1])).toBe('active')
    expect(reveal(rows[0])).toBe('inactive')
  })
})

describe('the affordance is a neat, named calendar icon', () => {
  it('renders the calendar glyph rather than a wordy button', () => {
    const { rows } = buildList(1)
    const button = trigger(rows[0])

    const svg = button.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg!.querySelectorAll('path').length).toBeGreaterThan(0)
    // Icon-only: no visible text label competing with the task's own text.
    expect(button.textContent).toBe('')
  })

  it('keeps an accessible name and a tooltip even though it is icon-only', () => {
    const { rows } = buildList(1)
    const button = trigger(rows[0])

    expect(button.getAttribute('aria-label')).toBe('Add checklist due date and recurrence')
    expect(button.getAttribute('title')).toBe('Add checklist due date and recurrence')
    // The glyph itself is decorative; the button carries the name.
    expect(button.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('names the existing schedule on a row that already has one', () => {
    const { rows } = buildList(1, () => '2026-08-12T12:00:00.000Z')
    const button = trigger(rows[0])

    expect(button.getAttribute('aria-label')).toContain('Edit checklist schedule')
    expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'))
    expect(button.getAttribute('data-checklist-due-state')).toBe('scheduled')
  })
})

describe('an already-scheduled row stays visible without hovering it', () => {
  it('shows its due label persistently, independent of the reveal', () => {
    const { root, rows } = buildList(2, (index) => (index === 0 ? '2026-08-12T12:00:00.000Z' : undefined))
    // Make the OTHER row active, so row 0's affordance is hidden.
    setActiveChecklistItemElement(root, rows[1])

    const label = rows[0].querySelector<HTMLElement>('[data-checklist-due-label]')!
    expect(reveal(rows[0])).toBe('inactive')
    expect(label.hidden).toBe(false)
    expect(label.textContent).toContain('Due')
    // The label lives OUTSIDE the print-excluded controls the reveal hides.
    expect(label.closest('[data-srn-print-exclude]')).toBeNull()
  })

  it('marks scheduled and unscheduled rows apart so the icon reads as set vs add', () => {
    const { rows } = buildList(2, (index) => (index === 0 ? '2026-08-12T12:00:00.000Z' : undefined))
    expect(trigger(rows[0]).getAttribute('data-checklist-due-state')).toBe('scheduled')
    expect(trigger(rows[1]).getAttribute('data-checklist-due-state')).toBe('empty')
  })
})

describe('an open schedule panel pins its row revealed', () => {
  it('stays revealed even when the caret is on another row', () => {
    // Clicking the icon deliberately does not move the caret (the plugin stops
    // the pointer event), so without this pin the dialog's own container would
    // vanish mid-edit.
    const { root, rows } = buildList(2)
    const shell = rows[0].querySelector<HTMLElement>('[data-checklist-due-shell]')!

    setChecklistSchedulePanelOpen(shell, true)
    expect(shell.getAttribute(CHECKLIST_SCHEDULE_OPEN_ATTR)).toBe('true')

    setActiveChecklistItemElement(root, rows[1])
    expect(reveal(rows[0])).toBe('active')
    expect(reveal(rows[1])).toBe('active')
  })

  it('releases the pin when the panel closes', () => {
    const { root, rows } = buildList(2)
    const shell = rows[0].querySelector<HTMLElement>('[data-checklist-due-shell]')!

    setChecklistSchedulePanelOpen(shell, true)
    setActiveChecklistItemElement(root, rows[1])
    setChecklistSchedulePanelOpen(shell, false)

    expect(shell.hasAttribute(CHECKLIST_SCHEDULE_OPEN_ATTR)).toBe(false)
    expect(reveal(rows[0])).toBe('inactive')
    expect(isReachable(rows[0])).toBe(false)
  })

  it('leaves the trigger reachable again after the panel closes on the active row', () => {
    const { root, rows } = buildList(1)
    const shell = rows[0].querySelector<HTMLElement>('[data-checklist-due-shell]')!
    setActiveChecklistItemElement(root, rows[0])

    setChecklistSchedulePanelOpen(shell, true)
    // While open the trigger is replaced by the panel, so it is hidden outright.
    expect(trigger(rows[0]).hidden).toBe(true)

    setChecklistSchedulePanelOpen(shell, false)
    expect(trigger(rows[0]).hidden).toBe(false)
    expect(isReachable(rows[0])).toBe(true)
  })
})
