/** @jest-environment jsdom */

/**
 * The user's reported bug, driven end to end through the real plugin.
 *
 * A monthly task anchored on the 31st legitimately rolls to a clamped Feb 28 —
 * that is the chosen rule, and `anchor.day` stays 31 so March comes back to the
 * 31st. The defect was at the SAVE seam: the inline schedule panel rebuilt the
 * rule with `createChecklistRecurrence(choice, schedule.dueAt, tz)`, which
 * derives a fresh anchor from whatever `dueAt` it is handed, while
 * `resolveChecklistDueAtLocalInput` deliberately hands back the exact stored
 * instant when the draft is unchanged. So opening the panel and pressing Save
 * WITHOUT TOUCHING THE DATE rewrote `anchor.day` to 28, permanently, and every
 * later month followed the 28th. The rebuilt rule is passed as
 * `patch.recurrence`, which takes the `!== undefined` branch in
 * `ChecklistEditorMutations` and is written verbatim, so the one re-anchor guard
 * that does exist there never saw it.
 *
 * Unit tests on `resolveChecklistRecurrenceForSave` cannot prove the fix: the
 * helper could be perfect while this call site still rebuilt the rule. So this
 * mounts the real plugin, clicks the real buttons, and reads the anchor back out
 * of the node.
 *
 * Every instant is derived from a LOCAL wall-clock date rather than hard-coded in
 * UTC, because the panel round-trips through `datetime-local` in the host zone
 * and the suite must mean the same thing wherever it runs.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot, type LexicalEditor } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CheckListPlugin } from './CheckListPlugin'
import {
  CHECKLIST_DUE_ACTION_ATTR,
  CHECKLIST_DUE_INPUT_ATTR,
  CHECKLIST_DUE_SHELL_ATTR,
  CHECKLIST_DUE_TIME_INPUT_ATTR,
} from '../Checklist/ChecklistDueControls'
import { checklistDueAtFromLocalInput } from '../Checklist/checklistDueDate'
import { advanceChecklistDueAt, createChecklistRecurrence } from '../Checklist/checklistRecurrence'
import { $getChecklistDueAt, $getChecklistRecurrence, $setChecklistSchedule } from '../Lexical/Nodes/ChecklistItemNode'

jest.mock('../../ApplicationProvider', () => ({
  useApplication: () => ({
    platform: 'web',
    keyboardService: {
      activeModifiers: new Set(),
      registerExternalKeyboardShortcutHelpItem: () => () => undefined,
    },
  }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Local noon on 31 January 2027 — noon so no DST transition can move the day. */
const JANUARY_31_NOON = checklistDueAtFromLocalInput('2027-01-31T12:00') as string
/** The rule the user has: monthly, anchored on the 31st in the host zone. */
const monthly = () => createChecklistRecurrence('monthly', JANUARY_31_NOON)!
/** Where January's occurrence rolls to: February clamped, which has no 31st. */
const FEBRUARY_CLAMPED = advanceChecklistDueAt(JANUARY_31_NOON, monthly(), Date.parse(JANUARY_31_NOON)) as string

let editor: LexicalEditor | undefined

function CaptureAndSeed() {
  const [composerEditor] = useLexicalComposerContext()

  useEffect(() => {
    editor = composerEditor
    composerEditor.update(
      () => {
        const list = $createListNode('check')
        const row = $createListItemNode(false)
        row.append($createTextNode('pay the rent'))
        list.append(row)
        $getRoot().clear().append(list)
        // The state the user is actually in: the rule still anchored on the 31st,
        // the deadline already clamped onto February.
        $setChecklistSchedule(row, FEBRUARY_CLAMPED, monthly())
      },
      { discrete: true },
    )
  }, [composerEditor])

  return null
}

function Harness() {
  return createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: 'checklist-recurrence-save',
        nodes: [ListNode, ListItemNode],
        onError: (error: Error) => {
          throw error
        },
      },
    },
    createElement(RichTextPlugin, {
      contentEditable: createElement(ContentEditable, { 'aria-label': 'editor' }),
      placeholder: null,
      ErrorBoundary: LexicalErrorBoundary,
    }),
    createElement(CaptureAndSeed),
    createElement(CheckListPlugin),
  )
}

describe('saving an unchanged inline schedule must not re-anchor the recurrence', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    editor = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(createElement(Harness)))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const shell = () => container.querySelector<HTMLElement>(`[${CHECKLIST_DUE_SHELL_ATTR}]`) as HTMLElement
  const button = (action: string) =>
    shell().querySelector<HTMLButtonElement>(`[${CHECKLIST_DUE_ACTION_ATTR}="${action}"]`) as HTMLButtonElement
  const dateInput = () => shell().querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_INPUT_ATTR}]`) as HTMLInputElement
  /** The time half the panel keeps while only the date field is retyped. */
  const timeValue = () =>
    shell().querySelector<HTMLInputElement>(`[${CHECKLIST_DUE_TIME_INPUT_ATTR}]`)?.value || '00:00'

  const openPanel = () => act(() => button('edit-schedule').click())
  const save = () => act(() => button('save-schedule').click())

  /** What the node actually holds now, read inside the editor. */
  const storedSchedule = () =>
    (editor as LexicalEditor).read(() => {
      const row = ($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode
      return { dueAt: $getChecklistDueAt(row), recurrence: $getChecklistRecurrence(row) }
    })

  it('starts from the clamped deadline with the 31st still stored as the anchor', () => {
    // The chosen rule, pinned here so a failure below cannot be blamed on the
    // fixture: February has no 31st, so the deadline clamps and the anchor does
    // not. That gap is exactly what makes a re-anchoring save destructive.
    expect(monthly().anchor.day).toBe(31)
    expect(FEBRUARY_CLAMPED).not.toBe(JANUARY_31_NOON)
    expect(new Date(FEBRUARY_CLAMPED).getDate()).not.toBe(31)

    expect(storedSchedule()).toMatchObject({
      dueAt: FEBRUARY_CLAMPED,
      recurrence: { frequency: 'monthly', anchor: { day: 31 } },
    })
  })

  it('pre-fills the panel with the stored deadline, so Save alone changes nothing', () => {
    openPanel()
    expect(dateInput().value.length).toBeGreaterThan(0)

    save()

    // The whole bug: the user pressed Save and did not touch the date.
    expect(storedSchedule()).toMatchObject({
      dueAt: FEBRUARY_CLAMPED,
      recurrence: { frequency: 'monthly', anchor: { day: 31 } },
    })
  })

  it('keeps every later month on the 31st after that save', () => {
    openPanel()
    save()

    const { dueAt, recurrence } = storedSchedule()
    const march = advanceChecklistDueAt(dueAt as string, recurrence!, Date.parse(dueAt as string)) as string
    // The user's stated requirement: a clamp must never ratchet the day down.
    expect(new Date(march).getDate()).toBe(31)
  })

  it('still re-anchors when the user actually moves the deadline', () => {
    // The guard preserves an anchor, it does not freeze one: an explicit date
    // edit is the single case where deriving a fresh anchor is correct.
    openPanel()
    const time = timeValue()
    act(() => {
      dateInput().value = '2027-03-15'
      dateInput().dispatchEvent(new Event('input', { bubbles: true }))
    })
    save()

    const { dueAt, recurrence } = storedSchedule()
    expect(dueAt).toBe(checklistDueAtFromLocalInput(`2027-03-15T${time}`))
    expect(recurrence).toMatchObject({ frequency: 'monthly', anchor: { day: 15 } })
  })
})
