/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): "go to bookmark" must scroll, and place the caret in, the
 * bookmarked note.
 *
 * `#super-editor-content`, `#note-text-editor` and the inline anchor elements are each
 * rendered once per open note — from the second open tab onward the tiled editor mounts
 * one NoteView per note and merely hides the inactive ones. While the jump resolved them
 * with `document.getElementById` it scrolled the FIRST open note, and for a plaintext note
 * it also stole focus into that note and moved its caret.
 *
 * Every test mounts TWO tiles. With one tile in the document "the first match" and "the
 * bookmarked note's editor" are the same element, so a single-mount test cannot see this.
 * Elements are identified by reference (`toBe`): two freshly built editors of the same
 * kind are structurally identical and deep equality cannot tell them apart.
 */

import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '@/Components/SuperEditor/Constants'
import { bookmarkAnchorDomId } from '@/Components/SuperEditor/Lexical/Nodes/BookmarkAnchorNode'
import { PRINT_NOTE_VIEW_ATTRIBUTE } from '@/Components/NoteView/Print/PrintNote'
import { capturePlainAnchor } from './bookmarks'
import { jumpToBookmarkSpot, MAX_JUMP_ATTEMPTS } from './jumpToBookmarkSpot'

type Tile = {
  root: HTMLElement
  content: HTMLElement
  textarea: HTMLTextAreaElement
  anchor: HTMLElement
  scrolledIntoView: HTMLElement[]
}

const ANCHOR_ID = 'bm-1'

/** One mounted NoteView: the tile wrapper plus the editor ids every tile renders. */
const mountTile = (uuid: string, text: string): Tile => {
  const root = document.createElement('div')
  root.setAttribute(PRINT_NOTE_VIEW_ATTRIBUTE, uuid)
  root.innerHTML = `
    <div id="${SuperEditorContentId}">
      <span id="${bookmarkAnchorDomId(ANCHOR_ID)}"></span>
    </div>
    <textarea id="${ElementIds.NoteTextEditor}"></textarea>
  `
  document.body.appendChild(root)

  const content = root.querySelector<HTMLElement>(`#${SuperEditorContentId}`) as HTMLElement
  const textarea = root.querySelector<HTMLTextAreaElement>(`#${ElementIds.NoteTextEditor}`) as HTMLTextAreaElement
  const anchor = content.querySelector('span') as HTMLElement
  textarea.value = text
  // jsdom parks the caret at the end of an assigned value; start both tiles at 0 so
  // "this tile's caret was moved" is observable rather than coincidental.
  textarea.setSelectionRange(0, 0)

  const scrolledIntoView: HTMLElement[] = []
  anchor.scrollIntoView = () => {
    scrolledIntoView.push(anchor)
  }

  return { root, content, textarea, anchor, scrolledIntoView }
}

/** Runs the retry loop synchronously, so a test never waits on animation frames. */
const runFrames = (limit = MAX_JUMP_ATTEMPTS + 2) => {
  let queued: (() => void)[] = []
  const schedule = (callback: () => void) => {
    queued.push(callback)
  }
  const drain = () => {
    for (let index = 0; index < limit && queued.length > 0; index++) {
      const batch = queued
      queued = []
      batch.forEach((callback) => callback())
    }
  }
  return { schedule, drain, pending: () => queued.length }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('jumping to a bookmark with more than one note open', () => {
  it('scrolls the bookmarked note’s own anchor, not the first tile’s', () => {
    const first = mountTile('note-1', 'first note body')
    const second = mountTile('note-2', 'second note body')
    // The premise: an id lookup cannot tell the tiles apart and answers the first.
    expect(document.getElementById(bookmarkAnchorDomId(ANCHOR_ID))).toBe(first.anchor)
    const frames = runFrames()

    jumpToBookmarkSpot('note-2', { kind: 'super', bookmarkId: ANCHOR_ID, scrollTop: 222 }, '', frames.schedule)
    frames.drain()

    expect(second.scrolledIntoView).toEqual([second.anchor])
    expect(first.scrolledIntoView).toEqual([])
  })

  it('puts the caret in the bookmarked note’s own textarea, not the first tile’s', () => {
    const secondBody = 'second note body with a marked spot'
    const markOffset = secondBody.indexOf('marked')
    const first = mountTile('note-1', 'FIRST NOTE BODY')
    const second = mountTile('note-2', secondBody)
    expect(document.getElementById(ElementIds.NoteTextEditor)).toBe(first.textarea)
    const frames = runFrames()

    // A real captured anchor: the snippet is the text around the mark, so relocating it
    // against the right note's body returns the mark, and against any other note's body
    // it cannot.
    jumpToBookmarkSpot('note-2', capturePlainAnchor(secondBody, markOffset), '', frames.schedule)
    frames.drain()

    expect(document.activeElement).toBe(second.textarea)
    expect(second.textarea.selectionStart).toBe(markOffset)
    // The first tile is untouched: no focus stolen, caret left at the start.
    expect(first.textarea.selectionStart).toBe(0)
  })

  it('falls back to the bookmarked note’s own coarse scroll position', () => {
    const first = mountTile('note-1', '')
    const second = mountTile('note-2', '')
    // The anchor node is gone from both documents (the notes were edited since).
    first.anchor.remove()
    second.anchor.remove()
    const frames = runFrames()

    jumpToBookmarkSpot('note-2', { kind: 'super', bookmarkId: ANCHOR_ID, scrollTop: 222 }, '', frames.schedule)
    frames.drain()

    expect(second.content.scrollTop).toBe(222)
    expect(first.content.scrollTop).toBe(0)
  })

  it('waits for its own note’s tile instead of using a tile that is already mounted', () => {
    const first = mountTile('note-1', 'first note body')
    const frames = runFrames()

    jumpToBookmarkSpot('note-2', { kind: 'super', bookmarkId: ANCHOR_ID, scrollTop: 222 }, '', frames.schedule)
    // One frame with only the other note mounted: nothing may happen to it.
    frames.drain()

    expect(first.scrolledIntoView).toEqual([])
    expect(first.content.scrollTop).toBe(0)
    expect(document.activeElement).not.toBe(first.textarea)
  })

  it('jumps as soon as its own tile appears a few frames later', () => {
    mountTile('note-1', 'first note body')
    const frames = runFrames(3)

    jumpToBookmarkSpot('note-2', { kind: 'super', bookmarkId: ANCHOR_ID }, '', frames.schedule)
    frames.drain()
    expect(frames.pending()).toBe(1)

    const second = mountTile('note-2', '')
    frames.drain()

    expect(second.scrolledIntoView).toEqual([second.anchor])
  })

  it('gives up quietly when its note never mounts', () => {
    mountTile('note-1', 'first note body')
    const frames = runFrames(MAX_JUMP_ATTEMPTS + 5)

    jumpToBookmarkSpot('note-missing', { kind: 'super', bookmarkId: ANCHOR_ID }, '', frames.schedule)
    frames.drain()

    expect(frames.pending()).toBe(0)
  })
})
