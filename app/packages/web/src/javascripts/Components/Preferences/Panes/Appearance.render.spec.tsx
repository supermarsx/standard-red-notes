/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: VANISH GUARD for the two t111 settings that live in
 * Preferences → Appearance — "Allow note covers" and "Mini tags panel".
 *
 * Their own leaf specs (`Appearance/NoteCovers.spec.tsx`,
 * `Appearance/SidebarMini.spec.tsx`) prove the controls behave. They prove
 * nothing about whether a user can SEE them: this repo has twice added a control
 * that typechecked, passed its unit tests and rendered nowhere, and covers in
 * particular have no other home at all — if the card is not in this pane the
 * setting does not exist. So this file mounts the real <Appearance> pane and
 * looks for both cards in the subtab that is open by default.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

const prefs = new Map<string, unknown>()
const localPrefs = new Map<string, unknown>()

const COVER_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

/**
 * A note that DOES carry a cover, deliberately paired with
 * `isDatabaseLoaded() === false` below. The two together are what makes the
 * honest-absence assertion bite: if the pane ever counted covers without waiting
 * for the database, the count would come out as 1 here and the sentence would
 * appear. An empty note list would have hidden that bug behind a real zero.
 */
const noteWithCover = () => ({ getAppDomainValue: () => ({ imageDataUrl: COVER_DATA_URL, height: 200 }) })

const application = {
  getPreference: (key: string, defaultValue?: unknown) => (prefs.has(key) ? prefs.get(key) : defaultValue),
  setPreference: jest.fn(async () => undefined),
  addEventObserver: () => () => undefined,
  sync: { isDatabaseLoaded: () => false },
  items: { getDisplayableNotes: () => [noteWithCover()], streamItems: () => () => undefined },
  preferences: {
    getLocalValue: (key: string, defaultValue?: unknown) => (localPrefs.has(key) ? localPrefs.get(key) : defaultValue),
    setLocalValue: jest.fn(),
  },
} as unknown as import('@/Application/WebApplication').WebApplication

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => application,
}))

// The theme-related children of this subtab reach into real theme/plugin service
// surface. Sentinels keep this spec about the pane's COMPOSITION.
jest.mock('./Appearance/ColorSchemeModeControl', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'COLORSCHEME'),
}))
jest.mock('./Appearance/BaseThemePalette', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'PALETTE'),
}))
jest.mock('./Appearance/CustomThemes/CustomThemesSection', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'CUSTOMTHEMES'),
}))
jest.mock('./Appearance/StyleProfiles/StyleProfiles', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'STYLEPROFILES'),
}))
jest.mock('./Appearance/EditorAppearance', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'EDITORAPPEARANCE'),
}))

import Appearance from './Appearance'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  prefs.clear()
  localPrefs.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async () => {
  await act(async () => {
    root.render(createElement(Appearance, { application }))
  })
  await act(async () => {})
}

describe('the Appearance pane surfaces both t111 settings', () => {
  it('renders the note-covers card in the default subtab', async () => {
    await render()

    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel).not.toBeNull()
    // A sentinel proves we are in the Appearance subtab rather than Style profiles.
    expect(panel?.textContent).toContain('EDITORAPPEARANCE')

    const card = panel?.querySelector('[data-test="note-covers-setting"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(panel?.textContent).toContain('Allow note covers')
  })

  it('renders the mini tags panel card in the default subtab', async () => {
    await render()

    const panel = container.querySelector('[role="tabpanel"]')
    const card = panel?.querySelector('[data-test="sidebar-mini-setting"]')
    expect(card).not.toBeNull()
    expect(card?.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(panel?.textContent).toContain('Mini tags panel')
  })

  it('places note covers after the "Editor tabs" group, where the plan put it', async () => {
    await render()

    const text = container.textContent ?? ''
    const editorTabsIndex = text.indexOf('Editor tabs')
    const coversIndex = text.indexOf('Allow note covers')
    expect(editorTabsIndex).toBeGreaterThanOrEqual(0)
    expect(coversIndex).toBeGreaterThan(editorTabsIndex)
  })

  it('says nothing about a hidden-cover count while the database is unloaded', async () => {
    // The pane-level restatement of the honest-absence rule: this harness reports
    // `isDatabaseLoaded() === false`, so there is no count to report and the
    // sentence must be absent rather than read as a reassuring zero.
    await render()

    expect(container.querySelector('[data-test="note-covers-hidden-count"]')).toBeNull()
    expect(container.textContent ?? '').not.toContain('hidden cover')
  })
})
