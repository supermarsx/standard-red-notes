/** @jest-environment jsdom */

/**
 * The lazy-on-open generation pass, through the real plugin.
 *
 * `checklistGeneration.spec.ts` proves what a pass produces. This proves the pass
 * is actually WIRED, and — more importantly — that it is wired behind the gates it
 * is supposed to be behind. A generation pass writes to the user's note merely
 * because they opened it, so "did it run" and "did it refuse to run" are equally
 * load-bearing: the pure module could be perfect while nothing called it, or while
 * it called it on a locked note, with every unit test still green.
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
import { FeatureStatus, NoteType } from '@standardnotes/snjs'
import { CheckListPlugin } from './CheckListPlugin'
import { createChecklistRecurrence } from '../Checklist/checklistRecurrence'
import { $getChecklistDueAt, $getChecklistRecurrence, $setChecklistSchedule } from '../Lexical/Nodes/ChecklistItemNode'

/** Three monthly occurrences fall in [dueAt, NOW]: 15 Jan, 15 Feb, 15 Mar 2027. */
const THREE_OVERDUE = '2027-01-15T09:00:00.000Z'
const NOW = Date.parse('2027-03-20T12:00:00.000Z')

type FakeNote = { uuid: string; noteType: NoteType; trashed: boolean; locked: boolean; payload: undefined }

let note: FakeNote
let preferences: Map<string, unknown>
let readPreferenceKeys: string[]

const fakeApplication = {
  platform: 'web',
  keyboardService: {
    activeModifiers: new Set<string>(),
    registerExternalKeyboardShortcutHelpItem: () => () => undefined,
  },
  items: { findItem: () => note },
  sessions: { isCurrentSessionReadOnly: () => false },
  vaults: { getItemVault: () => undefined },
  vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
  features: { getFeatureStatus: () => FeatureStatus.Entitled },
  isAuthorizedToRenderItem: () => true,
  getPreference: (key: unknown) => {
    readPreferenceKeys.push(String(key))
    return preferences.get(String(key))
  },
}

jest.mock('../../ApplicationProvider', () => ({
  useApplication: () => fakeApplication,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
        $setChecklistSchedule(row, THREE_OVERDUE, createChecklistRecurrence('monthly', THREE_OVERDUE, 'UTC'))
      },
      { discrete: true },
    )
  }, [composerEditor])

  return null
}

type HarnessProps = { ownerRole?: 'interactive' | 'detached'; noteUuid?: string; flushChanges?: () => void }

function Harness({ ownerRole = 'interactive', noteUuid, flushChanges }: HarnessProps) {
  return createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: 'checklist-generation-wiring',
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
    createElement(CheckListPlugin, { ownerRole, noteUuid, flushChanges }),
  )
}

describe('the generation pass runs when a note is opened, and only where it may', () => {
  let container: HTMLElement
  let root: Root
  let flushed: number
  let nowSpy: jest.SpyInstance<number, []>

  beforeEach(() => {
    editor = undefined
    flushed = 0
    note = { uuid: 'note-1', noteType: NoteType.Super, trashed: false, locked: false, payload: undefined }
    preferences = new Map<string, unknown>()
    readPreferenceKeys = []
    // The pass reads the clock itself, so the clock is what makes the fixture
    // three months overdue rather than a hard-coded "now" the pass never sees.
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    nowSpy.mockRestore()
  })

  const mount = (props: HarnessProps = {}) =>
    act(() => root.render(createElement(Harness, { noteUuid: 'note-1', ...props, flushChanges: () => (flushed += 1) })))

  /** Every row of the first checklist, as (deadline, has-a-rule). */
  const rows = () =>
    (editor as LexicalEditor).read(() =>
      (($getRoot().getFirstChild() as ListNode).getChildren() as ListItemNode[]).map((row) => ({
        dueAt: $getChecklistDueAt(row),
        recurring: $getChecklistRecurrence(row) !== undefined,
      })),
    )

  it('writes down the three owed occurrences and moves the live row forward', () => {
    mount()

    expect(rows()).toEqual([
      { dueAt: '2027-04-15T09:00:00.000Z', recurring: true },
      { dueAt: '2027-01-15T09:00:00.000Z', recurring: false },
      { dueAt: '2027-02-15T09:00:00.000Z', recurring: false },
      { dueAt: '2027-03-15T09:00:00.000Z', recurring: false },
    ])
    // The note has to be saved, or the work is lost on close.
    expect(flushed).toBeGreaterThan(0)
  })

  it('reads both synced preferences by their pinned literal keys', () => {
    mount()

    expect(readPreferenceKeys).toContain('checklistAutoGenerateRecurrences')
    expect(readPreferenceKeys).toContain('checklistGenerateCap')
  })

  it('generates once per open, even if the note is left open past the next occurrence', () => {
    mount()
    const afterOpen = rows()
    const flushedAfterOpen = flushed

    // Three months pass with the note still on screen, so the live row is overdue
    // again and a pass that had not settled would have real work to do. It must
    // still not run: generation is on OPEN, and a note that rewrites itself while
    // the user is reading it is not what "lazy-on-open" means.
    nowSpy.mockReturnValue(Date.parse('2027-06-20T12:00:00.000Z'))
    act(() => {
      ;(editor as LexicalEditor).update(
        () => {
          ;($getRoot().getFirstChild() as ListNode).getFirstChild()!.selectEnd()
        },
        { discrete: true },
      )
    })

    expect(rows()).toEqual(afterOpen)
    expect(flushed).toBe(flushedAfterOpen)
  })

  it('leaves the note completely alone from the detached background owner', () => {
    mount({ ownerRole: 'detached' })

    expect(rows()).toEqual([{ dueAt: THREE_OVERDUE, recurring: true }])
  })

  it('leaves the note alone when there is no note whose permissions could be checked', () => {
    mount({ noteUuid: undefined })

    expect(rows()).toEqual([{ dueAt: THREE_OVERDUE, recurring: true }])
  })

  it('refuses to write to a locked note', () => {
    note = { ...note, locked: true }
    mount()

    expect(rows()).toEqual([{ dueAt: THREE_OVERDUE, recurring: true }])
  })

  it('refuses to write while the session is read-only', () => {
    const readOnly = jest.spyOn(fakeApplication.sessions, 'isCurrentSessionReadOnly').mockReturnValue(true)
    mount()

    expect(rows()).toEqual([{ dueAt: THREE_OVERDUE, recurring: true }])
    readOnly.mockRestore()
  })

  it('honours the automatic toggle being switched off', () => {
    preferences.set('checklistAutoGenerateRecurrences', false)
    mount()

    expect(rows()).toEqual([{ dueAt: THREE_OVERDUE, recurring: true }])
  })

  it('honours a cap another device wrote, clamped on read', () => {
    // A cap of 1 keeps only the most recent owed occurrence and records the rest.
    preferences.set('checklistGenerateCap', 0)
    mount()

    const generated = rows().slice(1)
    expect(generated.filter((row) => row.dueAt !== undefined)).toEqual([
      { dueAt: '2027-03-15T09:00:00.000Z', recurring: false },
    ])
    // Plus the record, which has no deadline of its own.
    expect(generated.filter((row) => row.dueAt === undefined)).toHaveLength(1)
  })
})
