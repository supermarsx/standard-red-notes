/**
 * @jest-environment jsdom
 *
 * The cover banner is the one piece of the editor chrome that is allowed to come
 * and go (task t101): it may occupy the writing area only while the reader is at
 * the absolute top of the document. Two things have to hold and neither is
 * visible to `tsc`:
 *
 *  - the scroll handler must react to the NOTE's scroller and to nothing else
 *    (a wide table or a popover list scrolling inside the note says nothing
 *    about where the reader is), and
 *  - the render must actually drop the banner from the tree when it is hidden,
 *    rather than merely styling it — otherwise the space is never returned and
 *    the whole change is a no-op that still type-checks and still passes every
 *    behavioural test of the handler.
 *
 * The boundary rule itself is covered in ./heroBannerScroll.spec.ts.
 */

// @ts-expect-error CSS is not defined in jsdom env; NoteView's import graph reads it.
global.CSS = {}

import { ReactElement, ReactNode, isValidElement } from 'react'
import { NoteType, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from './Controller/NoteViewController'
import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '../SuperEditor/Constants'
import NoteView from './NoteView'
import HeroHeaderBanner from '../../HeroHeader/HeroHeaderBanner'

const noteUuid = 'note-uuid'

const buildNote = () =>
  ({
    uuid: noteUuid,
    title: 'A note',
    text: '',
    protected: false,
    locked: false,
    pinned: false,
    noteType: NoteType.Super,
    editorIdentifier: undefined,
    userModifiedDate: new Date(),
    getAppDomainValue: jest.fn(),
  }) as unknown as SNNote

let controller: NoteViewController
let application: WebApplication

const createView = () => new NoteView({ controller, application })

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

const rendersBanner = (view: NoteView) =>
  walk(view.render() as ReactNode).some((element) => element.type === HeroHeaderBanner)

/** A NoteView whose setState writes through, so render() sees the new state. */
const viewWithLiveState = () => {
  const view = createView()
  view.setState = jest.fn((partial: unknown) => {
    ;(view as unknown as { state: Record<string, unknown> }).state = {
      ...(view as unknown as { state: Record<string, unknown> }).state,
      ...(partial as Record<string, unknown>),
    }
  }) as unknown as typeof view.setState
  return view
}

const scrollEventFrom = (id: string, metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
  const element = document.createElement('div')
  element.id = id
  Object.defineProperty(element, 'scrollTop', { value: metrics.scrollTop, configurable: true })
  Object.defineProperty(element, 'scrollHeight', { value: metrics.scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: metrics.clientHeight, configurable: true })
  document.body.appendChild(element)
  return { target: element } as unknown as Event
}

const aLongNote = { scrollTop: 400, scrollHeight: 8000, clientHeight: 600 }
const backAtTheTop = { scrollTop: 0, scrollHeight: 8000, clientHeight: 600 }

beforeEach(() => {
  document.body.innerHTML = ''
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia

  controller = {
    item: buildNote(),
    dealloced: false,
    isTemplateNote: false,
    syncStatus: undefined,
  } as unknown as NoteViewController

  application = {
    notesController: { showProtectedWarning: false },
    linkingController: {},
    filesController: {},
    paneController: {},
    vaults: { getItemVault: jest.fn().mockReturnValue(undefined) },
    vaultUsers: { isCurrentUserReadonlyVaultMember: jest.fn().mockReturnValue(false) },
    items: { isTemplateItem: jest.fn().mockReturnValue(false) },
    isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
  } as unknown as WebApplication
})

describe('the cover banner is rendered only at the absolute top', () => {
  it('renders the banner on a freshly opened note', () => {
    expect(rendersBanner(createView())).toBe(true)
  })

  it('drops the banner out of the tree once the note is scrolled', () => {
    const view = viewWithLiveState()
    expect(rendersBanner(view)).toBe(true)

    view.onNoteContentScroll(scrollEventFrom(SuperEditorContentId, aLongNote))

    expect(view.state.heroBannerVisible).toBe(false)
    // Unmounted, not merely hidden — otherwise the space is never given back.
    expect(rendersBanner(view)).toBe(false)
  })

  it('brings the banner back when the reader returns to the top', () => {
    const view = viewWithLiveState()
    view.onNoteContentScroll(scrollEventFrom(SuperEditorContentId, aLongNote))
    expect(rendersBanner(view)).toBe(false)

    view.onNoteContentScroll(scrollEventFrom(SuperEditorContentId, backAtTheTop))

    expect(view.state.heroBannerVisible).toBe(true)
    expect(rendersBanner(view)).toBe(true)
  })

  it('reacts to the plain editor and the editor content scrollers too', () => {
    for (const id of [ElementIds.EditorContent, ElementIds.NoteTextEditor]) {
      const view = viewWithLiveState()
      view.onNoteContentScroll(scrollEventFrom(id, aLongNote))
      expect(view.state.heroBannerVisible).toBe(false)
    }
  })

  it('ignores something else inside the note scrolling', () => {
    // A wide table, a code block, an autocomplete list: their scrollTop says
    // nothing about where the reader is in the document.
    const view = viewWithLiveState()

    view.onNoteContentScroll(scrollEventFrom('some-inner-table', aLongNote))

    expect(view.setState).not.toHaveBeenCalled()
    expect(rendersBanner(view)).toBe(true)
  })

  it('ignores a scroll event with no element target', () => {
    const view = viewWithLiveState()

    view.onNoteContentScroll({ target: null } as unknown as Event)

    expect(view.setState).not.toHaveBeenCalled()
  })

  it('does not re-render when the answer has not changed', () => {
    const view = viewWithLiveState()

    view.onNoteContentScroll(scrollEventFrom(SuperEditorContentId, backAtTheTop))

    expect(view.setState).not.toHaveBeenCalled()
  })

  it('leaves the banner alone on a note with no room to scroll without it', () => {
    // The flicker boundary, end to end: hiding the banner here would make the
    // note unscrollable, snap scrollTop back to 0 and bring the banner straight
    // back on the next wheel tick.
    const view = viewWithLiveState()

    view.onNoteContentScroll(
      scrollEventFrom(SuperEditorContentId, { scrollTop: 3, scrollHeight: 620, clientHeight: 600 }),
    )

    expect(view.state.heroBannerVisible).toBe(true)
    expect(rendersBanner(view)).toBe(true)
  })
})
