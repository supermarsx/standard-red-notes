/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): dictation and transcript insertion must WRITE into the note
 * the user is working in.
 *
 * From the second open tab onward the tiled editor mounts one NoteView per open note and
 * merely hides the inactive ones, so `#note-text-editor` and `#super-editor-content` are
 * each rendered once per open note. While the no-focus fallback used
 * `document.getElementById`, speech recognised with nothing focused was typed into the
 * FIRST open note's editor — a write into a document the user was not editing, in the
 * same family as the "bookmark this spot" bug and just as destructive.
 *
 * Every test mounts TWO tiles. With a single tile in the document the tile-scoped lookup
 * and the document-wide one return the same element, so a single-mount test is
 * structurally incapable of seeing this bug. Assertions identify elements by reference
 * (`toBe`) or by their own observable text: two freshly built editors of the same kind
 * are structurally identical, so deep equality cannot tell "the right one" from "one
 * shaped like it".
 */

import { ElementIds } from '@/Constants/ElementIDs'
import { PRINT_NOTE_VIEW_ATTRIBUTE } from '@/Components/NoteView/Print/PrintNote'
import { insertTextIntoActiveEditor } from './insertEditorText'

type Tile = {
  root: HTMLElement
  textarea: HTMLTextAreaElement
  superContent: HTMLElement
  superChild: HTMLElement
  toolbarButton: HTMLButtonElement
}

/**
 * One mounted NoteView: the tile wrapper NoteView renders (`data-srn-note-view`), both
 * duplicated editor ids, and a toolbar button standing in for DictationButton.
 */
const mountTile = (uuid: string, { contentEditable = true }: { contentEditable?: boolean } = {}): Tile => {
  const root = document.createElement('div')
  root.setAttribute(PRINT_NOTE_VIEW_ATTRIBUTE, uuid)
  root.innerHTML = `
    <button type="button" aria-label="Start dictation"></button>
    <div id="${ElementIds.SuperEditorContent}"><span>body of ${uuid}</span></div>
    <textarea id="${ElementIds.NoteTextEditor}"></textarea>
  `
  document.body.appendChild(root)

  const textarea = root.querySelector<HTMLTextAreaElement>(`#${ElementIds.NoteTextEditor}`) as HTMLTextAreaElement
  const superContent = root.querySelector<HTMLElement>(`#${ElementIds.SuperEditorContent}`) as HTMLElement
  const superChild = superContent.querySelector('span') as HTMLElement
  const toolbarButton = root.querySelector('button') as HTMLButtonElement

  // jsdom does not drive contenteditable, so the editable-ness Lexical gives the content
  // wrapper has to be declared. The inner span deliberately does NOT claim it, which is
  // what makes the "focus is inside the Super editor but not on its root" path reachable.
  Object.defineProperty(superContent, 'isContentEditable', { value: contentEditable, configurable: true })
  // Focusable in jsdom only with a tabindex.
  superContent.tabIndex = -1
  superChild.tabIndex = -1

  return { root, textarea, superContent, superChild, toolbarButton }
}

let execCommandSucceeds = true
const execCommandCalls: string[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  execCommandSucceeds = true
  execCommandCalls.length = 0
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string, _ui?: boolean, value?: string) => {
      execCommandCalls.push(`${command}:${value}`)
      return execCommandSucceeds
    },
  })
})

describe('inserting dictated text with more than one note open', () => {
  it('splices into the named note’s textarea, never the first tile’s', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    // The premise: an id lookup cannot tell the tiles apart and answers the first.
    expect(document.getElementById(ElementIds.NoteTextEditor)).toBe(first.textarea)
    execCommandSucceeds = false

    expect(insertTextIntoActiveEditor('spoken words', { noteUuid: 'note-2' })).toBe(true)

    expect(second.textarea.value).toBe('spoken words')
    expect(first.textarea.value).toBe('')
    expect(document.activeElement).toBe(second.textarea)
  })

  it('resolves the tile from the asking button’s own element when no uuid is known', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    expect(document.getElementById(ElementIds.NoteTextEditor)).toBe(first.textarea)
    execCommandSucceeds = false

    expect(insertTextIntoActiveEditor('spoken words', { within: second.toolbarButton })).toBe(true)

    expect(second.textarea.value).toBe('spoken words')
    expect(first.textarea.value).toBe('')
  })

  it('focuses the named note’s Super editor rather than the first tile’s', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    // Super-only notes: no plain textarea anywhere, so the Super branch is the one taken.
    first.textarea.remove()
    second.textarea.remove()
    expect(document.getElementById(ElementIds.SuperEditorContent)).toBe(first.superContent)

    expect(insertTextIntoActiveEditor('spoken words', { noteUuid: 'note-2' })).toBe(true)

    expect(document.activeElement).toBe(second.superContent)
    expect(execCommandCalls).toEqual(['insertText:spoken words'])
  })

  it('keeps the focused Super editor when focus is on a node inside it, not on its root', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    second.superChild.focus()
    expect(document.activeElement).toBe(second.superChild)

    expect(insertTextIntoActiveEditor('spoken words', {})).toBe(true)

    // Focus was already in the right place: nothing is stolen, and in particular the
    // first tile's textarea is neither focused nor written to.
    expect(document.activeElement).toBe(second.superChild)
    expect(first.textarea.value).toBe('')
    expect(second.textarea.value).toBe('')
  })

  it('falls back to the pre-tiling lookup when the named note is not mounted', () => {
    const first = mountTile('note-1')
    execCommandSucceeds = false

    expect(insertTextIntoActiveEditor('spoken words', { noteUuid: 'note-missing' })).toBe(true)

    // Documented fallback: an unresolvable scope is the pre-tiling, single-note
    // behaviour. It must never silently prefer some OTHER mounted note over it.
    expect(first.textarea.value).toBe('spoken words')
  })

  it('inserts nothing for empty text', () => {
    mountTile('note-1')
    expect(insertTextIntoActiveEditor('', { noteUuid: 'note-1' })).toBe(false)
    expect(execCommandCalls).toEqual([])
  })
})
