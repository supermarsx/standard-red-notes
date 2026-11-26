/** @jest-environment jsdom */
import { act, useEffect, useSyncExternalStore } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HeadingNode, $createHeadingNode } from '@lexical/rich-text'
import { $createListNode, $createListItemNode, ListNode, ListItemNode } from '@lexical/list'
import { $getRoot, $createTextNode, LexicalEditor, TextNode } from 'lexical'
import ApplicationProvider from '@/Components/ApplicationProvider'
import { EditorControlsProvider, useEditorControlsState } from '../EditorControlsContext'
import NavigationSidebar from '../Plugins/NavigationSidebarPlugin/NavigationSidebarPlugin'
import { EditorNavigationAids } from '../Plugins/EditorNavigationAids/EditorNavigationAids'
import { loadNoteLayout } from '../Layout/layoutSettings'
import ViewRibbon, { NoteViewPreferencesBridge } from './ViewRibbon'
import { DEFAULT_EDITOR_VIEW, NOTE_VIEW_KEY, EditorViewPreferences } from '@/View/editorViewPreferences'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm' },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const editors = new Map<string, LexicalEditor>()
const identities = { first: {}, second: {} }
const notes = {
  first: {
    uuid: 'first',
    locked: false,
    view: {} as Partial<EditorViewPreferences>,
    getAppDomainValue(key: unknown) {
      return key === NOTE_VIEW_KEY ? this.view : undefined
    },
  },
  second: {
    uuid: 'second',
    locked: false,
    view: {} as Partial<EditorViewPreferences>,
    getAppDomainValue(key: unknown) {
      return key === NOTE_VIEW_KEY ? this.view : undefined
    },
  },
}
const observers = new Set<(event: unknown) => void>()
const savePatch = async (note: typeof notes.first, value: Partial<EditorViewPreferences>) => {
  note.view = { ...note.view, ...value }
  observers.forEach((observer) => observer({ changed: [note], inserted: [], unerrored: [], removed: [] }))
}
const patch = jest.fn(savePatch)
const app = {
  getPreference: (_key: unknown, fallback: unknown) => fallback,
  addEventObserver: () => () => undefined,
  itemListController: { activeControllerItem: { uuid: 'second' } },
  notesController: { patchNoteViewPreferences: patch },
  items: {
    findItem: (uuid: keyof typeof notes) => notes[uuid],
    addObserver: (_types: unknown, observer: (event: unknown) => void) => {
      observers.add(observer)
      return () => observers.delete(observer)
    },
  },
} as never
let container: HTMLElement, root: Root
function Capture({ id }: { id: keyof typeof notes }) {
  const [editor] = useLexicalComposerContext()
  const controls = useEditorControlsState()
  const state = useSyncExternalStore(controls.subscribe, controls.getSnapshot)
  useEffect(() => {
    editors.set(id, editor)
  }, [editor, id])
  return <output data-comments-state="">{String(state.commentsOpen)}</output>
}
function Note({ id }: { id: keyof typeof notes }) {
  return (
    <section data-editor-test={id}>
      <EditorControlsProvider identity={identities[id]}>
        <LexicalComposer
          initialConfig={{
            namespace: id,
            nodes: [HeadingNode, ListNode, ListItemNode],
            editorState: () => $getRoot().append($createHeadingNode('h1').append($createTextNode(`${id} heading`))),
            onError: (error) => {
              throw error
            },
          }}
        >
          <ViewRibbon noteUuid={id} />
          <div className="relative flex" data-outline-host="">
            <NavigationSidebar noteUuid={id} />
            <EditorNavigationAids noteUuid={id}>
              <RichTextPlugin
                contentEditable={<ContentEditable />}
                placeholder={null}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </EditorNavigationAids>
          </div>
          <NoteViewPreferencesBridge noteUuid={id} />
          <Capture id={id} />
        </LexicalComposer>
      </EditorControlsProvider>
    </section>
  )
}
const render = async () =>
  act(async () =>
    root.render(
      <ApplicationProvider application={app}>
        <Note id="first" />
        <Note id="second" />
      </ApplicationProvider>,
    ),
  )
const section = (id = 'first') => container.querySelector<HTMLElement>(`[data-editor-test="${id}"]`)!
const checkbox = (label: string) =>
  [...section().querySelectorAll('label')]
    .find((element) => element.textContent === label)!
    .querySelector<HTMLInputElement>('input')!
beforeEach(() => {
  patch.mockImplementation(savePatch)
  notes.first.view = {}
  notes.second.view = {}
  observers.clear()
  editors.clear()
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  HTMLElement.prototype.setPointerCapture = jest.fn()
  HTMLElement.prototype.releasePointerCapture = jest.fn()
  HTMLElement.prototype.hasPointerCapture = jest.fn(() => true)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
})
function pointer(target: Element, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: 7 })
  target.dispatchEvent(event)
}

it('opens the outline for its own note and saves that choice without altering note text', async () => {
  await render()
  const before = editors.get('first')!.getEditorState().toJSON()
  await act(async () => section().querySelector<HTMLButtonElement>('[aria-label="Show table of contents"]')!.click())
  expect(section().querySelector('[data-navigation-sidebar]')?.getAttribute('data-outline-placement')).toBe('right')
  expect(section('second').querySelector('[data-navigation-sidebar]')).toBeNull()
  expect(patch).toHaveBeenCalledWith(notes.first, expect.objectContaining({ tocVisible: true }))
  expect(editors.get('first')!.getEditorState().toJSON()).toEqual(before)
  await act(async () => root.render(null))
  await render()
  expect(section().querySelector('[data-navigation-sidebar]')).not.toBeNull()
})

it('shares contents and comments controls between the View ribbon and the note panels', async () => {
  await render()
  await act(async () => checkbox('Show comments panel').click())
  expect(section().querySelector('[data-comments-state]')?.textContent).toBe('true')
  expect(notes.first.view.commentsVisible).toBe(true)
  await act(async () => checkbox('Show table of contents').click())
  const select = section().querySelector<HTMLSelectElement>('[aria-label="Contents panel placement"]')!
  await act(async () => {
    select.value = 'floating'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(section().querySelector('[data-navigation-sidebar]')?.getAttribute('data-outline-placement')).toBe('floating')
  expect(notes.first.view.tocMode).toBe('floating')
})

it('drags and resizes the floating outline, saving once per completed gesture', async () => {
  notes.first.view = { ...DEFAULT_EDITOR_VIEW, tocVisible: true, tocMode: 'floating' }
  await render()
  const aside = section().querySelector<HTMLElement>('[data-navigation-sidebar]')!
  Object.defineProperties(aside.parentElement, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
  const handle = aside.firstElementChild!
  patch.mockClear()
  await act(async () => {
    pointer(handle, 'pointerdown', 50, 50)
    pointer(handle, 'pointermove', 100, 80)
  })
  expect(aside.style.left).toBe('74px')
  expect(aside.style.top).toBe('54px')
  expect(patch).not.toHaveBeenCalled()
  await act(async () => pointer(handle, 'pointerup', 100, 80))
  expect(patch).toHaveBeenCalledTimes(1)
  const resize = aside.querySelector('[aria-label="Resize table of contents"]')!
  await act(async () => {
    pointer(resize, 'pointerdown', 100, 100)
    pointer(resize, 'pointermove', 150, 140)
    pointer(resize, 'pointerup', 150, 140)
  })
  expect(aside.style.width).toBe('310px')
  expect(aside.style.height).toBe('400px')
  expect(notes.first.view.tocWidth).toBe(310)
  expect(notes.first.view.tocHeight).toBe(400)
})

it('leaves read-mode view controls usable without writing to the note', async () => {
  await render()
  await act(async () => editors.get('first')!.setEditable(false))
  patch.mockClear()
  await act(async () => checkbox('Show table of contents').click())
  expect(section().querySelector('[data-navigation-sidebar]')).not.toBeNull()
  expect(patch).not.toHaveBeenCalled()
  expect(notes.first.view).toEqual({})
})

it('sizes checklist boxes to each item font and saves configurable fixed sizing without editing the body', async () => {
  await render()
  const editor = editors.get('first')!
  await act(async () =>
    editor.update(
      () => {
        $getRoot().append(
          $createListNode('check').append(
            $createListItemNode(false).append($createTextNode('Small task').setStyle('font-size: 12px')),
            $createListItemNode(true).append($createTextNode('Large task').setStyle('font-size: 32px')),
          ),
        )
      },
      { discrete: true },
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const rows = [...editor.getRootElement()!.querySelectorAll<HTMLElement>('li')]
  expect(rows.map((row) => row.style.getPropertyValue('--checkbox-size'))).toEqual(['12px', '32px'])
  await act(async () =>
    editor.update(
      () =>
        $getRoot()
          .getLastChild<ListNode>()!
          .getLastChild<ListItemNode>()!
          .getFirstChild<TextNode>()!
          .setStyle('font-size: 48px'),
      { discrete: true },
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(rows.map((row) => row.style.getPropertyValue('--checkbox-size'))).toEqual(['12px', '48px'])
  const before = editor.getEditorState().toJSON()
  const mode = [...section().querySelectorAll('label')]
    .find((label) => label.textContent?.includes('Checklist box sizing'))!
    .querySelector('select')!
  await act(async () => {
    mode.value = 'fixed'
    mode.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(rows.map((row) => row.style.getPropertyValue('--checkbox-size'))).toEqual(['18px', '18px'])
  expect(notes.first.view.checklistBoxSizing).toBe('fixed')
  expect(editor.getEditorState().toJSON()).toEqual(before)
})

it('enables line numbers and a drawn, navigable minimap from the real View controls for this note', async () => {
  const context = { scale: jest.fn(), fillRect: jest.fn(), fillStyle: '' }
  const canvasContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(0, 12, 100, 20)],
  })
  try {
    await render()
    const editor = editors.get('first')!
    const editorRoot = editor.getRootElement()!
    const originalState = editor.getEditorState().toJSON()
    const shell = section().querySelector<HTMLElement>('.srn-editor-navigation-aids')!
    Object.defineProperties(editorRoot, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1000 },
      clientWidth: { value: 400 },
    })
    Object.defineProperty(shell, 'clientHeight', { value: 600 })
    editorRoot.style.overflowY = 'auto'
    editorRoot.scrollTo = jest.fn()
    await act(async () => checkbox('Line numbers').click())
    expect(section().querySelector('.srn-line-gutter')).not.toBeNull()
    await act(async () => checkbox('Document minimap').click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180))
    })
    expect(section().querySelector('.srn-line-gutter')?.textContent).toBe('1')
    expect(context.fillRect).toHaveBeenCalled()
    const minimap = section().querySelector<HTMLButtonElement>('.srn-note-minimap')!
    expect(minimap).not.toBeNull()
    await act(async () => minimap.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(editorRoot.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'auto' })
    expect(section('second').querySelector('.srn-note-minimap')).toBeNull()
    expect(loadNoteLayout('first')).toMatchObject({ lineNumbers: true, minimap: true })
    expect(editor.getEditorState().toJSON()).toEqual(originalState)
    await act(async () => checkbox('Line numbers').click())
    expect(section().querySelector('.srn-line-gutter')).toBeNull()
    expect(section().querySelector('.srn-note-minimap')).not.toBeNull()
  } finally {
    await act(async () => root.render(null))
    canvasContext.mockRestore()
    if (originalRects) {
      Object.defineProperty(Range.prototype, 'getClientRects', originalRects)
    } else {
      Reflect.deleteProperty(Range.prototype, 'getClientRects')
    }
  }
})
