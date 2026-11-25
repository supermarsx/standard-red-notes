/** @jest-environment jsdom */
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  createEditor,
  LexicalEditor,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { registerNoteSelection, selectNoteContents } from './NoteSelectionPlugin'

const disposals: (() => void)[] = []
function mountNote(editable = false, text = 'First line') {
  const surface = document.createElement('section')
  surface.id = 'super-editor'
  const root = document.createElement('div')
  root.className = 'ContentEditable__root'
  root.contentEditable = String(editable)
  root.setAttribute('role', 'textbox')
  surface.append(root)
  document.body.append(surface)
  const editor = createEditor({
    namespace: 'note-selection',
    editable,
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode(text)),
        $createParagraphNode().append($createTextNode('Last line')),
      )
    },
    { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
  )
  const stop = registerNoteSelection(editor)
  disposals.push(() => {
    stop()
    editor.setRootElement(null)
    surface.remove()
  })
  return { editor, root, surface, stop }
}
function pressSelectAll(target: Element, modifiers: KeyboardEventInit = { ctrlKey: true }) {
  const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, ...modifiers })
  target.dispatchEvent(event)
  return event
}
function selectedText(editor: LexicalEditor) {
  return editor.getEditorState().read(() => $getSelection()?.getTextContent())
}
afterEach(() => {
  disposals
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.getSelection()?.removeAllRanges()
})

it.each([false, true])(
  'Ctrl+A selects the whole note in editable=%s without selecting the page or changing content',
  (editable) => {
    const note = mountNote(editable)
    const sidebar = document.createElement('aside')
    sidebar.textContent = 'Other page contents'
    document.body.prepend(sidebar)
    disposals.push(() => sidebar.remove())
    const before = note.editor.getEditorState().toJSON()
    expect(pressSelectAll(note.root).defaultPrevented).toBe(true)
    expect(document.getSelection()?.toString()).toBe('First lineLast line')
    expect(selectedText(note.editor)).toBe('First line\nLast line')
    expect(note.root.contains(document.getSelection()?.anchorNode ?? null)).toBe(true)
    expect(note.root.contains(document.getSelection()?.focusNode ?? null)).toBe(true)
    expect(note.editor.getEditorState().toJSON()).toEqual(before)
  },
)

it('supports Cmd+A and only selects the note owning the focused toolbar', () => {
  const first = mountNote(false, 'First note')
  const second = mountNote(false, 'Second note')
  const button = document.createElement('button')
  second.surface.append(button)
  expect(pressSelectAll(button, { metaKey: true }).defaultPrevented).toBe(true)
  expect(selectedText(second.editor)).toBe('Second note\nLast line')
  expect(selectedText(first.editor)).toBeUndefined()
  expect(second.root.contains(document.getSelection()?.anchorNode ?? null)).toBe(true)
})

it('handles a read-mode browser selection even when the keyboard event targets the body', () => {
  const { root, editor } = mountNote()
  const range = document.createRange()
  range.selectNodeContents(root.firstChild!)
  document.getSelection()!.addRange(range)
  expect(pressSelectAll(document.body).defaultPrevented).toBe(true)
  expect(selectedText(editor)).toBe('First line\nLast line')
})

it('leaves native select-all behavior intact for inputs, embedded editors and other panes', () => {
  const { surface, root } = mountNote()
  for (const tag of ['input', 'textarea', 'select']) {
    const field = document.createElement(tag)
    surface.append(field)
    expect(pressSelectAll(field).defaultPrevented).toBe(false)
  }
  for (const contentEditable of ['true', 'plaintext-only']) {
    const embedded = document.createElement('div')
    embedded.setAttribute('contenteditable', contentEditable)
    root.append(embedded)
    expect(pressSelectAll(embedded).defaultPrevented).toBe(false)
  }
  expect(pressSelectAll(document.body).defaultPrevented).toBe(false)
  expect(pressSelectAll(root, { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false)
  expect(pressSelectAll(root, { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
})

it('synchronizes a mouse selection in read mode so toolbar Copy can use it', async () => {
  const { root, editor } = mountNote()
  const text = root.querySelector('[data-lexical-text]')!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  document.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await Promise.resolve()
  expect(selectedText(editor)).toBe('First')
  expect(document.getSelection()?.toString()).toBe('First')
})

it('uses the same selection for the toolbar action and releases listeners when unmounted', () => {
  const { root, editor, stop } = mountNote()
  expect(root.tabIndex).toBe(0)
  expect(selectNoteContents(editor, true)).toBe(true)
  expect(selectedText(editor)).toBe('First line\nLast line')
  stop()
  expect(root.hasAttribute('tabindex')).toBe(false)
  expect(pressSelectAll(root).defaultPrevented).toBe(false)
})

it('keeps select-all inside an empty note', () => {
  const { root, editor } = mountNote()
  editor.update(
    () => {
      $getRoot().clear().append($createParagraphNode())
    },
    { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
  )
  expect(pressSelectAll(root).defaultPrevented).toBe(true)
  expect(selectedText(editor)).toBe('')
  expect(root.contains(document.getSelection()?.anchorNode ?? null)).toBe(true)
  expect(root.contains(document.getSelection()?.focusNode ?? null)).toBe(true)
})
