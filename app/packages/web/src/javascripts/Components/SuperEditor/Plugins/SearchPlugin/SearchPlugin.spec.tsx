/** @jest-environment jsdom */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { $createParagraphNode, $createTextNode, $getRoot, LexicalEditor } from 'lexical'
import ApplicationProvider from '@/Components/ApplicationProvider'
import { SearchPlugin } from './SearchPlugin'
import { OPEN_SUPER_SEARCH_COMMAND, OPEN_SUPER_SEARCH_REPLACE_COMMAND } from './searchCommands'

jest.mock('@/Hooks/useLifecycleAnimation', () => {
  const setElement = () => undefined
  return { useLifecycleAnimation: ({ open }: { open: boolean }) => [open, setElement] }
})
jest.mock('@/Components/KeyboardServiceProvider', () => ({
  useKeyboardService: () => ({ keyboardShortcutForCommand: () => undefined }),
}))
jest.mock('./SearchHighlightRenderer', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    canUseCSSHiglights: true,
    SearchHighlightRenderer: React.forwardRef(function Highlights(_props, ref) {
      React.useImperativeHandle(ref, () => ({
        clearHighlights: () => undefined,
        highlightMultipleRanges: () => undefined,
        setActiveHighlight: () => undefined,
      }))
      return React.createElement('div', { 'data-search-highlights': true })
    }),
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let editor: LexicalEditor
let container: HTMLElement
let root: Root
function CaptureEditor() {
  const [current] = useLexicalComposerContext()
  useEffect(() => {
    editor = current
  }, [current])
  return null
}
beforeEach(async () => {
  container = document.createElement('div')
  container.style.transform = 'translateZ(0)'
  container.style.overflow = 'hidden'
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <ApplicationProvider application={{ keyboardService: { addCommandHandlers: () => () => undefined } } as never}>
        <LexicalComposer
          initialConfig={{
            namespace: 'find-panel-layer',
            onError: (error) => {
              throw error
            },
            editorState: () => $getRoot().append($createParagraphNode().append($createTextNode('A searchable note'))),
          }}
        >
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <CaptureEditor />
          <SearchPlugin />
        </LexicalComposer>
      </ApplicationProvider>,
    ),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('opens Find above the editor context and keeps its highlight layer beside the note', async () => {
  await act(async () => {
    editor.dispatchCommand(OPEN_SUPER_SEARCH_COMMAND, undefined)
  })
  const panel = document.querySelector<HTMLElement>('[data-super-search-panel]')!
  expect(panel.parentElement).toBe(document.body)
  expect(container.contains(panel)).toBe(false)
  expect(panel.getAttribute('aria-label')).toBe('Find in note')
  expect(document.querySelector('[data-search-highlights]')?.parentElement).toBe(editor.getRootElement()?.parentElement)
  await act(async () => panel.querySelector<HTMLButtonElement>('[title^="Close"]')!.click())
  expect(document.querySelector('[data-super-search-panel]')).toBeNull()
})

it('opens Find in read mode without offering replacement controls', async () => {
  const before = editor.getEditorState().toJSON()
  await act(async () => {
    editor.setEditable(false)
    editor.dispatchCommand(OPEN_SUPER_SEARCH_COMMAND, undefined)
  })
  const panel = document.querySelector<HTMLElement>('[data-super-search-panel]')!
  expect(panel.getAttribute('aria-label')).toBe('Find in note')
  expect(panel.querySelector('input')).not.toBeNull()
  expect(panel.textContent).not.toContain('Replace')
  expect(editor.getEditorState().toJSON()).toEqual(before)
})

it('retires replacement controls immediately when an open panel enters read mode', async () => {
  await act(async () => {
    editor.dispatchCommand(OPEN_SUPER_SEARCH_REPLACE_COMMAND, undefined)
  })
  expect(document.querySelector('[placeholder="Replace"]')).not.toBeNull()
  await act(async () => {
    editor.setEditable(false)
  })
  expect(document.querySelector('[placeholder="Replace"]')).toBeNull()
  expect(document.querySelector('[data-super-search-panel]')?.getAttribute('aria-label')).toBe('Find in note')
  await act(async () => {
    editor.dispatchCommand(OPEN_SUPER_SEARCH_REPLACE_COMMAND, undefined)
  })
  expect(document.querySelector('[placeholder="Replace"]')).toBeNull()
})

it('keeps the minimized Find bubble in the overlay layer and restores Find and Replace', async () => {
  await act(async () => {
    editor.dispatchCommand(OPEN_SUPER_SEARCH_REPLACE_COMMAND, undefined)
  })
  const panel = document.querySelector<HTMLElement>('[data-super-search-panel]')!
  expect(panel.getAttribute('aria-label')).toBe('Find and replace in note')
  await act(async () => panel.querySelector<HTMLButtonElement>('[title^="Minimize"]')!.click())
  const bubble = document.querySelector<HTMLElement>('[data-super-search-panel]')!
  expect(bubble.parentElement).toBe(document.body)
  await act(async () => bubble.querySelector('button')!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
  expect(document.querySelector('[data-super-search-panel]')?.getAttribute('aria-label')).toBe(
    'Find and replace in note',
  )
})

it('moves into and out of the native fullscreen overlay root while Find is open', async () => {
  await act(async () => {
    editor.dispatchCommand(OPEN_SUPER_SEARCH_COMMAND, undefined)
  })
  const descriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
  try {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: container })
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(document.querySelector('[data-super-search-panel]')?.parentElement).toBe(container)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
    await act(async () => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(document.querySelector('[data-super-search-panel]')?.parentElement).toBe(document.body)
  } finally {
    if (descriptor) {
      Object.defineProperty(document, 'fullscreenElement', descriptor)
    } else {
      Reflect.deleteProperty(document, 'fullscreenElement')
    }
  }
})
