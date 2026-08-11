/** @jest-environment jsdom */

import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '@/Components/SuperEditor/Constants'
import { PRINT_BODY_ID, PRINT_LAYOUT_STYLE_ID } from '@/Components/SuperEditor/Layout/applyPrintLayout'
import { DEFAULT_NOTE_LAYOUT, saveNoteLayout } from '@/Components/SuperEditor/Layout/layoutSettings'
import {
  createPrintSnapshot,
  PRINTING_BODY_CLASS,
  PRINT_ROOT_ID,
  PRINT_TITLE_ID,
  printActiveNote,
  removePrintSnapshot,
} from './PrintNote'

describe('isolated note printing', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.querySelector(`#${PRINT_LAYOUT_STYLE_ID}`)?.remove()
    localStorage.clear()
  })

  afterEach(() => {
    removePrintSnapshot()
    jest.restoreAllMocks()
  })

  it('builds exactly an unsaved title and sanitized Super-note body, with no UI nodes or forbidden copy', () => {
    document.body.innerHTML = `
      <div id="application-chrome">
        <button>Global toolbar</button>
        <input id="${ElementIds.NoteTitleEditor}" value="Saved title" />
        <div id="${SuperEditorContentId}" contenteditable="true">
          <p>Current unsaved body</p>
          <button>Add row</button>
          <div role="toolbar">Formatting toolbar</div>
          <div role="menu">Widget menu</div>
          <div class="ContentEditable__placeholder">Type / for commands</div>
          <div class="attachment-toolbar">Save attachment</div>
          <input type="search" placeholder="Search rows" value="private filter" />
          <input aria-label="Board title" value="Roadmap" />
          <label>Done <input type="checkbox" checked /></label>
          <table><tbody><tr><td>Preserved table cell</td></tr></tbody></table>
          <img src="data:image/png;base64,AA==" alt="Preserved diagram" />
          <script>window.bad = true</script>
        </div>
        <div>Presence: Alice</div>
      </div>
    `
    ;(document.getElementById(ElementIds.NoteTitleEditor) as HTMLInputElement).value = 'Current unsaved title'
    ;(document.querySelector('[aria-label="Board title"]') as HTMLInputElement).value = 'Current roadmap title'

    const snapshot = createPrintSnapshot({ fallbackTitle: 'Stale title' })

    expect(snapshot.id).toBe(PRINT_ROOT_ID)
    expect(Array.from(snapshot.children).map((child) => child.id)).toEqual([PRINT_TITLE_ID, PRINT_BODY_ID])
    expect(snapshot.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Current unsaved title')
    expect(snapshot.textContent).toContain('Current unsaved body')
    expect(snapshot.textContent).toContain('Current roadmap title')
    expect(snapshot.textContent).toContain('Preserved table cell')
    expect(snapshot.querySelector('table')).not.toBeNull()
    expect(snapshot.querySelector('img[alt="Preserved diagram"]')).not.toBeNull()
    expect(snapshot.querySelector('.srn-print-checkbox')?.textContent).toBe('☒')

    expect(
      snapshot.querySelector(
        'button, input, textarea, select, script, iframe, object, video, audio, [role="button"], [role="menu"], [role="toolbar"]',
      ),
    ).toBeNull()
    for (const forbiddenText of [
      'Global toolbar',
      'Add row',
      'Formatting toolbar',
      'Widget menu',
      'Type / for commands',
      'Save attachment',
      'private filter',
      'Presence: Alice',
    ]) {
      expect(snapshot.textContent).not.toContain(forbiddenText)
    }
  })

  it('prints the live plain-text value rather than a stale value attribute', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" value="Title" />
      <textarea id="${ElementIds.NoteTextEditor}">stale body</textarea>
    `
    ;(document.getElementById(ElementIds.NoteTextEditor) as HTMLTextAreaElement).value = 'latest unsaved body'

    const snapshot = createPrintSnapshot()

    expect(snapshot.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('latest unsaved body')
    expect(snapshot.querySelector('textarea')).toBeNull()
  })

  it('attaches only the snapshot for printing, applies layout to it, and cleans up on afterprint', () => {
    document.body.innerHTML = `
      <main id="live-app">
        <input id="${ElementIds.NoteTitleEditor}" value="Title" />
        <div id="${SuperEditorContentId}"><p>Body</p></div>
      </main>
    `
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined)
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    saveNoteLayout('note-1', { ...DEFAULT_NOTE_LAYOUT, columns: 2 })

    printActiveNote({ noteUuid: 'note-1' })

    expect(print).toHaveBeenCalledTimes(1)
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(true)
    expect(document.body.children).toHaveLength(2)
    expect(document.body.lastElementChild?.id).toBe(PRINT_ROOT_ID)
    expect(document.getElementById(PRINT_LAYOUT_STYLE_ID)?.textContent).toContain(`#${PRINT_BODY_ID}`)

    window.dispatchEvent(new Event('afterprint'))

    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(document.getElementById(PRINT_LAYOUT_STYLE_ID)).toBeNull()
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(false)
    expect(document.getElementById('live-app')).not.toBeNull()
  })
})
