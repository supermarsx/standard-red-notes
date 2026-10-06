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
import { NOTE_COVERS_ENABLED_PREF_KEY } from '../../HeroHeader/noteCoversPreference'
import { HERO_AFFORDANCE_HEIGHT } from './heroBannerScroll'

const noteUuid = 'note-uuid'

const COVER_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

const buildNote = (heroHeader?: unknown) =>
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
    getAppDomainValue: jest.fn(() => heroHeader),
  }) as unknown as SNNote

let controller: NoteViewController
let application: WebApplication
/** The value the fake preference service reports for the covers feature gate. */
let coversEnabledPref: boolean
/** Note writes, so a toggle can be proven to perform none of them. */
let changeItem: jest.Mock

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

/** The props NoteView hands the banner, or undefined when it renders no banner. */
const bannerProps = (view: NoteView): Record<string, unknown> | undefined =>
  walk(view.render() as ReactNode).find((element) => element.type === HeroHeaderBanner)?.props as
    Record<string, unknown> | undefined

/** Whether the measured-height wrapper that holds the banner is in the tree. */
const rendersBannerSlot = (view: NoteView) =>
  walk(view.render() as ReactNode).some(
    (element) => (element.props as Record<string, unknown> | undefined)?.['data-note-hero-banner'] === '',
  )

const A_STORED_COVER = { imageDataUrl: COVER_DATA_URL, height: 480, focalY: 0.5 }

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

/**
 * Rebuild `controller`/`application` around a note that carries `heroHeader` in
 * its appData. Call before `createView()`, because the constructor snapshots
 * both the stored cover and the feature gate.
 */
const seedNote = (heroHeader?: unknown) => {
  controller = {
    item: buildNote(heroHeader),
    dealloced: false,
    isTemplateNote: false,
    syncStatus: undefined,
  } as unknown as NoteViewController
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia

  // Standard Red Notes (t111): the covers feature gate. ON by default here so
  // the pre-existing scroll tests keep describing a real banner; the gated tests
  // below flip it explicitly.
  coversEnabledPref = true
  changeItem = jest.fn()

  seedNote()

  application = {
    notesController: {
      showProtectedWarning: false,
      getSpellcheckStateForNote: jest.fn().mockReturnValue(true),
      getEditorWidthForNote: jest.fn().mockReturnValue('full'),
    },
    linkingController: {},
    filesController: {},
    paneController: {},
    vaults: { getItemVault: jest.fn().mockReturnValue(undefined) },
    vaultUsers: { isCurrentUserReadonlyVaultMember: jest.fn().mockReturnValue(false) },
    items: { isTemplateItem: jest.fn().mockReturnValue(false) },
    isAuthorizedToRenderItem: jest.fn().mockReturnValue(true),
    mutator: { changeItem, changeItems: changeItem },
    preferences: { getLocalValue: jest.fn((_key: unknown, defaultValue: unknown) => defaultValue) },
    // Answers every OTHER preference with the caller's own default, so only the
    // covers gate is under test here. Keying on the pinned literal also means a
    // change to that key string makes these tests fail rather than silently
    // reading `undefined` forever.
    getPreference: jest.fn((key: unknown, defaultValue: unknown) => {
      return key === NOTE_COVERS_ENABLED_PREF_KEY ? coversEnabledPref : defaultValue
    }),
    setPreference: jest.fn().mockResolvedValue(undefined),
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

/**
 * Standard Red Notes (t111 §C): covers are an OPT-IN feature, default off, and
 * turning the setting off HIDES a cover that already exists. These tests pin the
 * slot NoteView gives the banner in each of the four states, and the one piece
 * of arithmetic that would otherwise ship as scroll jitter.
 */
describe('the covers feature gate', () => {
  describe('the four states of the banner slot', () => {
    it('covers ON + no cover: the slot exists, so the note can be given one', () => {
      coversEnabledPref = true
      seedNote(undefined)

      const view = createView()

      expect(view.state.coversEnabled).toBe(true)
      expect(rendersBannerSlot(view)).toBe(true)
      expect(bannerProps(view)).toMatchObject({ coversEnabled: true, hero: null })
    })

    it('covers ON + a cover: the slot exists and carries the stored cover', () => {
      coversEnabledPref = true
      seedNote(A_STORED_COVER)

      const view = createView()

      expect(rendersBannerSlot(view)).toBe(true)
      expect(bannerProps(view)).toMatchObject({
        coversEnabled: true,
        hero: { imageDataUrl: COVER_DATA_URL, height: 480 },
      })
    })

    it('covers OFF + no cover: nothing at all — no slot, no empty box, no trace', () => {
      coversEnabledPref = false
      seedNote(undefined)

      const view = createView()

      expect(view.state.coversEnabled).toBe(false)
      // Not merely a banner that renders null inside a wrapper: a user who has
      // never enabled covers must not get a stray element in their editor.
      expect(rendersBannerSlot(view)).toBe(false)
      expect(rendersBanner(view)).toBe(false)
    })

    it('covers OFF + a cover: the slot STILL exists, to disclose the hidden cover', () => {
      coversEnabledPref = false
      seedNote(A_STORED_COVER)

      const view = createView()

      // The cover is preserved and handed to the banner, which turns it into the
      // hidden-cover notice (pinned in HeroHeaderBanner.gated.spec.tsx). Dropping
      // the slot here would make the cover vanish with nothing said about it.
      expect(rendersBannerSlot(view)).toBe(true)
      expect(bannerProps(view)).toMatchObject({
        coversEnabled: false,
        hero: { imageDataUrl: COVER_DATA_URL, height: 480 },
      })
    })

    it('covers OFF + a cover on a LOCKED note: the slot still exists', () => {
      // The pre-gate rule was "cover OR editable"; a locked note with a cover
      // kept its banner. It must keep its notice for the same reason.
      coversEnabledPref = false
      seedNote(A_STORED_COVER)
      const view = createView()
      ;(view as unknown as { state: Record<string, unknown> }).state.noteLocked = true

      expect(rendersBannerSlot(view)).toBe(true)
      expect(bannerProps(view)).toMatchObject({ coversEnabled: false, disabled: true })
    })

    it('covers ON + no cover on a LOCKED note: still no slot (unchanged behaviour)', () => {
      coversEnabledPref = true
      seedNote(undefined)
      const view = createView()
      ;(view as unknown as { state: Record<string, unknown> }).state.noteLocked = true

      expect(rendersBannerSlot(view)).toBe(false)
    })
  })

  describe('heroBannerHeight() must not claim the hidden banner s height', () => {
    /**
     * jsdom has no layout engine, so `offsetHeight` is 0 and the fallback branch
     * is the one under test — which is also the branch that runs on the real
     * first frame after mount. The assertion is therefore pure ARITHMETIC over
     * injected numbers, never a measured box:
     *
     *   remainingScrollRange = scrollHeight - clientHeight = 100
     *
     *   bannerHeight 480 (the stored cover) -> 100 <= 480 -> stay visible
     *   bannerHeight  26 (HERO_AFFORDANCE_HEIGHT) -> 100 > 26 -> hide
     *
     * So the same scroll event resolves differently depending on which height
     * `heroBannerHeight()` claims, and the two tests below pin both answers.
     */
    const aNoteWithJustOverOneScreenToGive = { scrollTop: 5, scrollHeight: 700, clientHeight: 600 }

    it('claims the stored height while covers are ON (a real 480px banner is there)', () => {
      expect(A_STORED_COVER.height).toBeGreaterThan(aNoteWithJustOverOneScreenToGive.scrollHeight - 600)
      coversEnabledPref = true
      seedNote(A_STORED_COVER)
      const view = viewWithLiveState()

      view.onNoteContentScroll(scrollEventFrom(SuperEditorContentId, aNoteWithJustOverOneScreenToGive))

      // The anti-flicker guard legitimately holds: hiding a 480px banner here
      // would leave the note unscrollable and blink it straight back.
      expect(view.state.heroBannerVisible).toBe(true)
    })

    it('claims only the notice s height while covers are OFF, however tall the stored cover is', () => {
      expect(HERO_AFFORDANCE_HEIGHT).toBeLessThan(aNoteWithJustOverOneScreenToGive.scrollHeight - 600)
      coversEnabledPref = false
      seedNote(A_STORED_COVER)
      const view = viewWithLiveState()

      view.onNoteContentScroll(scrollEventFrom(SuperEditorContentId, aNoteWithJustOverOneScreenToGive))

      // What is on screen is the ~26px notice, not the 480px banner the stored
      // value describes. Claiming 480 would arm the guard with the wrong
      // magnitude and pin the notice open on a note that should scroll it away.
      expect(view.state.heroBannerVisible).toBe(false)
    })
  })

  describe('toggling the setting mutates no note', () => {
    it('performs zero note writes across off -> on -> off', async () => {
      coversEnabledPref = false
      seedNote(A_STORED_COVER)
      const view = viewWithLiveState()
      expect(view.state.coversEnabled).toBe(false)

      coversEnabledPref = true
      await view.reloadPreferences()
      expect(view.state.coversEnabled).toBe(true)

      coversEnabledPref = false
      await view.reloadPreferences()
      expect(view.state.coversEnabled).toBe(false)

      // The anti-requirement: no migration, no cleanup pass, no lazy rewrite.
      // The stored cover must round-trip byte-identically, so re-enabling
      // restores it exactly.
      expect(changeItem).not.toHaveBeenCalled()
      expect(view.state.heroHeader).toMatchObject({ imageDataUrl: COVER_DATA_URL, height: 480 })
    })

    it('[Show covers] writes the preference and nothing else', () => {
      coversEnabledPref = false
      seedNote(A_STORED_COVER)
      const view = createView()

      view.enableNoteCovers()

      expect(application.setPreference).toHaveBeenCalledWith(NOTE_COVERS_ENABLED_PREF_KEY, true)
      expect(changeItem).not.toHaveBeenCalled()
    })
  })
})
