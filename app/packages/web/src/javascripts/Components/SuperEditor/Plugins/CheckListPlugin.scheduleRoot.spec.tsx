/** @jest-environment jsdom */

import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot, getNearestEditorFromDOMNode, type LexicalEditor } from 'lexical'
import { act, createElement, type ComponentType, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $getChecklistItems } from '../Checklist/ChecklistEditorMutations'
import { $getChecklistDueAt } from '../Lexical/Nodes/ChecklistItemNode'

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

type SchedulePluginComponent = ComponentType<Record<string, never>>

const editorConfigs = {
  first: {
    namespace: 'schedule-root-first',
    nodes: [ListNode, ListItemNode],
    onError: (error: Error) => {
      throw error
    },
  },
  second: {
    namespace: 'schedule-root-second',
    nodes: [ListNode, ListItemNode],
    onError: (error: Error) => {
      throw error
    },
  },
}

const editors = new Map<string, LexicalEditor>()

function CaptureAndSeedEditor({ editorId }: { editorId: keyof typeof editorConfigs }) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    if (editors.has(editorId)) {
      return
    }
    editors.set(editorId, editor)
    editor.update(
      () => {
        const item = $createListItemNode(false).append($createTextNode(`${editorId} task`))
        $getRoot().clear().append($createListNode('check').append(item))
      },
      { discrete: true },
    )
  }, [editor, editorId])

  return null
}

function EditorHarness({
  editorId,
  SchedulePlugin,
}: {
  editorId: keyof typeof editorConfigs
  SchedulePlugin?: SchedulePluginComponent
}) {
  return createElement(
    'section',
    { 'data-editor-host': editorId },
    createElement(
      LexicalComposer,
      { initialConfig: editorConfigs[editorId] },
      createElement(RichTextPlugin, {
        contentEditable: createElement(ContentEditable, { 'aria-label': `${editorId} editor` }),
        placeholder: null,
        ErrorBoundary: LexicalErrorBoundary,
      }),
      createElement(CaptureAndSeedEditor, { editorId }),
      SchedulePlugin ? createElement(SchedulePlugin) : null,
    ),
  )
}

function Editors({ SchedulePlugin }: { SchedulePlugin?: SchedulePluginComponent }) {
  return createElement(
    'div',
    null,
    createElement(EditorHarness, { editorId: 'first', SchedulePlugin }),
    createElement(EditorHarness, { editorId: 'second', SchedulePlugin }),
  )
}

function getHost(container: HTMLElement, editorId: keyof typeof editorConfigs): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-editor-host="${editorId}"]`) as HTMLElement
}

function openAndCloseSchedule(host: HTMLElement): void {
  const open = host.querySelector<HTMLButtonElement>('[data-checklist-due-action="edit-schedule"]') as HTMLButtonElement
  const panel = host.querySelector<HTMLElement>('[data-checklist-schedule-panel]') as HTMLElement

  act(() => open.click())
  expect(open.getAttribute('aria-expanded')).toBe('true')
  expect(panel.hidden).toBe(false)

  const cancel = host.querySelector<HTMLButtonElement>(
    '[data-checklist-due-action="cancel-schedule"]',
  ) as HTMLButtonElement
  act(() => cancel.click())
  expect(open.getAttribute('aria-expanded')).toBe('false')
  expect(panel.hidden).toBe(true)
}

describe('CheckListPlugin schedule root ownership', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    editors.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.restoreAllMocks()
  })

  it('dynamically mounts beside two existing editors, targets the owning editor, and cleans up repeated mounts', async () => {
    act(() => root.render(createElement(Editors)))

    const firstEditor = editors.get('first') as LexicalEditor
    const secondEditor = editors.get('second') as LexicalEditor
    const firstRoot = firstEditor.getRootElement() as HTMLElement
    const secondRoot = secondEditor.getRootElement() as HTMLElement

    expect(firstRoot).not.toBe(secondRoot)
    expect(getNearestEditorFromDOMNode(firstRoot)).toBe(firstEditor)
    expect(getNearestEditorFromDOMNode(secondRoot)).toBe(secondEditor)
    expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(2)
    expect(container.querySelector('[data-checklist-due-action="edit-schedule"]')).toBeNull()

    const firstAddListener = jest.spyOn(firstRoot, 'addEventListener')
    const firstRemoveListener = jest.spyOn(firstRoot, 'removeEventListener')
    const secondAddListener = jest.spyOn(secondRoot, 'addEventListener')
    const secondRemoveListener = jest.spyOn(secondRoot, 'removeEventListener')
    const runtimeErrors: ErrorEvent[] = []
    const captureRuntimeError = (event: ErrorEvent) => {
      runtimeErrors.push(event)
      event.preventDefault()
    }
    window.addEventListener('error', captureRuntimeError)

    try {
      const { CheckListPlugin } = await import('./CheckListPlugin')
      const SchedulePlugin = CheckListPlugin as SchedulePluginComponent

      act(() => root.render(createElement(Editors, { SchedulePlugin })))

      expect(editors.get('first')).toBe(firstEditor)
      expect(editors.get('second')).toBe(secondEditor)
      expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(2)
      expect(firstAddListener.mock.calls.filter(([type]) => type === 'click')).toHaveLength(2)
      expect(secondAddListener.mock.calls.filter(([type]) => type === 'click')).toHaveLength(2)

      openAndCloseSchedule(getHost(container, 'first'))
      openAndCloseSchedule(getHost(container, 'second'))
      openAndCloseSchedule(getHost(container, 'first'))

      const firstHost = getHost(container, 'first')
      const firstOpen = firstHost.querySelector<HTMLButtonElement>(
        '[data-checklist-due-action="edit-schedule"]',
      ) as HTMLButtonElement
      act(() => firstOpen.click())
      const dueInput = firstHost.querySelector<HTMLInputElement>('[data-checklist-due-input]') as HTMLInputElement
      const dueTimeInput = firstHost.querySelector<HTMLInputElement>(
        '[data-checklist-due-time-input]',
      ) as HTMLInputElement
      dueInput.value = '2099-01-02'
      dueTimeInput.value = '03:04'
      const save = firstHost.querySelector<HTMLButtonElement>(
        '[data-checklist-due-action="save-schedule"]',
      ) as HTMLButtonElement
      act(() => save.click())

      expect(firstEditor.read(() => $getChecklistDueAt($getChecklistItems()[0]))).toBeDefined()
      expect(secondEditor.read(() => $getChecklistDueAt($getChecklistItems()[0]))).toBeUndefined()

      act(() => root.render(createElement(Editors)))
      expect(firstRemoveListener.mock.calls.filter(([type]) => type === 'click')).toHaveLength(2)
      expect(secondRemoveListener.mock.calls.filter(([type]) => type === 'click')).toHaveLength(2)

      act(() => root.render(createElement(Editors, { SchedulePlugin })))
      expect(firstAddListener.mock.calls.filter(([type]) => type === 'click')).toHaveLength(4)
      expect(secondAddListener.mock.calls.filter(([type]) => type === 'click')).toHaveLength(4)
      openAndCloseSchedule(getHost(container, 'first'))

      expect(editors.get('first')).toBe(firstEditor)
      expect(editors.get('second')).toBe(secondEditor)
      expect(container.querySelectorAll('[contenteditable="true"]')).toHaveLength(2)
      expect(runtimeErrors).toHaveLength(0)
    } finally {
      window.removeEventListener('error', captureRuntimeError)
    }
  })
})
