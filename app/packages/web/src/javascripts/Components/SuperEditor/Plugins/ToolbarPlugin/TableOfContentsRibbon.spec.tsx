/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { $createHeadingNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getNodeByKey,
  $getSelection,
  $setSelection,
  LexicalEditor,
} from 'lexical'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import { $createTableOfContentsNode, TableOfContentsNode } from '../../Lexical/Nodes/TableOfContentsNode'
import ToolbarPlugin from './ToolbarPlugin'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))
jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({
  useResponsiveAppPane: () => ({ presentPane: () => undefined }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
jest.setTimeout(30000)
let docked = true
const fakeApp = {
  getPreference: (key: string, fallback: unknown) => {
    return key === PrefKey.AlwaysShowSuperToolbar ? docked : (PrefDefaults[key as PrefKey] ?? fallback)
  },
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
    setLocalValue: () => undefined,
  },
  addEventObserver: () => () => undefined,
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
  isAuthorizedToRenderItem: () => true,
  vaultLocks: { addEventObserver: () => () => undefined },
  items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
  keyboardService: { addCommandHandler: () => () => undefined },
} as never
let editor: LexicalEditor
let container: HTMLElement
let reactRoot: Root
let indexKeys: string[]
function Capture() {
  const [current] = useLexicalComposerContext()
  useEffect(() => {
    editor = current
  }, [current])
  return null
}
beforeEach(() => {
  docked = true
  indexKeys = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
})
afterEach(async () => {
  await act(async () => reactRoot.unmount())
  container.remove()
})
async function mount(readonly = false) {
  await act(async () =>
    reactRoot.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer
            readonly={readonly}
            initialValue={() => {
              const indexes = [$createTableOfContentsNode(), $createTableOfContentsNode()]
              indexes[0].setFormat({ title: 'First contents' })
              indexes[1].setFormat({ title: 'Second contents' })
              indexKeys = indexes.map((node) => node.getKey())
              $getRoot().append(
                ...indexes,
                $createHeadingNode('h1').append($createTextNode('Alpha')),
                $createParagraphNode().append($createTextNode('Alpha body')),
                $createHeadingNode('h1').append($createTextNode('Beta')),
                $createParagraphNode().append($createTextNode('Beta body')),
              )
            }}
          >
            <div id="super-editor">
              <ToolbarPlugin />
              <RichTextPlugin
                contentEditable={<ContentEditable className="ContentEditable__root" />}
                placeholder={null}
                ErrorBoundary={LexicalErrorBoundary}
              />
              <Capture />
            </div>
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    ),
  )
}
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const selectedTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent
const ribbon = () => container.querySelector<HTMLElement>('[data-toc-ribbon]')
async function clickTab(name: string) {
  await act(async () =>
    tabs()
      .find((tab) => tab.textContent === name)!
      .click(),
  )
}
async function focusIndex(index = 0) {
  await act(async () =>
    container
      .querySelectorAll<HTMLElement>('[data-table-of-contents-block]')
      [index].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
  )
}
async function typeTitle(value: string) {
  const input = ribbon()!.querySelector<HTMLInputElement>('[aria-label="Contents title"]')!
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const entryTexts = (index = 0) =>
  [...container.querySelectorAll('[data-table-of-contents-block]')[index].querySelectorAll('button')].map(
    (button) => button.textContent,
  )

it.each([true, false])('opens a full dedicated ribbon by focusing the contents block (docked=%s)', async (isDocked) => {
  docked = isDocked
  await mount()
  await focusIndex()
  expect(selectedTab()).toBe('Table of contents')
  expect(container.querySelector('#super-mobile-toolbar')!.classList.contains('hidden')).toBe(false)
  expect(ribbon()).not.toBeNull()
  expect(ribbon()!.classList.contains('flex-nowrap')).toBe(true)
  expect(ribbon()!.classList.contains('flex-wrap')).toBe(false)
  expect(ribbon()!.classList.contains('overflow-x-auto')).toBe(true)
  expect(ribbon()!.classList.contains('min-w-0')).toBe(true)
  for (const group of [
    'Contents text',
    'Title typography',
    'Contents entries',
    'Contents appearance',
    'Contents colors',
    'Organize sections',
  ]) {
    expect(ribbon()!.querySelector(`[role="group"][aria-label="${group}"]`)).not.toBeNull()
  }
})

it('keeps the focused index targeted while typing and switches correctly between multiple indexes', async () => {
  await mount()
  await focusIndex(1)
  await typeTitle('My second index')
  expect(selectedTab()).toBe('Table of contents')
  expect(container.querySelectorAll('[data-toc-title]')[1].textContent).toBe('My second index')
  expect(container.querySelectorAll('[data-toc-title]')[0].textContent).toBe('First contents')
  await act(async () => editor.update(() => $setSelection(null), { discrete: true }))
  expect(ribbon()?.getAttribute('data-toc-ribbon')).toBe(indexKeys[1])
  await focusIndex(0)
  expect(ribbon()?.getAttribute('data-toc-ribbon')).toBe(indexKeys[0])
  await typeTitle('My first index')
  expect(container.querySelectorAll('[data-toc-title]')[0].textContent).toBe('My first index')
})

it('reorders contents entries separately from actual sections through the ribbon controls', async () => {
  await mount()
  await focusIndex()
  const press = async (name: string) =>
    act(async () => ribbon()!.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click())
  await press('Move contents entry down')
  expect(entryTexts()).toEqual(['Beta', 'Alpha'])
  expect(entryTexts(1)).toEqual(['Alpha', 'Beta'])
  expect(
    editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .slice(2)
        .map((node) => node.getTextContent()),
    ),
  ).toEqual(['Alpha', 'Alpha body', 'Beta', 'Beta body'])
  await press('Move note section down')
  expect(
    editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .slice(2)
        .map((node) => node.getTextContent()),
    ),
  ).toEqual(['Beta', 'Beta body', 'Alpha', 'Alpha body'])
  expect(entryTexts(1)).toEqual(['Beta', 'Alpha'])
})

it('restores the previous tab on leaving and respects an explicit tab choice while contents remain selected', async () => {
  await mount()
  await clickTab('Layout')
  await focusIndex()
  await act(async () => editor.update(() => $getRoot().getLastChild()!.selectEnd(), { discrete: true }))
  expect(selectedTab()).toBe('Layout')
  await focusIndex()
  await clickTab('Tools')
  await act(async () =>
    editor.update(() => ($getNodeByKey(indexKeys[0]) as TableOfContentsNode).setFormat({ numbered: true }), {
      discrete: true,
    }),
  )
  expect(selectedTab()).toBe('Tools')
  await focusIndex(1)
  expect(selectedTab()).toBe('Table of contents')
})

it('keeps native typing keys inside ribbon inputs and disables mutations in read mode', async () => {
  await mount(true)
  const before = editor.getEditorState().toJSON()
  await focusIndex()
  const input = ribbon()!.querySelector<HTMLInputElement>('[aria-label="Contents title"]')!
  expect(input.matches(':disabled')).toBe(true)
  const button = ribbon()!.querySelector<HTMLButtonElement>('[aria-label="Move note section down"]')!
  expect(button.disabled).toBe(true)
  await act(async () => button.click())
  expect(editor.getEditorState().toJSON()).toEqual(before)
  await act(async () => editor.setEditable(true))
  await act(async () => input.focus())
  const rangeBefore = editor.getEditorState().read(() => $getSelection()?.clone())
  const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
  await act(async () => input.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(false)
  expect(editor.getEditorState().read(() => $getSelection()?.is(rangeBefore ?? null))).toBe(true)
})

it('opens on keyboard focus and retires the ribbon when the selected contents block is deleted', async () => {
  await mount()
  await act(async () => container.querySelector<HTMLElement>('[data-table-of-contents-block]')!.focus())
  expect(selectedTab()).toBe('Table of contents')
  await act(async () => editor.update(() => $getNodeByKey(indexKeys[0])!.remove(), { discrete: true }))
  expect(ribbon()).toBeNull()
  expect(tabs().map((tab) => tab.textContent)).not.toContain('Table of contents')
})

it('retains the floating right collapse control when the contextual contents ribbon opens', async () => {
  await mount()
  await focusIndex()
  const toolbar = container.querySelector('#super-mobile-toolbar')!
  const corner = toolbar.querySelector('[data-super-toolbar-collapse-corner]')!
  expect(corner.parentElement).toBe(toolbar)
  expect(corner.querySelector('button[data-super-toolbar-collapse]')).not.toBeNull()
  expect(corner.closest('[inert]')).toBeNull()
})

it('applies ribbon formatting and resets appearance while preserving the contents order', async () => {
  await mount()
  await focusIndex()
  await act(async () => ribbon()!.querySelector<HTMLButtonElement>('[aria-label="Move contents entry down"]')!.click())
  const font = ribbon()!.querySelector<HTMLSelectElement>('[aria-label="Contents font"]')!
  await act(async () => {
    font.value = 'serif'
    font.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const subtitle = ribbon()!.querySelector<HTMLTextAreaElement>('[aria-label="Contents subtitle"]')!
  await act(async () => {
    subtitle.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(subtitle, 'Overview\nDetails')
    subtitle.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelector<HTMLElement>('[data-table-of-contents-block]')!.style.fontFamily).toBe(
    'ui-serif, serif',
  )
  expect(container.querySelector('[data-toc-subtitle]')!.textContent).toBe('Overview\nDetails')
  await act(async () =>
    [...ribbon()!.querySelectorAll('button')].find((button) => button.textContent === 'Reset formatting')!.click(),
  )
  expect(entryTexts()).toEqual(['Beta', 'Alpha'])
  expect(container.querySelector('[data-toc-subtitle]')!.textContent).toBe('Overview\nDetails')
  expect(container.querySelector<HTMLElement>('[data-table-of-contents-block]')!.style.fontFamily).toBe('inherit')
})

it('renders a saved custom order after reloading the note with fresh node keys', async () => {
  await mount()
  await focusIndex()
  await act(async () => ribbon()!.querySelector<HTMLButtonElement>('[aria-label="Move contents entry down"]')!.click())
  const saved = editor.getEditorState().toJSON()
  await act(async () => editor.setEditorState(editor.parseEditorState(saved)))
  expect(entryTexts()).toEqual(['Beta', 'Alpha'])
  expect(entryTexts(1)).toEqual(['Alpha', 'Beta'])
  await focusIndex()
  expect(ribbon()?.getAttribute('data-toc-ribbon')).not.toBe(indexKeys[0])
})
