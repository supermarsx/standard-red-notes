/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): "Bookmark this spot" must read and write THIS note's editor.
 *
 * This is the same duplicated-id root cause as NoteView#focusTitle, but it is a WRITE, so
 * it is worse than a misplaced cursor. The tiled editor mounts one NoteView per open note
 * and each renders `#super-editor`, `#super-editor-content` and `#note-text-editor`, so
 * while `bookmarkCurrentSpot` used `document.getElementById` it:
 *
 *  - dispatched the inline-anchor insertion event at the FIRST tile's Super editor, which
 *    inserts an anchor node into a document belonging to a different note, and
 *  - built the stored anchor (scrollTop, caret offset, snippet) out of that other note.
 *
 * Reachable from Ctrl/Cmd+M, the note-options menu and the Super "/" menu. Every test
 * mounts two tiles, because with one tile in the document the tile-scoped query and the
 * global one are indistinguishable.
 */

// @ts-expect-error CSS is not defined in jsdom env; NoteView's import graph reads it.
global.CSS = {}

import { NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '../SuperEditor/Constants'
import { BOOKMARK_INSERT_DOM_EVENT } from '../SuperEditor/Plugins/BookmarkPlugin/BookmarkPlugin'
import { Bookmark } from '../../Bookmarks/bookmarks'
import { NoteViewController } from './Controller/NoteViewController'
import NoteView from './NoteView'

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Success: 'success', Error: 'error' },
}))

type Tile = {
  view: NoteView
  root: HTMLElement
  superEditor: HTMLElement
  content: HTMLElement
  textarea: HTMLTextAreaElement
  savedBookmarks: Bookmark[]
  insertedAnchorIds: string[]
}

const buildNote = (uuid: string, noteType: NoteType, text: string) =>
  ({
    uuid,
    title: `Note ${uuid}`,
    text,
    protected: false,
    locked: false,
    pinned: false,
    noteType,
    editorIdentifier: undefined,
    userModifiedDate: new Date(),
    getAppDomainValue: jest.fn(),
  }) as unknown as SNNote

/**
 * One open note's tile: the duplicated editor ids inside a container, plus a NoteView
 * whose root ref points at that container — which is what the component itself holds
 * after it renders (`ref={this.noteViewElementRef}` on its root div).
 */
const buildTile = ({
  uuid,
  noteType,
  text = '',
  scrollTop,
  caret = 0,
}: {
  uuid: string
  noteType: NoteType
  text?: string
  scrollTop: number
  caret?: number
}): Tile => {
  const root = document.createElement('div')
  root.setAttribute('data-srn-note-view', uuid)
  root.innerHTML = `
    <div id="${ElementIds.SuperEditor}">
      <div id="${SuperEditorContentId}"></div>
    </div>
    <textarea id="${ElementIds.NoteTextEditor}"></textarea>
  `
  document.body.appendChild(root)

  const superEditor = root.querySelector<HTMLElement>(`#${ElementIds.SuperEditor}`) as HTMLElement
  const content = root.querySelector<HTMLElement>(`#${SuperEditorContentId}`) as HTMLElement
  const textarea = root.querySelector<HTMLTextAreaElement>(`#${ElementIds.NoteTextEditor}`) as HTMLTextAreaElement

  // jsdom has no layout, so scroll offsets have to be declared to differ per tile.
  Object.defineProperty(content, 'scrollTop', { value: scrollTop, configurable: true })
  Object.defineProperty(textarea, 'scrollTop', { value: scrollTop, configurable: true })
  textarea.value = text
  textarea.setSelectionRange(caret, caret)

  const insertedAnchorIds: string[] = []
  superEditor.addEventListener(BOOKMARK_INSERT_DOM_EVENT, (event) => {
    insertedAnchorIds.push((event as CustomEvent<{ bookmarkId: string }>).detail.bookmarkId)
  })

  const savedBookmarks: Bookmark[] = []
  const controller = {
    item: buildNote(uuid, noteType, text),
    dealloced: false,
    isTemplateNote: false,
    syncStatus: undefined,
  } as unknown as NoteViewController

  const application = {
    notesController: {
      showProtectedWarning: false,
      upsertNoteBookmark: jest.fn(async (_note: SNNote, bookmark: Bookmark) => {
        savedBookmarks.push(bookmark)
      }),
    },
    linkingController: {},
    filesController: {},
    paneController: {},
    vaults: { getItemVault: jest.fn().mockReturnValue(undefined) },
    vaultUsers: { isCurrentUserReadonlyVaultMember: jest.fn().mockReturnValue(false) },
    items: { isTemplateItem: jest.fn().mockReturnValue(false) },
    isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
    getPreference: jest.fn((_key: unknown, defaultValue: unknown) => defaultValue),
  } as unknown as WebApplication

  const view = new NoteView({ controller, application })
  // What React assigns on mount; set here because these tests deliberately do not mount
  // the entire editor stack.
  ;(view as unknown as { noteViewElementRef: { current: HTMLElement | null } }).noteViewElementRef = { current: root }

  return { view, root, superEditor, content, textarea, savedBookmarks, insertedAnchorIds }
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia
})

describe('bookmarking a spot with more than one note open', () => {
  it('inserts the Super anchor into its own note, never the first tile’s document', async () => {
    const first = buildTile({ uuid: 'note-1', noteType: NoteType.Super, scrollTop: 111 })
    const second = buildTile({ uuid: 'note-2', noteType: NoteType.Super, scrollTop: 222 })
    // The premise: an id lookup cannot tell the tiles apart and answers the first.
    expect(document.getElementById(ElementIds.SuperEditor)).toBe(first.superEditor)

    await second.view.bookmarkCurrentSpot()

    expect(second.insertedAnchorIds).toHaveLength(1)
    expect(first.insertedAnchorIds).toHaveLength(0)
    // And the stored anchor was measured in the same tile it was inserted into.
    expect(second.savedBookmarks).toHaveLength(1)
    expect(second.savedBookmarks[0].anchor).toMatchObject({
      kind: 'super',
      bookmarkId: second.insertedAnchorIds[0],
      scrollTop: 222,
    })
  })

  it('captures a plain note’s caret and snippet from its own textarea', async () => {
    const first = buildTile({
      uuid: 'note-1',
      noteType: NoteType.Plain,
      text: 'FIRST NOTE BODY',
      scrollTop: 111,
      caret: 3,
    })
    const second = buildTile({
      uuid: 'note-2',
      noteType: NoteType.Plain,
      text: 'second note body',
      scrollTop: 222,
      caret: 7,
    })
    expect(document.getElementById(ElementIds.NoteTextEditor)).toBe(first.textarea)

    await second.view.bookmarkCurrentSpot()

    expect(second.savedBookmarks).toHaveLength(1)
    expect(second.savedBookmarks[0].anchor).toMatchObject({ kind: 'plain', offset: 7, scrollTop: 222 })
    expect(first.savedBookmarks).toHaveLength(0)
  })

  it('still bookmarks the first tile’s own spot when the first tile asks', async () => {
    const first = buildTile({ uuid: 'note-1', noteType: NoteType.Super, scrollTop: 111 })
    const second = buildTile({ uuid: 'note-2', noteType: NoteType.Super, scrollTop: 222 })

    await first.view.bookmarkCurrentSpot()

    expect(first.insertedAnchorIds).toHaveLength(1)
    expect(second.insertedAnchorIds).toHaveLength(0)
    expect(first.savedBookmarks[0].anchor).toMatchObject({ scrollTop: 111 })
  })
})
