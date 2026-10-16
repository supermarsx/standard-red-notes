/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorNavigationAids } from './EditorNavigationAids'
import { ScreenNavigationControls } from '../../Layout/ScreenNavigationControls'
import {
  DEFAULT_NOTE_LAYOUT,
  normalizeNoteLayout,
  saveNoteLayout,
  NOTE_LAYOUT_SETTINGS_CHANGED_EVENT,
} from '../../Layout/layoutSettings'

const unregister = jest.fn()
const registerRootListener = jest.fn(() => unregister)
const editor = { registerRootListener }
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [editor] }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  registerRootListener.mockReturnValue(unregister)
})

it('does no geometry work while disabled and releases root listeners when switched off', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <EditorNavigationAids noteUuid="note">
          <div data-editor-fixture="true">Content</div>
        </EditorNavigationAids>,
      ),
    )
    const originalContent = host.querySelector('[data-editor-fixture]')
    expect(registerRootListener).not.toHaveBeenCalled()
    expect(host.querySelector('.srn-line-gutter')).toBeNull()
    act(() => {
      saveNoteLayout('note', normalizeNoteLayout({ lineNumbers: true }))
      window.dispatchEvent(new Event(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT))
    })
    expect(registerRootListener).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.srn-line-gutter')).not.toBeNull()
    expect(host.querySelector('[data-editor-fixture]')).toBe(originalContent)
    act(() => {
      saveNoteLayout('note', DEFAULT_NOTE_LAYOUT)
      window.dispatchEvent(new Event(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT))
    })
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.srn-line-gutter')).toBeNull()
    expect(host.querySelector('[data-editor-fixture]')).toBe(originalContent)
  } finally {
    act(() => root.unmount())
  }
})

it('renders labelled off-by-default Layout controls and sends independent preference patches', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  const change = jest.fn()
  try {
    act(() => root.render(<ScreenNavigationControls layout={DEFAULT_NOTE_LAYOUT} onChange={change} />))
    const controls = Array.from(host.querySelectorAll('input'))
    expect(controls.map((control) => [control.closest('label')?.textContent, control.checked])).toEqual([
      ['Line numbers', false],
      ['Minimap', false],
    ])
    act(() => controls[0].click())
    expect(change).toHaveBeenLastCalledWith({ lineNumbers: true })
    act(() => controls[1].click())
    expect(change).toHaveBeenLastCalledWith({ minimap: true })
  } finally {
    act(() => root.unmount())
  }
})
