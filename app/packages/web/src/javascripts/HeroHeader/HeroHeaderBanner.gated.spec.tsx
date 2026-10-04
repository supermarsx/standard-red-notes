/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t111 §C): the cover-banner FEATURE GATE, rendered.
 *
 * Covers are opt-in and default OFF, and the user chose the invasive reading:
 * turning the setting off HIDES a cover that already exists. That makes
 * something the user MADE stop appearing, so the off+cover state is not allowed
 * to be a blank space — it must be a discoverable notice with both routes out.
 * `tsc` cannot see any of that, and neither can a props-only assertion; these
 * tests render the component and read the DOM.
 *
 * `coversEnabled` is an explicit PROP, which is the whole reason this file needs
 * no application, no preference service and no pref plumbing.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { SNNote } from '@standardnotes/snjs'
import { NotesController } from '@/Controllers/NotesController/NotesController'
import { FilesController } from '@/Controllers/FilesController'
import HeroHeaderBanner from './HeroHeaderBanner'
import { HeroHeader } from './heroHeader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const COVER_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

const HIDDEN_NOTICE_COPY = 'This note has a cover image, hidden because covers are off.'

const aCover: HeroHeader = { imageDataUrl: COVER_DATA_URL, height: 320, focalY: 0.5 }

const note = { uuid: 'note-uuid', locked: false } as unknown as SNNote

let container: HTMLElement
let root: Root
let notesController: { removeNoteHeroHeader: jest.Mock; setNoteHeroImage: jest.Mock }
let onShowCovers: jest.Mock

beforeEach(() => {
  // The covers-ON states mount the cover selector's ModalOverlay, which reads
  // `matchMedia` through useMediaQuery; jsdom does not implement it.
  window.matchMedia = jest.fn().mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }) as unknown as typeof window.matchMedia

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  notesController = {
    removeNoteHeroHeader: jest.fn().mockResolvedValue(undefined),
    setNoteHeroImage: jest.fn().mockResolvedValue(undefined),
  }
  onShowCovers = jest.fn()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

type RenderOptions = {
  hero: HeroHeader | null
  coversEnabled: boolean
  disabled?: boolean
}

const render = ({ hero, coversEnabled, disabled }: RenderOptions): HTMLElement => {
  act(() => {
    root.render(
      createElement(HeroHeaderBanner, {
        note,
        hero,
        coversEnabled,
        disabled,
        onShowCovers,
        notesController: notesController as unknown as NotesController,
        filesController: { allFiles: [] } as unknown as FilesController,
      }),
    )
  })
  return container
}

/** The button whose visible text is exactly `label`, or undefined. */
const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((element) => element.textContent?.trim() === label)

const notice = () => container.querySelector('[data-note-hero-hidden-notice]')

describe('covers ON (the pre-existing behaviour, unchanged)', () => {
  it('renders the cover image when the note has one', () => {
    render({ hero: aCover, coversEnabled: true })

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(COVER_DATA_URL)
    expect(notice()).toBeNull()
    expect(container.textContent).not.toContain(HIDDEN_NOTICE_COPY)
  })

  it('renders the "Add cover" affordance when the note has none', () => {
    render({ hero: null, coversEnabled: true })

    expect(button('Add cover')).toBeDefined()
    expect(notice()).toBeNull()
  })

  it('renders nothing when the note has no cover and is not editable', () => {
    render({ hero: null, coversEnabled: true, disabled: true })

    expect(container.innerHTML).toBe('')
  })
})

describe('covers OFF + no cover', () => {
  it('renders nothing at all — the feature is invisible to someone who never enabled it', () => {
    render({ hero: null, coversEnabled: false })

    expect(container.innerHTML).toBe('')
    expect(button('Add cover')).toBeUndefined()
  })
})

describe('covers OFF + a stored cover: the hidden-cover notice', () => {
  it('does NOT render the cover image', () => {
    render({ hero: aCover, coversEnabled: false })

    expect(container.querySelector('img')).toBeNull()
    // Belt and braces: the data URL must not reach the DOM in any attribute.
    expect(container.innerHTML).not.toContain(COVER_DATA_URL)
  })

  it('says exactly what is hidden and why', () => {
    render({ hero: aCover, coversEnabled: false })

    expect(notice()).not.toBeNull()
    expect(container.textContent).toContain(HIDDEN_NOTICE_COPY)
  })

  it('offers both routes out: [Show covers] and [Remove cover]', () => {
    render({ hero: aCover, coversEnabled: false })

    expect(button('Show covers')).toBeDefined()
    expect(button('Remove cover')).toBeDefined()
  })

  it('[Show covers] asks the host to write the preference', () => {
    render({ hero: aCover, coversEnabled: false })

    act(() => {
      button('Show covers')?.click()
    })

    expect(onShowCovers).toHaveBeenCalledTimes(1)
    // Enabling a feature must not touch the note.
    expect(notesController.removeNoteHeroHeader).not.toHaveBeenCalled()
  })

  it('[Remove cover] deletes the cover directly, with the feature still off', () => {
    render({ hero: aCover, coversEnabled: false })

    act(() => {
      button('Remove cover')?.click()
    })

    // The point of the ungated remover: the user gets rid of a hidden cover
    // WITHOUT first having to enable a feature they do not want.
    expect(notesController.removeNoteHeroHeader).toHaveBeenCalledWith(note)
    expect(onShowCovers).not.toHaveBeenCalled()
  })

  it('stays one line: no image, no height style, no adjust controls', () => {
    render({ hero: aCover, coversEnabled: false })

    // The notice stands in for a 100..480px banner; if it ever grew a height
    // style the heroBannerHeight() fix in NoteView would be describing the wrong
    // element again.
    expect(container.querySelector('[style*="height"]')).toBeNull()
    expect(container.querySelector('input[type="range"]')).toBeNull()
    expect(button('Adjust')).toBeUndefined()
    expect(button('Change')).toBeUndefined()
  })

  describe('on a locked or read-only note (Q-E)', () => {
    it('offers [Show covers] ONLY', () => {
      render({ hero: aCover, coversEnabled: false, disabled: true })

      expect(container.textContent).toContain(HIDDEN_NOTICE_COPY)
      expect(button('Show covers')).toBeDefined()
      // `writeNoteHeroHeader` refuses while the note is locked, so a
      // [Remove cover] here could only ever be a dead or disabled button — and a
      // disabled button with no route forward is worse than no button.
      expect(button('Remove cover')).toBeUndefined()
    })
  })
})

describe('toggling the gate mutates no note', () => {
  it('re-renders off -> on -> off without a single controller write', () => {
    render({ hero: aCover, coversEnabled: false })
    expect(container.textContent).toContain(HIDDEN_NOTICE_COPY)

    render({ hero: aCover, coversEnabled: true })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(COVER_DATA_URL)

    render({ hero: aCover, coversEnabled: false })
    expect(container.textContent).toContain(HIDDEN_NOTICE_COPY)

    // No migration, no cleanup, no lazy rewrite. The identical `hero` object is
    // rendered on the way back, so re-enabling restores the cover exactly.
    expect(notesController.removeNoteHeroHeader).not.toHaveBeenCalled()
    expect(notesController.setNoteHeroImage).not.toHaveBeenCalled()
  })
})
