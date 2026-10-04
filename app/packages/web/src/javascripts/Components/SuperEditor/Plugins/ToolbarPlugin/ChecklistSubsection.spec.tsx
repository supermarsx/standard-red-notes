/**
 * @jest-environment jsdom
 *
 * The Checklists subsection card, mounted for real.
 *
 * This is the half of the guard that the full ToolbarPlugin cannot cheaply give:
 * every control is rendered, clicked, and checked to call back with the value it
 * claims. ToolbarPlugin.checklistSubsection.spec.tsx is the other half — that the
 * card is actually WIRED INTO the toolbar and reachable, which green logic tests
 * have repeatedly failed to establish in this directory.
 *
 * The copy is asserted too, not as decoration: the subsection is where a user is
 * told that a generated occurrence brings no subtasks with it and that a month-end
 * deadline's intent is not passed down. Both are deliberate behaviours the user
 * cannot otherwise discover, so silently losing the sentence is a real defect.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ChecklistSubsection, ChecklistSubsectionProps } from './ChecklistSubsection'
import { CHECKLIST_GENERATE_CAP_DEFAULT, CHECKLIST_GENERATE_CAP_MAX } from '../../Checklist/checklistBackfill'
import { EMPTY_CHECKLIST_GENERATION_RESULT } from '../../Checklist/checklistGeneration'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const calls = {
  toggleAutoMove: 0,
  restore: 0,
  completeAll: 0,
  completeSelected: 0,
  uncompleteSelected: 0,
  generateNow: 0,
  autoGenerate: [] as boolean[],
  cap: [] as number[],
}

const baseProps = (): ChecklistSubsectionProps => ({
  autoMoveCompleted: false,
  onToggleAutoMoveCompleted: () => {
    calls.toggleAutoMove += 1
  },
  onRestoreCompleted: () => {
    calls.restore += 1
  },
  hasChecklistSelection: true,
  onCompleteAll: () => {
    calls.completeAll += 1
  },
  onCompleteSelected: () => {
    calls.completeSelected += 1
  },
  onUncompleteSelected: () => {
    calls.uncompleteSelected += 1
  },
  autoGenerate: true,
  onAutoGenerateChange: (next) => {
    calls.autoGenerate.push(next)
  },
  generateCap: CHECKLIST_GENERATE_CAP_DEFAULT,
  onGenerateCapChange: (next) => {
    calls.cap.push(next)
  },
  onGenerateNow: () => {
    calls.generateNow += 1
  },
  lastGeneration: null,
})

const mount = async (overrides: Partial<ChecklistSubsectionProps> = {}) => {
  await act(async () => {
    root.render(<ChecklistSubsection {...baseProps()} {...overrides} />)
    await Promise.resolve()
  })
}

const card = () => container.querySelector('[data-super-toolbar-checklist-subsection]') as HTMLElement
const button = (label: string) =>
  Array.from(card().querySelectorAll('button')).find((element) => element.textContent?.trim() === label)
const checkbox = (labelText: string) => {
  const label = Array.from(card().querySelectorAll('label')).find((element) =>
    element.textContent?.includes(labelText),
  ) as HTMLLabelElement
  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement
}
const capInput = () => card().querySelector('input[type="number"]') as HTMLInputElement

/**
 * Type into a controlled input. Assigning `.value` directly goes through React's
 * own tracked setter, which then believes the value never changed and fires no
 * onChange — the established workaround in this repo (ConfirmPassword.spec.tsx) is
 * to call the prototype's setter.
 */
const setInputValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const resultLine = () => card().querySelector('[data-super-toolbar-checklist-generation-result]')

beforeEach(() => {
  calls.toggleAutoMove = 0
  calls.restore = 0
  calls.completeAll = 0
  calls.completeSelected = 0
  calls.uncompleteSelected = 0
  calls.generateNow = 0
  calls.autoGenerate = []
  calls.cap = []
})

describe('ChecklistSubsection renders every control it is supposed to host', () => {
  it('renders as a bordered subsection card', async () => {
    await mount()
    expect(card()).not.toBeNull()
    expect(card().className).toContain('border')
  })

  it('reflects and toggles the move-completed setting', async () => {
    await mount({ autoMoveCompleted: true })
    const input = checkbox('Move completed tasks out of the way')
    expect(input.checked).toBe(true)

    await act(async () => input.click())
    expect(calls.toggleAutoMove).toBe(1)
  })

  it('offers restore plus the three bulk-completion actions, each wired to its own callback', async () => {
    await mount()
    for (const label of ['Restore completed', 'Complete all', 'Complete selected', 'Uncomplete selected']) {
      expect(button(label)).toBeDefined()
    }

    await act(async () => button('Restore completed')!.click())
    await act(async () => button('Complete all')!.click())
    await act(async () => button('Complete selected')!.click())
    await act(async () => button('Uncomplete selected')!.click())

    expect(calls.restore).toBe(1)
    expect(calls.completeAll).toBe(1)
    expect(calls.completeSelected).toBe(1)
    expect(calls.uncompleteSelected).toBe(1)
  })

  it('disables the completion actions with no checklist selected, and says why', async () => {
    await mount({ hasChecklistSelection: false })
    expect(button('Complete all')!.disabled).toBe(true)
    expect(button('Complete selected')!.disabled).toBe(true)
    expect(button('Uncomplete selected')!.disabled).toBe(true)
    expect(card().textContent).toContain('Put the caret in a checklist')
  })

  it('reflects and changes the auto-generate setting', async () => {
    await mount({ autoGenerate: false })
    const input = checkbox('Write down missed occurrences')
    expect(input.checked).toBe(false)

    await act(async () => input.click())
    expect(calls.autoGenerate).toEqual([true])
  })

  it('shows the cap and reports a changed value clamped to the allowed range', async () => {
    await mount({ generateCap: 5 })
    expect(capInput().value).toBe('5')

    // A value above the maximum is clamped on the way out rather than stored and
    // clamped later — the cap is a bound on work and must never be read as raised.
    await setInputValue(capInput(), String(CHECKLIST_GENERATE_CAP_MAX + 500))
    expect(calls.cap).toEqual([CHECKLIST_GENERATE_CAP_MAX])
  })

  it('reports nothing at all for a cleared cap field rather than a guessed number', async () => {
    await mount({ generateCap: 5 })
    await setInputValue(capInput(), '')
    expect(calls.cap).toEqual([])
  })

  it('runs Generate now', async () => {
    await mount()
    const generate = button('Generate now')
    expect(generate).toBeDefined()
    await act(async () => generate!.click())
    expect(calls.generateNow).toBe(1)
  })

  it('renders NO result line before a pass has run', async () => {
    await mount({ lastGeneration: null })
    // "Not run yet" must not be drawn as a measured zero.
    expect(resultLine()).toBeNull()
  })

  it('says plainly that nothing was owed when a pass changed nothing', async () => {
    await mount({ lastGeneration: { ...EMPTY_CHECKLIST_GENERATION_RESULT, examined: 2 } })
    expect(resultLine()!.textContent).toContain('Nothing was owed')
    expect(resultLine()!.textContent).toContain('2 recurring tasks')
  })

  it('reports what a pass actually generated, including the cap summaries', async () => {
    await mount({ lastGeneration: { examined: 4, tasks: 2, generated: 7, summaries: 1, advanced: 2 } })
    const text = resultLine()!.textContent ?? ''
    expect(text).toContain('Generated 7 occurrences across 2 tasks')
    expect(text).toContain('1 summary')
  })

  it('states that subtasks of a generated occurrence are not reproduced', async () => {
    await mount()
    const text = card().textContent ?? ''
    expect(text).toContain('Subtasks of a generated occurrence are')
    expect(text).toContain('not')
    expect(text).toContain('reproduced')
  })

  it("states that a month-end deadline's intent is not passed down to subtasks", async () => {
    await mount()
    const text = card().textContent ?? ''
    expect(text).toContain('month-end deadline keeps its own day')
    expect(text).toContain('that intent is not passed')
    expect(text).toContain('anchored on its own date')
  })

  it('explains that the cap does not drop older occurrences silently', async () => {
    await mount()
    expect(card().textContent).toContain('recorded as one summary task')
  })

  it('says Generate now ignores the automatic toggle', async () => {
    await mount({ autoGenerate: false })
    expect(card().textContent).toContain('even with the setting above off')
  })
})
