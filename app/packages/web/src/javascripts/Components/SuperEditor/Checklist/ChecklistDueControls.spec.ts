import { $createTextNode, $getNodeByKey, $getRoot, $isTextNode, createEditor, isDOMCapturingSelection } from 'lexical'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import {
  createChecklistDueShell,
  readChecklistScheduleControl,
  setChecklistSchedulePanelOpen,
  syncChecklistDueShell,
  syncChecklistRecurrenceCustomVisibility,
} from './ChecklistDueControls'
import { createChecklistRecurrence } from './checklistRecurrence'
import {
  checklistDueAtToLocalInput,
  resolveChecklistDueAtLocalInput,
  splitChecklistDueLocalInput,
} from './checklistDueDate'

describe('checklist due controls', () => {
  it('keeps the calendar trailing through actual Lexical italic text splitting and reconciliation', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const editor = createEditor({
      namespace: 'calendar-formatting',
      nodes: [ListNode, ListItemNode],
      onError: (error) => {
        throw error
      },
    })
    editor.setRootElement(root)
    let itemKey = '',
      textKey = ''
    let displacedByFormatting = false
    const dispose = editor.registerUpdateListener(() => {
      const element = editor.getElementByKey(itemKey)
      if (element) {
        const existing = element.querySelector('[data-checklist-due-shell]')
        if (existing && element.querySelector('em')) {
          displacedByFormatting = existing.nextSibling !== null
        }
        syncChecklistDueShell(element, undefined, false, true)
      }
    })
    editor.update(
      () => {
        const text = $createTextNode('Plain italic trailing')
        const item = $createListItemNode(false).append(text)
        itemKey = item.getKey()
        textKey = text.getKey()
        $getRoot().append($createListNode('check').append(item))
      },
      { discrete: true },
    )
    const element = editor.getElementByKey(itemKey)!
    const shell = element.querySelector('[data-checklist-due-shell]')
    editor.update(
      () => {
        const text = $getNodeByKey(textKey)
        if (!$isTextNode(text)) {
          throw new Error('text fixture missing')
        }
        text.splitText(6, 12)[1].toggleFormat('italic')
      },
      { discrete: true },
    )
    expect(element.querySelector('em')?.textContent).toBe('italic')
    expect(displacedByFormatting).toBe(true)
    expect(element.lastChild).toBe(shell)
    expect(element.textContent).toContain('Plain italic trailing')
    dispose()
    editor.setRootElement(null)
    root.remove()
  })
  it.each(['EM', 'STRONG', 'SPAN'])(
    'keeps the existing calendar after %s text when Lexical replaces its inline wrapper',
    (tag) => {
      const item = document.createElement('li')
      const plain = document.createElement('span')
      plain.textContent = 'Task text'
      item.append(plain)
      const shell = syncChecklistDueShell(item, undefined, false, true)
      const input = shell.querySelector<HTMLInputElement>('[data-checklist-due-input]')!
      input.value = '2026-10-20'
      setChecklistSchedulePanelOpen(shell, true)
      plain.remove()
      const formatted = document.createElement(tag)
      formatted.textContent = 'Task text'
      item.append(formatted)
      expect(item.firstChild).toBe(shell)
      const refreshed = syncChecklistDueShell(item, undefined, false, true)
      expect(refreshed).toBe(shell)
      expect(item.firstChild).toBe(formatted)
      expect(item.lastChild).toBe(shell)
      expect(shell.querySelector('[data-checklist-due-input]')).toBe(input)
      expect(input.value).toBe('2026-10-20')
      expect(formatted.tagName).toBe(tag)
    },
  )

  it('reanchors controls after mixed formatted runs while keeping nested tasks after the calendar', () => {
    const item = document.createElement('li')
    document.body.append(item)
    const shell = syncChecklistDueShell(item, undefined, false, true)
    const prefix = document.createTextNode('Plain ')
    const italic = document.createElement('em')
    italic.textContent = 'italic'
    const suffix = document.createTextNode(' trailing task text')
    const nested = document.createElement('ul')
    nested.innerHTML = '<li>Child task</li>'
    item.append(prefix, italic, suffix, nested)
    syncChecklistDueShell(item, undefined, false, true)
    expect(Array.from(item.childNodes)).toEqual([prefix, italic, suffix, shell, nested])
    const range = document.createRange()
    range.setStart(suffix, 3)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    syncChecklistDueShell(item, undefined, false, true)
    expect(window.getSelection()!.anchorNode).toBe(suffix)
    expect(window.getSelection()!.anchorOffset).toBe(3)
    item.remove()
  })
  it('renders a semantic countdown with print-excluded edit controls', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-11T10:00:00.000Z'))
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, '2026-08-12T12:00:00.000Z', false, true)

    expect(shell.querySelector('[data-checklist-due-label]')?.textContent).toContain('1d 2h left')
    expect(shell.querySelector('[data-srn-print-exclude="true"]')).not.toBeNull()
    expect(shell.querySelector('[data-checklist-due-input]')?.getAttribute('type')).toBe('date')
    expect(shell.querySelector('[data-checklist-due-time-input]')?.getAttribute('type')).toBe('time')
    expect(shell.querySelector('[data-checklist-due-action="clear-schedule"]')?.hasAttribute('hidden')).toBe(false)
    jest.useRealTimers()
  })

  it('hides controls in readonly mode while retaining the due label', () => {
    const item = document.createElement('li')
    item.appendChild(createChecklistDueShell())
    const shell = syncChecklistDueShell(item, '2026-08-12T12:00:00.000Z', true, false)
    expect(shell.querySelector('[data-checklist-due-label]')?.textContent).toContain('Completed')
    expect((shell.querySelector('[data-srn-print-exclude]') as HTMLElement).hidden).toBe(true)
  })

  it('edits a due date and recurrence together in one accessible schedule group', () => {
    const item = document.createElement('li')
    const recurrence = createChecklistRecurrence('monthly', '2026-08-31T12:00:00.000Z', 'UTC')!
    const shell = syncChecklistDueShell(item, '2026-08-31T12:00:00.000Z', false, true, recurrence)

    expect(shell.textContent).toContain('Repeats monthly')
    const panel = shell.querySelector('[data-checklist-schedule-panel]') as HTMLElement
    const trigger = shell.querySelector('[data-checklist-due-action="edit-schedule"]') as HTMLButtonElement
    expect(panel.hidden).toBe(true)
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    setChecklistSchedulePanelOpen(shell, true)
    expect(panel.hidden).toBe(false)
    expect(trigger.hidden).toBe(true)
    expect((shell.querySelector('[data-checklist-recurrence-preset]') as HTMLSelectElement).value).toBe('monthly')

    const preset = shell.querySelector('[data-checklist-recurrence-preset]') as HTMLSelectElement
    preset.value = 'custom'
    ;(shell.querySelector('[data-checklist-recurrence-interval]') as HTMLInputElement).value = '3'
    ;(shell.querySelector('[data-checklist-recurrence-unit]') as HTMLSelectElement).value = 'week'
    syncChecklistRecurrenceCustomVisibility(shell)
    expect((shell.querySelector('[data-checklist-recurrence-custom]') as HTMLElement).hidden).toBe(false)
    expect(readChecklistScheduleControl(shell)).toMatchObject({
      ok: true,
      recurrenceChoice: { frequency: 'custom', interval: 3, unit: 'week' },
    })
  })

  it('accepts a date with no time and schedules it for local 00:00', () => {
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, undefined, false, true)
    setChecklistSchedulePanelOpen(shell, true)
    ;(shell.querySelector('[data-checklist-due-input]') as HTMLInputElement).value = '2026-08-20'
    expect((shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value).toBe('')

    const result = readChecklistScheduleControl(shell)
    expect(result.ok).toBe(true)
    const dueAt = (result as { ok: true; dueAt: string }).dueAt
    expect(checklistDueAtToLocalInput(dueAt)).toBe('2026-08-20T00:00')
  })

  it('rejects a schedule with a time but no date, and says the time is optional', () => {
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, undefined, false, true)
    setChecklistSchedulePanelOpen(shell, true)
    ;(shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value = '09:30'

    expect(readChecklistScheduleControl(shell)).toEqual({
      ok: false,
      reason: 'Choose a valid due date. Leave the time blank for 00:00.',
    })
  })

  it('keeps an explicitly entered time untouched', () => {
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, undefined, false, true)
    setChecklistSchedulePanelOpen(shell, true)
    ;(shell.querySelector('[data-checklist-due-input]') as HTMLInputElement).value = '2026-08-20'
    ;(shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value = '17:45'

    const result = readChecklistScheduleControl(shell)
    expect(result.ok).toBe(true)
    expect(checklistDueAtToLocalInput((result as { ok: true; dueAt: string }).dueAt)).toBe('2026-08-20T17:45')
  })

  it('keeps the focused schedule form outside Lexical selection ownership', () => {
    const editor = createEditor({
      namespace: 'checklist-schedule-selection',
      onError: (error) => {
        throw error
      },
    })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)

    const item = document.createElement('li')
    root.appendChild(item)
    const shell = syncChecklistDueShell(item, undefined, false, true)
    const input = shell.querySelector('[data-checklist-due-input]') as HTMLInputElement

    setChecklistSchedulePanelOpen(shell, true)
    input.focus()

    const inputRetainedFocus = document.activeElement === input
    const formOwnsItsSelection = isDOMCapturingSelection(input, editor)

    editor.setRootElement(null)
    root.remove()

    expect(inputRetainedFocus).toBe(true)
    expect(formOwnsItsSelection).toBe(true)
  })

  it('preserves the exact fold offset, seconds, and milliseconds when Save is a no-op', () => {
    const exactSecondFoldInstant = '2026-11-01T06:30:45.123Z'
    const item = document.createElement('li')
    const shell = syncChecklistDueShell(item, exactSecondFoldInstant, false, true)
    const localParts = splitChecklistDueLocalInput(checklistDueAtToLocalInput(exactSecondFoldInstant))
    expect((shell.querySelector('[data-checklist-due-input]') as HTMLInputElement).value).toBe(localParts.date)
    expect((shell.querySelector('[data-checklist-due-time-input]') as HTMLInputElement).value).toBe(localParts.time)
    expect(readChecklistScheduleControl(shell, exactSecondFoldInstant)).toMatchObject({
      ok: true,
      dueAt: exactSecondFoldInstant,
    })
    // America/New_York repeats 01:30 on this date. Passing the captured wall
    // value makes the regression independent of the Jest host time zone.
    expect(resolveChecklistDueAtLocalInput('2026-11-01T01:30', exactSecondFoldInstant, '2026-11-01T01:30')).toBe(
      exactSecondFoldInstant,
    )
  })
})
