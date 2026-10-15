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
import { $createTextNode, $getRoot, $createParagraphNode, LexicalEditor } from 'lexical'
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
  items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
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

const mount = async (withChecklist = true) => {
  await act(async () => {
    root.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer
            initialValue={() => {
              if (withChecklist) {
                $getRoot().append(
                  $createListNode('check').append($createListItemNode(false).append($createTextNode('Task'))),
                )
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
  if (withChecklist) {
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
    // Every button must be a real, clickable toolbar item. With no checklist
    // under the (empty) initial document the three bulk actions are aria-disabled
    // — but they use aria-disabled, NOT the native attribute, so they stay
    // focusable and their tooltip still explains them.
    for (const button of buttons.slice(0, 3)) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
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
  const review = container.querySelector<HTMLElement>('[aria-label="Review tools"]')!
  expect(review.classList.contains('super-toolbar-group')).toBe(true)
  expect(review.closest('[role="toolbar"]')).not.toBeNull()
  expect(review.querySelectorAll('button')).toHaveLength(2)
  expect(container.querySelector('[aria-label="Comment draft"]')).toBeNull()
  await clickTab('Home')
  expect(container.querySelector('[aria-label="Review tools"]')).toBeNull()
  await clickTab('Review')
  await act(async () => editor.setEditable(false))
  expect(findTab('Review')?.getAttribute('aria-selected')).toBe('true')
  expect(findTab('Home')).toBeUndefined()
  expect(container.querySelector('[aria-label="Review tools"]')).not.toBeNull()
  await act(async () => editor.update(() => $getRoot().clear().append($createParagraphNode()), { discrete: true }))
  expect(findTab('Checklist')).toBeUndefined()
  expect(findTab('Review')).toBeDefined()
})
