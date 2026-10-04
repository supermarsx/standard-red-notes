/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): `focusTitle()` must focus THIS note's title input.
 *
 * The tiled editor mounts one NoteView per open note — NoteGroupView keeps every open
 * tab mounted and merely hides the inactive ones — and all of them render
 * `ElementIds.NoteTitleEditor`. While `focusTitle()` was
 * `document.getElementById(ElementIds.NoteTitleEditor)?.focus()` it therefore focused
 * whichever note was FIRST in the document: opening a new note (template notes autofocus
 * their title) or revealing a protected one yanked focus into another tab's title field,
 * and `onTitleFocus` selects that field's text, so the next keystroke replaced a title
 * belonging to a note the user was not looking at.
 *
 * This is why the test mounts TWO views. A single-mount test cannot see the bug at all:
 * with one input in the document `getElementById` and a ref are indistinguishable, which
 * is how the bug survived two previous fixes.
 */

// @ts-expect-error CSS is not defined in jsdom env; NoteView's import graph reads it.
global.CSS = {}

import { ReactElement, ReactNode, act, isValidElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { ElementIds } from '@/Constants/ElementIDs'
import { NoteViewController } from './Controller/NoteViewController'
import NoteView from './NoteView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const buildNote = (uuid: string, title: string) =>
  ({
    uuid,
    title,
    text: '',
    protected: false,
    locked: false,
    pinned: false,
    noteType: NoteType.Super,
    editorIdentifier: undefined,
    userModifiedDate: new Date(),
    getAppDomainValue: jest.fn(),
  }) as unknown as SNNote

/** One open note: its own controller, its own NoteView, exactly as a tile has. */
const createViewFor = (uuid: string, title: string) => {
  const controller = {
    item: buildNote(uuid, title),
    dealloced: false,
    isTemplateNote: false,
    syncStatus: undefined,
  } as unknown as NoteViewController

  const application = {
    notesController: { showProtectedWarning: false },
    linkingController: {},
    filesController: {},
    paneController: {},
    vaults: { getItemVault: jest.fn().mockReturnValue(undefined) },
    vaultUsers: { isCurrentUserReadonlyVaultMember: jest.fn().mockReturnValue(false) },
    items: { isTemplateItem: jest.fn().mockReturnValue(false) },
    isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
    // The constructor reads the note-covers preference (t111); without this the whole
    // instance fails to build and every test here dies for an unrelated reason.
    getPreference: jest.fn((_key: unknown, defaultValue: unknown) => defaultValue),
  } as unknown as WebApplication

  return new NoteView({ controller, application })
}

/** Every element in a rendered tree, depth-first. */
const walk = (node: ReactNode): ReactElement[] => {
  if (Array.isArray(node)) {
    return node.flatMap(walk)
  }
  if (!isValidElement(node)) {
    return []
  }
  const element = node as ReactElement<{ children?: ReactNode }>
  return [element, ...walk(element.props?.children)]
}

const titleInputElementOf = (view: NoteView): ReactElement => {
  const found = walk(view.render() as ReactNode).find(
    (element) => element.type === 'input' && (element.props as { id?: string }).id === ElementIds.NoteTitleEditor,
  )
  if (!found) {
    throw new Error('NoteView rendered no title input')
  }
  return found
}

const titleRefOf = (view: NoteView) =>
  (view as unknown as { titleInputRef: { current: HTMLInputElement | null } }).titleInputRef

const roots: Root[] = []

/**
 * Attach one view's OWN title input to the document in tile order, the way React does
 * when the whole NoteView mounts: the element — and therefore the ref it carries — comes
 * straight out of that instance's `render()`, and React itself populates the ref.
 *
 * Only this subtree is mounted rather than the entire NoteView, whose mount drags in the
 * whole editor stack, every preference read and the Super editor. The wiring under test
 * is identical either way, and `populates each view's own ref from its own render` below
 * asserts that React really did attach the ref instead of the test faking it.
 */
const mountTitleInput = (view: NoteView): HTMLInputElement => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  act(() => {
    root.render(titleInputElementOf(view))
  })

  const input = container.querySelector('input')
  if (!input) {
    throw new Error('The title input did not reach the document')
  }
  return input
}

beforeEach(() => {
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia
})

afterEach(() => {
  act(() => {
    while (roots.length > 0) {
      roots.pop()?.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('focusTitle with more than one note open', () => {
  it('focuses the second tile’s own title input, leaving the first tile untouched', () => {
    const first = createViewFor('note-1', 'First note')
    const second = createViewFor('note-2', 'Second note')
    const firstInput = mountTitleInput(first)
    const secondInput = mountTitleInput(second)

    // The premise of the whole test, asserted so it cannot quietly stop holding: both
    // tiles render the SAME id, and an id lookup answers the first tile.
    expect(firstInput.id).toBe(ElementIds.NoteTitleEditor)
    expect(secondInput.id).toBe(ElementIds.NoteTitleEditor)
    expect(document.getElementById(ElementIds.NoteTitleEditor)).toBe(firstInput)
    expect(firstInput.dataset.srnNoteUuid).toBe('note-1')
    expect(secondInput.dataset.srnNoteUuid).toBe('note-2')

    act(() => second.focusTitle())

    expect(document.activeElement).toBe(secondInput)
    expect(document.activeElement).not.toBe(firstInput)
  })

  it('focuses the first tile’s input when it is the first tile asking', () => {
    // The mirror image: the fix must address the asking instance, not simply "the last
    // mounted input" (which would pass the test above for the wrong reason).
    const first = createViewFor('note-1', 'First note')
    const second = createViewFor('note-2', 'Second note')
    const firstInput = mountTitleInput(first)
    const secondInput = mountTitleInput(second)

    act(() => second.focusTitle())
    expect(document.activeElement).toBe(secondInput)

    act(() => first.focusTitle())

    expect(document.activeElement).toBe(firstInput)
  })

  it('populates each view’s own ref from its own render', () => {
    const first = createViewFor('note-1', 'First note')
    const second = createViewFor('note-2', 'Second note')
    const firstInput = mountTitleInput(first)
    const secondInput = mountTitleInput(second)

    expect(titleRefOf(first).current).toBe(firstInput)
    expect(titleRefOf(second).current).toBe(secondInput)
    expect(titleRefOf(first).current).not.toBe(titleRefOf(second).current)
  })

  it('still focuses the only input when a single note is open', () => {
    const only = createViewFor('note-1', 'Only note')
    const input = mountTitleInput(only)

    act(() => only.focusTitle())

    expect(document.activeElement).toBe(input)
  })

  /**
   * The print path cannot use a ref — it reads the DOM from outside the component — so it
   * narrows to one tile by the markers rendered here (see Print/PrintNote.ts, which scopes
   * a named note's title AND body to one `data-srn-note-view` subtree). Without this
   * assertion, deleting either marker would leave PrintNote.spec's hand-built fixtures
   * green while the real app silently went back to reading whichever tile is first.
   */
  it('marks the tile and the title input with the note they belong to', () => {
    const view = createViewFor('note-1', 'First note')
    const tree = view.render() as ReactElement<Record<string, unknown>>

    expect(tree.props['data-srn-note-view']).toBe('note-1')
    expect((titleInputElementOf(view).props as Record<string, unknown>)['data-srn-note-uuid']).toBe('note-1')
  })

  it('does nothing when this view has no mounted input', () => {
    // A protected overlay renders instead of the title bar, and `focusTitle` is reached
    // from a setTimeout: it must not throw, and must not grab a sibling tile's field.
    const mounted = createViewFor('note-1', 'First note')
    const unmounted = createViewFor('note-2', 'Second note')
    const mountedInput = mountTitleInput(mounted)

    expect(() => unmounted.focusTitle()).not.toThrow()

    expect(document.activeElement).not.toBe(mountedInput)
  })
})
