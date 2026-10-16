/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the checklist bulk-completion group (task t91).
 *
 * A toolbar group in this file has twice been added, typechecked clean, passed
 * its unit tests — and then silently failed to render, because the group-level
 * "drop groups with nothing renderable" filter in ToolbarPlugin deleted a group
 * whose buttons were all special-cased. Green tsc + green logic tests are
 * therefore NOT evidence that a toolbar button exists.
 *
 * This test mounts the REAL ToolbarPlugin (inside the real composer) and asserts
 * the Checklist group and its three buttons are actually in the DOM, after the
 * whole pipeline has run: applyToolbarConfig -> the renderable-group filter ->
 * groupsBySuperGroup tab partitioning -> the explicit `layout` row resolution
 * (a button missing from a group's `layout` array renders nowhere, even though
 * it is listed in `buttons`).
 */
import { act, useEffect } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createListItemNode, $createListNode, ListNode } from '@lexical/list'
import {
  $createTextNode,
  $getRoot,
  $createParagraphNode,
  $setSelection,
  $createNodeSelection,
  LexicalEditor,
} from 'lexical'
import { createRoot, Root } from 'react-dom/client'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'

jest.mock('@/Components/Comments/CommentsPanel', () => ({
  __esModule: true,
  default: ({ anchor }: { anchor?: { todoId: string } }) => (
    <input aria-label="Comment draft" data-comment-target={anchor?.todoId ?? 'note'} />
  ),
}))

let editor: LexicalEditor
function CaptureEditor() {
  const [current] = useLexicalComposerContext()
  useEffect(() => {
    editor = current
  }, [current])
  return null
}

// Desktop layout; `alwaysShowToolbar` (below) then docks the full ribbon, which
// is the surface the three buttons live on.
jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
/**
 * Mounting the real 5000-line ToolbarPlugin in jsdom costs several seconds per
 * test, and under a full parallel `yarn test` run it crossed jest's 5s default and
 * failed as a TIMEOUT rather than an assertion — a flake that reads exactly like a
 * broken toolbar. Six specs in this directory mount it, so the cause is shared and
 * the timeout is raised in all of them (precedent: the Collaboration integration
 * specs). This is headroom for a slow mount, not a wait for anything async.
 */
jest.setTimeout(30000)

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const fakeApp = {
  // Docks the ribbon so every group renders (rather than the floating
  // selection mini-toolbar).
  getPreference: (key: string, fallback: unknown) => {
    if (key === PrefKey.AlwaysShowSuperToolbar) {
      return true
    }
    return PrefDefaults[key as PrefKey] ?? fallback
  },
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
    setLocalValue: () => undefined,
  },
  addEventObserver: () => () => undefined,
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
  // Render authorization (useItemAuthorization) subscribes to these on mount.
  isAuthorizedToRenderItem: () => true,
  vaultLocks: { addEventObserver: () => () => undefined },
  sessions: { getUser: () => ({ uuid: 'alice' }) },
  items: {
    findItem: () => ({ uuid: 'note-1' }),
    streamItems: () => () => undefined,
    addObserver: () => () => undefined,
  },
  keyboardService: { addCommandHandler: () => () => undefined },
} as never

let container: HTMLElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const mount = async (withChecklist = true, readonly = false, selectChecklist = true) => {
  await act(async () => {
    root.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer
            readonly={readonly}
            initialValue={() => {
              if (withChecklist) {
                const item = $createListItemNode(false).append($createTextNode('Task'))
                $getRoot().append($createListNode('check').append(item))
                if (selectChecklist) {
                  item.selectEnd()
                }
              } else {
                $getRoot().append($createParagraphNode())
              }
            }}
          >
            <ToolbarPlugin noteUuid="note-1" note={{ uuid: 'note-1' } as never} />
            <CaptureEditor />
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })
  if (withChecklist && !readonly && selectChecklist) {
    await clickTab('Checklist')
  }
}

const checklistGroup = () => container.querySelector('[role="group"][aria-label="Checklist"]')

describe('checklist bulk-completion toolbar group renders', () => {
  it('puts the Checklist group in the real rendered toolbar', async () => {
    await mount()
    expect(checklistGroup()).not.toBeNull()
  })

  it('renders all three bulk-completion buttons plus the settings button inside that group', async () => {
    await mount()
    const group = checklistGroup()
    expect(group).not.toBeNull()
    // Four real buttons — the three bulk actions and the Checklists-subsection
    // opener (t111); dividers are aria-hidden separators, not buttons.
    const buttons = group!.querySelectorAll('button')
    expect(buttons).toHaveLength(4)
    expect(group!.querySelector('[role="separator"]')).not.toBeNull()
  })

  it('renders the group caption so the user can find it', async () => {
    await mount()
    expect(checklistGroup()!.textContent).toContain('Checklist')
  })

  it('renders the buttons as reachable toolbar items rather than inert markup', async () => {
    await mount()
    const buttons = Array.from(checklistGroup()!.querySelectorAll('button'))
    // The caret is inside a real task, so the task-specific actions are ready.
    for (const button of buttons.slice(0, 3)) {
      expect(button.getAttribute('aria-disabled')).not.toBe('true')
      expect(button.hasAttribute('disabled')).toBe(false)
    }
    // The settings button is NOT one of them: most of what the subsection hosts
    // (the recurrence settings, Generate now) is note- or account-wide, so gating
    // it on a checklist under the caret would hide the controls that need none.
    const settingsButton = buttons[3]
    expect(settingsButton.getAttribute('aria-disabled')).not.toBe('true')
    expect(settingsButton.hasAttribute('disabled')).toBe(false)
  })

  // The second half of the failure mode — a button listed in `buttons` but
  // forgotten in the group's `layout`, so it renders nowhere while Customize
  // Toolbar still offers to hide it — used to be asserted here for the Checklist
  // group alone. Scoping it to one group is exactly why the same bug went
  // unnoticed in the Paragraph group (`changeCase`). It now lives in
  // ToolbarConfig.spec.ts's "group layout coverage", which holds for every group.
})

const findTab = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === name)
const clickTab = async (name: string) => {
  await act(async () => {
    findTab(name)!.click()
  })
}

it('places TOC insertion, navigation and formatting together in Review beside comment tools', async () => {
  await mount(false)
  await clickTab('Insert')
  expect(container.querySelector('[role="group"][aria-label="Table of contents"]')).toBeNull()
  await clickTab('Review')
  expect([...container.querySelectorAll('[role="tab"]')].filter((tab) => tab.textContent === 'Review')).toHaveLength(1)
  const group = container.querySelector<HTMLElement>('[role="group"][aria-label="Table of contents"]')!
  expect(group).not.toBeNull()
  expect(group.classList.contains('super-toolbar-group')).toBe(true)
  expect([...group.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual([
    'Insert',
    'Navigate headings',
    'Format',
  ])
  expect(container.querySelector('[aria-label="Comment tools"]')).not.toBeNull()
  await act(async () => group.querySelector<HTMLButtonElement>('button')!.click())
  editor.getEditorState().read(() =>
    expect(
      $getRoot()
        .getChildren()
        .some((node) => node.getType() === 'table-of-contents'),
    ).toBe(true),
  )
  expect(group.querySelectorAll('button')).toHaveLength(3)
})

it('shows concise visible labels beside list icons in the Insert Lists group', async () => {
  await mount(false)
  await clickTab('Insert')
  const groups = [...container.querySelectorAll<HTMLElement>('[role="group"]')]
  const lists = groups.find((group) => group.getAttribute('aria-label') === 'blockCategoryLists')!
  expect(lists).toBeDefined()
  const labels = [...lists.querySelectorAll('button span')].map((label) => label.textContent?.trim())
  expect(labels.some((label) => /bulleted/i.test(label ?? ''))).toBe(true)
  expect(labels.some((label) => /numbered/i.test(label ?? ''))).toBe(true)
  expect(labels.some((label) => /checklist/i.test(label ?? ''))).toBe(true)
  for (const button of lists.querySelectorAll('button')) {
    expect(button.querySelector('svg')).not.toBeNull()
  }
})

it('uses ribbon groups for per-item settings and Review, with no duplicate task or comment list', async () => {
  await mount(false)
  expect(findTab('Review')).toBeDefined()
  expect(findTab('Checklist')).toBeUndefined()
  await act(async () => {
    editor.update(
      () => {
        $getRoot().append(
          $createListNode('check').append($createListItemNode(false).append($createTextNode('Review this task'))),
        )
        ;($getRoot().getLastChild() as ListNode).getFirstChild()!.selectEnd()
      },
      { discrete: true },
    )
  })
  await clickTab('Checklist')
  const tasks = container.querySelector<HTMLElement>('[aria-label="Checklist tasks"]')!
  expect(tasks.hidden).toBe(false)
  expect(tasks.classList.contains('super-toolbar-group')).toBe(true)
  expect(tasks.closest('[role="toolbar"]')).not.toBeNull()
  expect(tasks.querySelectorAll('[role="combobox"]')).toHaveLength(2)
  expect(tasks.querySelectorAll('[aria-label="Selected checklist item"]')).toHaveLength(1)
  await act(async () => tasks.querySelector<HTMLButtonElement>('[aria-label="Item comments"]')!.click())
  expect(findTab('Review')?.getAttribute('aria-selected')).toBe('true')
  const review = container.querySelector<HTMLElement>('[aria-label="Comment tools"]')!
  expect(review.classList.contains('super-toolbar-group')).toBe(true)
  expect(review.closest('[role="toolbar"]')).not.toBeNull()
  expect(review.querySelectorAll('button')).toHaveLength(4)
  expect(container.querySelector('[aria-label="Comment draft"]')).toBeNull()
  await clickTab('Home')
  expect(container.querySelector('[aria-label="Comment tools"]')).toBeNull()
  await clickTab('Review')
  await act(async () => editor.setEditable(false))
  expect(findTab('Review')).toBeUndefined()
  expect(findTab('Checklist')).toBeUndefined()
  expect(findTab('Home')).toBeUndefined()
  expect(container.querySelector('[aria-label="Comment tools"]')).toBeNull()
  expect(container.querySelector('#super-mobile-toolbar')?.classList.contains('hidden')).toBe(true)
  await act(async () => editor.setEditable(true))
  expect(findTab('Review')?.getAttribute('aria-selected')).toBe('true')
  expect(findTab('Checklist')).toBeDefined()
  expect(container.querySelector('#super-mobile-toolbar')?.classList.contains('hidden')).toBe(false)
  await act(async () => editor.update(() => $getRoot().clear().append($createParagraphNode()), { discrete: true }))
  expect(findTab('Checklist')).toBeUndefined()
  expect(findTab('Review')).toBeDefined()
})

it('removes checklist controls when the editor stops being editable and restores them when it resumes', async () => {
  await mount()
  expect(container.querySelector('[aria-label="Checklist tasks"]')).not.toBeNull()
  await act(async () => editor.setEditable(false))
  expect(findTab('Checklist')).toBeUndefined()
  expect(findTab('Review')).toBeUndefined()
  expect(container.querySelector('[aria-label="Checklist tasks"]')).toBeNull()
  expect(container.querySelector('[aria-label="Review tools"]')).toBeNull()
  await act(async () => editor.setEditable(true))
  expect(findTab('Checklist')?.getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector('[aria-label="Checklist tasks"]')).not.toBeNull()
})

it('does not offer Checklist or Review during an initially readonly editor lifetime', async () => {
  await mount(true, true)
  expect(findTab('Checklist')).toBeUndefined()
  expect(findTab('Review')).toBeUndefined()
  expect(container.querySelector('[aria-label="Checklist tasks"]')).toBeNull()
  expect(container.querySelector('[aria-label="Review tools"]')).toBeNull()
  await act(async () => editor.setEditable(true))
  expect(findTab('Checklist')).toBeDefined()
  expect(findTab('Review')).toBeDefined()
})

it('offers Checklist only for the current task selection, restores the preceding tab, and retires stale tab state', async () => {
  await mount(true, false, false)
  expect(findTab('Checklist')).toBeUndefined()
  await clickTab('Insert')
  await act(async () =>
    editor.update(
      () => {
        const item = ($getRoot().getFirstChild() as ListNode).getFirstChild()!
        item.selectEnd()
      },
      { discrete: true },
    ),
  )
  expect(findTab('Checklist')).toBeDefined()
  await clickTab('Checklist')
  expect(findTab('Checklist')?.getAttribute('aria-selected')).toBe('true')
  // Ribbon focus must not discard the task context or flash its tab closed.
  await act(async () => {
    findTab('Checklist')!.focus()
    editor.update(() => $setSelection(null), { discrete: true })
  })
  expect(findTab('Checklist')?.getAttribute('aria-selected')).toBe('true')
  await act(async () =>
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('Ordinary prose')))
        $getRoot().getLastChild()!.selectEnd()
      },
      { discrete: true },
    ),
  )
  expect(findTab('Checklist')).toBeUndefined()
  expect(findTab('Insert')?.getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector('[aria-label="Checklist tasks"]')).toBeNull()
  // Selecting the task again offers its tab without reopening an old selection.
  await act(async () =>
    editor.update(
      () => {
        const item = ($getRoot().getFirstChild() as ListNode).getFirstChild()!
        const selection = $createNodeSelection()
        selection.add(item.getKey())
        $setSelection(selection)
      },
      { discrete: true },
    ),
  )
  expect(findTab('Checklist')).toBeDefined()
  expect(findTab('Insert')?.getAttribute('aria-selected')).toBe('true')
})
