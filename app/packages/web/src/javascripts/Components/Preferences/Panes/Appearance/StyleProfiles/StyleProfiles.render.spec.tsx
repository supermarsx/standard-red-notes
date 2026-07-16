/**
 * @jest-environment jsdom
 *
 * Style profiles subtab — RENDER guard for the action-button overflow fix (t64).
 *
 * Each profile row carries a 6-button action group (Edit styles… / Rename /
 * Set default / Duplicate / Export / Delete). It used to be `flex-shrink-0`,
 * which pinned the group at its single-line max-content width inside the
 * `md:flex-row` row so its own `flex-wrap` never engaged — at realistic pane
 * widths the trailing buttons spilled past the pane's right edge. The fix drops
 * `flex-shrink-0` and adds `min-w-0` so the group can shrink and its `flex-wrap`
 * actually wraps the buttons instead of overflowing.
 *
 * tsc staying green does NOT prove the layout classes survived. This spec drives
 * the REAL <StyleProfiles> in jsdom and pins the CSS contract that prevents the
 * overflow: the per-row action-group div HAS `flex-wrap`, HAS `min-w-0`, and does
 * NOT have `flex-shrink-0` — plus all six action buttons still render per row.
 *
 * Honest limit: jsdom has no layout engine, so true pixel overflow is not
 * measurable here — this spec pins the class contract (`flex-wrap` present +
 * `flex-shrink-0` absent + `min-w-0` present) that guarantees wrapping. Real
 * visual confirmation needs a browser at a narrow pane width (not gating).
 * False-green check performed manually (see StyleProfiles change log): reverting
 * the fix (restoring `flex-shrink-0`, dropping `min-w-0`) turns this spec RED.
 *
 * t73-e2 additions — REACHABILITY / vanish guard for the transfer wizard. tsc-green
 * does NOT prove the new Import…/Export… entry points render OR that clicking them
 * opens the wizard. So the second describe block below asserts: the top Import…,
 * Export… buttons render and are reachable; clicking Import… opens the wizard in
 * import mode; the top Export… and each per-row Export open it in export mode; and
 * the wizard is ABSENT until a trigger is clicked. The wizard itself is stubbed
 * here (its own real-render/step proof lives in ProfileTransferWizard.render.spec)
 * — this stub reports the `isOpen`/`mode`/`initialProfileId` it is handed, so the
 * assertions fail if a trigger is not wired to open it (the false-green guard:
 * dropping any trigger's onClick leaves the sentinel absent → RED).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { TypographyProfile } from '@standardnotes/models'

// Fixtures the mocked usePreference feeds the component. `mock`-prefixed so the
// jest.mock factory below may reference them (jest hoists mocks above imports).
const mockProfiles: TypographyProfile[] = [
  { id: 'default-profile', name: 'Default', isDefault: true, schemaVersion: 1, blocks: {} },
  { id: 'reading', name: 'Reading', isDefault: false, schemaVersion: 1, blocks: {} },
  { id: 'compact', name: 'Compact', isDefault: false, schemaVersion: 1, blocks: {} },
]

// useApplication: the mount touches none of these on first render; the stub just
// keeps the component from throwing (setPreference / downloadData fire only on
// user actions, which this render guard does not exercise).
jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => ({
    setPreference: jest.fn(),
    getPreference: jest.fn(),
    addEventObserver: () => () => undefined,
    archiveService: { downloadData: () => undefined },
  }),
}))

// usePreference default export: branch on the pref key. PrefKey.TypographyProfiles
// === 'typographyProfiles', PrefKey.ActiveTypographyProfileId === 'activeTypographyProfileId'.
jest.mock('@/Hooks/usePreference', () => ({
  __esModule: true,
  default: (preference: string) => (preference === 'typographyProfiles' ? mockProfiles : mockProfiles[0].id),
}))

// The "Edit styles…" modal is a heavy Super-editor surface unrelated to the row
// layout; stub it with a sentinel (it renders closed anyway on mount).
jest.mock('@/Components/SuperEditor/Plugins/ToolbarPlugin/TypographyStyleEditorModal', () => ({
  __esModule: true,
  default: () => createElement('div', null, 'EDIT_STYLES_MODAL_SENTINEL'),
}))

// Dialogs and the file picker are only invoked by user actions; no-op them so
// importing them can't drag heavy browser deps into the mount.
jest.mock('@standardnotes/ui-services', () => ({
  confirmDialog: jest.fn().mockResolvedValue(true),
  alertDialog: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@standardnotes/filepicker', () => ({
  ClassicFileReader: { selectFiles: jest.fn().mockResolvedValue([]) },
}))

// The transfer wizard is proven for real in ProfileTransferWizard.render.spec. Here
// it is a sentinel that echoes the props it is opened with, so the StyleProfiles
// wiring (which button opens which mode / pre-scoped profile) is verifiable.
jest.mock('./ProfileTransferWizard', () => ({
  __esModule: true,
  default: ({ isOpen, mode, initialProfileId }: { isOpen: boolean; mode: string; initialProfileId?: string }) => {
    if (!isOpen) {
      return createElement('div', null, 'WIZARD_CLOSED')
    }
    return createElement('div', null, `WIZARD_OPEN:${mode}:${initialProfileId ?? 'none'}`)
  },
}))

import StyleProfiles from './StyleProfiles'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const EXPECTED_ACTION_LABELS = ['Edit styles…', 'Rename', 'Set default', 'Duplicate', 'Export', 'Delete']

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const render = async () => {
  await act(async () => {
    root.render(createElement(StyleProfiles))
  })
}

const buttonsWithText = (text: string) =>
  Array.from(container.querySelectorAll('button')).filter((b) => (b.textContent ?? '').trim() === text)

describe('StyleProfiles action buttons wrap instead of overflowing', () => {
  it('renders one row per profile, each with all six action buttons', async () => {
    await render()
    const deleteButtons = buttonsWithText('Delete')
    expect(deleteButtons).toHaveLength(mockProfiles.length)

    const group = deleteButtons[0].parentElement as HTMLElement
    const labels = Array.from(group.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())
    expect(labels).toEqual(expect.arrayContaining(EXPECTED_ACTION_LABELS))
    expect(labels).toHaveLength(EXPECTED_ACTION_LABELS.length)
  })

  it('pins the wrap-enabling CSS contract on the action group', async () => {
    await render()
    const group = (buttonsWithText('Delete')[0] as HTMLElement).parentElement as HTMLElement

    // The group must be able to shrink (min-w-0, no flex-shrink-0) so its
    // flex-wrap engages — the exact mechanism that stops the buttons overflowing.
    expect(group.classList.contains('flex-wrap')).toBe(true)
    expect(group.classList.contains('min-w-0')).toBe(true)
    expect(group.classList.contains('flex-shrink-0')).toBe(false)
  })
})

describe('StyleProfiles transfer-wizard entry points (reachability / vanish guard)', () => {
  const click = async (button: HTMLButtonElement) => {
    await act(async () => {
      button.click()
    })
  }

  it('renders the top Import… and Export… entry points', async () => {
    await render()
    expect(buttonsWithText('Import…')).toHaveLength(1)
    expect(buttonsWithText('Export…')).toHaveLength(1)
    // Per-row Export shortcuts still render (one per profile).
    expect(buttonsWithText('Export')).toHaveLength(mockProfiles.length)
    // Wizard is not mounted until a trigger is clicked.
    expect(container.textContent).not.toContain('WIZARD_OPEN')
  })

  it('opens the wizard in import mode when Import… is clicked', async () => {
    await render()
    await click(buttonsWithText('Import…')[0])
    expect(container.textContent).toContain('WIZARD_OPEN:import:none')
  })

  it('opens the wizard in export mode from the top Export… button (no pre-scope)', async () => {
    await render()
    await click(buttonsWithText('Export…')[0])
    expect(container.textContent).toContain('WIZARD_OPEN:export:none')
  })

  it('opens the export wizard pre-scoped to the row profile from a per-row Export', async () => {
    await render()
    // The second profile row ("Reading", id 'reading').
    await click(buttonsWithText('Export')[1])
    expect(container.textContent).toContain('WIZARD_OPEN:export:reading')
  })
})
