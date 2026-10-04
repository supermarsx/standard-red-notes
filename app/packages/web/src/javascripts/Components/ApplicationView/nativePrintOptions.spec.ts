/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): native Print (browser menu / Ctrl+P) must print the note
 * the user is looking at.
 *
 * From the second open tab onward the tiled editor mounts one NoteView per open note and
 * hides the inactive ones with a class, so every tile renders `#note-title-editor` with
 * its own `data-srn-note-uuid`. The provider used to read the note's identity out of the
 * first such element in document order, which is the FIRST open note — so Ctrl+P printed
 * a different note than the one on screen whenever the active tab was not the first.
 *
 * Every test here mounts TWO tiles: with one tile in the document "the first match" and
 * "the active note" are the same element, and the bug is invisible.
 */

import { ElementIds } from '@/Constants/ElementIDs'
import { WebApplication } from '@/Application/WebApplication'
import { PRINT_NOTE_UUID_ATTRIBUTE, PRINT_NOTE_VIEW_ATTRIBUTE } from '../NoteView/Print/PrintNote'
import { registerPrintableView, unregisterPrintableView } from '../NoteView/Print/PrintableViewRegistry'
import { resolveNativePrintOptions } from './nativePrintOptions'

type Tile = { root: HTMLElement; titleInput: HTMLInputElement }

/** One mounted NoteView: the tile wrapper plus the title input every tile renders. */
const mountTile = (uuid: string): Tile => {
  const root = document.createElement('div')
  root.setAttribute(PRINT_NOTE_VIEW_ATTRIBUTE, uuid)
  const titleInput = document.createElement('input')
  titleInput.id = ElementIds.NoteTitleEditor
  titleInput.setAttribute(PRINT_NOTE_UUID_ATTRIBUTE, uuid)
  titleInput.value = `Title of ${uuid}`
  root.appendChild(titleInput)
  document.body.appendChild(root)
  return { root, titleInput }
}

const buildApplication = (activeUuid: string | undefined): WebApplication =>
  ({
    itemListController: { activeControllerItem: activeUuid ? { uuid: activeUuid } : undefined },
    // Nothing is persisted in these tests, so the resolver falls through to naming the
    // note it decided on — which is exactly the decision under test.
    items: { findItem: jest.fn().mockReturnValue(undefined) },
    componentManager: { editorForNote: jest.fn().mockReturnValue(undefined) },
  }) as unknown as WebApplication

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('native print target with more than one note open', () => {
  it('names the active controller’s note, not the first tile in the document', () => {
    const first = mountTile('note-1')
    mountTile('note-2')
    // The premise: neither a document-wide id lookup nor the attribute selector can
    // tell the tiles apart — both answer the FIRST one.
    expect(document.getElementById(ElementIds.NoteTitleEditor)).toBe(first.titleInput)
    expect(document.querySelector(`[${PRINT_NOTE_UUID_ATTRIBUTE}]`)).toBe(first.titleInput)

    expect(resolveNativePrintOptions(buildApplication('note-2'))).toEqual({ noteUuid: 'note-2' })
  })

  it('still names the first tile when the first tile is the active one', () => {
    mountTile('note-1')
    mountTile('note-2')

    expect(resolveNativePrintOptions(buildApplication('note-1'))).toEqual({ noteUuid: 'note-1' })
  })

  it('asks the DOM only whether an editor is on screen, never which note it holds', () => {
    const view = document.createElement('div')
    document.body.appendChild(view)
    registerPrintableView(view, () => ({ title: 'Todos', body: document.createElement('div') }))

    try {
      // A view tab has taken the content area over: no tile is mounted, so the note the
      // controller still holds is not on screen and must not be printed.
      expect(resolveNativePrintOptions(buildApplication('note-2'))).toEqual({})

      // The same printable view while the editor IS on screen: the editor wins, and the
      // note is still the active one rather than the first tile's.
      const first = mountTile('note-1')
      mountTile('note-2')
      expect(document.querySelector(`[${PRINT_NOTE_UUID_ATTRIBUTE}]`)).toBe(first.titleInput)
      expect(resolveNativePrintOptions(buildApplication('note-2'))).toEqual({ noteUuid: 'note-2' })
    } finally {
      unregisterPrintableView(view)
    }
  })

  it('names no note when there is no active controller item', () => {
    mountTile('note-1')

    expect(resolveNativePrintOptions(buildApplication(undefined))).toEqual({ noteUuid: undefined })
  })
})
