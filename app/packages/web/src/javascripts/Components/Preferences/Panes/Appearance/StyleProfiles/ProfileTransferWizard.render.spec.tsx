/**
 * @jest-environment jsdom
 *
 * Style-Profiles transfer wizard — REAL jsdom render + end-to-end guard (t73-e2).
 *
 * This repo has TWICE shipped tsc-green UI that never actually rendered / was
 * filtered out of the DOM (MEMORY: "verify UI render paths"). tsc + unit green is
 * NOT proof. So this spec drives the REAL <ProfileTransferWizard> (real Modal /
 * ModalOverlay portal, real e1 transfer logic — nothing about the parse / select /
 * resolve / serialize path is mocked) and proves, for BOTH modes:
 *
 *   IMPORT:  the Source step renders (drop zone + "Choose file…"); choosing a file
 *            parses it and advances to Preview & Select, where the grouped block
 *            tree renders REAL rows INCLUDING the "Variants" group, the truthful
 *            sanitisation diff renders a "removed" declaration, and the create-new /
 *            merge target selector renders. Then an END-TO-END drive: deselect a
 *            block, Import (create) → onImportApply receives the exact resolved
 *            profile list; the Confirm step renders.
 *
 *   EXPORT:  the Select step renders the tree, Next → Preview renders the resulting
 *            file summary, Export → onExportDownload receives the real
 *            serializeProfilesForExport output (bundle shape for ≥2 profiles), and
 *            the final step renders.
 *
 * The dialog renders into a body portal, so assertions are against document.body
 * (mirrors SuggestTagsForFileModal.spec / SuperExportModal.spec).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { TypographyProfile } from '@standardnotes/models'

// Modal safe-area padding pulls the app context; the wizard itself needs no app,
// so stub the hook (and the Android back handler) rather than wiring a provider.
jest.mock('@/Hooks/useSafeAreaPadding', () => ({
  useAvailableSafeAreaPadding: () => ({
    hasTopInset: false,
    hasRightInset: false,
    hasBottomInset: false,
    hasLeftInset: false,
  }),
}))
jest.mock('@/NativeMobileWeb/useAndroidBackHandler', () => ({
  __esModule: true,
  useAndroidBackHandler: () => () => () => undefined,
  default: () => null,
}))

// The import drop zone's "Choose file…" button uses ClassicFileReader.selectFiles;
// the mock is re-pointed per test at the fixture file the wizard should parse.
const selectFilesMock = jest.fn()
jest.mock('@standardnotes/filepicker', () => ({
  ClassicFileReader: { selectFiles: (...args: unknown[]) => selectFilesMock(...args) },
}))

import ProfileTransferWizard from './ProfileTransferWizard'
import type { SerializedExport } from '@/Utils/typographyProfileImportExport'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// A file whose `text()` yields a known bundle: paragraph carries a SAFE size plus
// an UNSAFE url() background (the sanitiser must drop it → a "removed" diff row),
// and `title` (a VARIANT block) carries a weight so the tree's "Variants" group
// must appear.
const IMPORT_JSON = JSON.stringify({
  schemaVersion: 1,
  name: 'Imported One',
  blocks: {
    paragraph: { fontSize: '18px', backgroundColor: 'url(evil.png)' },
    title: { fontWeight: '700' },
  },
})
const fakeImportFile = {
  name: 'imported.json',
  type: 'application/json',
  text: async () => IMPORT_JSON,
} as unknown as File

const existingProfiles: TypographyProfile[] = [
  { id: 'default', name: 'Default', isDefault: true, schemaVersion: 1, blocks: { paragraph: { fontSize: '16px' } } },
]

const exportProfiles: TypographyProfile[] = [
  {
    id: 'p1',
    name: 'Reading',
    isDefault: true,
    schemaVersion: 1,
    blocks: { paragraph: { fontSize: '16px' }, title: { fontWeight: '600' } },
  },
  { id: 'p2', name: 'Compact', isDefault: false, schemaVersion: 1, blocks: { h1: { fontSize: '2rem' } } },
]

let container: HTMLElement
let root: Root
let originalAnimate: typeof Element.prototype.animate

beforeEach(() => {
  jest.clearAllMocks()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  originalAnimate = Element.prototype.animate
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      cancel: () => undefined,
      finish: () => undefined,
      currentTime: 0,
    } as unknown as Animation
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.querySelectorAll('[data-dialog-portal]').forEach((el) => el.remove())
  Element.prototype.animate = originalAnimate
})

const findButton = (predicate: (text: string) => boolean): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((b) => predicate((b.textContent ?? '').trim())) as
    HTMLButtonElement | undefined

const findExact = (label: string) => findButton((text) => text === label)
const findStartsWith = (prefix: string) => findButton((text) => text.startsWith(prefix))

describe('ProfileTransferWizard — import mode', () => {
  const renderImport = (onImportApply: (r: TypographyProfile[]) => void) => {
    act(() => {
      root.render(
        createElement(ProfileTransferWizard, {
          mode: 'import',
          isOpen: true,
          close: () => undefined,
          profiles: existingProfiles,
          onImportApply,
          onExportDownload: () => undefined,
        }),
      )
    })
  }

  it('renders the Source step with a drop zone and file picker', () => {
    renderImport(() => undefined)
    expect(document.body.textContent).toContain('Drag & drop a .json profile file here')
    expect(findExact('Choose file…')).toBeDefined()
    // Not yet parsed → tree/diff not shown.
    expect(document.body.textContent).not.toContain('Sanitisation preview')
  })

  it('parses a chosen file, then renders the tree (incl. Variants), the diff, and the target selector', async () => {
    selectFilesMock.mockResolvedValue([fakeImportFile])
    renderImport(() => undefined)

    await act(async () => {
      findExact('Choose file…')!.click()
    })

    const text = document.body.textContent ?? ''
    // Advanced to Preview & Select.
    expect(text).toContain('Choose what to import')
    // Selection tree rendered real rows, including the grouped labels.
    expect(text).toContain('Imported One')
    expect(text).toContain('Blocks')
    expect(text).toContain('Variants')
    // 'Normal' is the paragraph label (Blocks group); 'Title' is a variant label,
    // which only appears when the Variants group actually renders.
    expect(text).toContain('Normal')
    expect(text).toContain('Title')
    // Truthful sanitisation diff: the unsafe url() background was dropped.
    expect(text).toContain('Sanitisation preview')
    expect(text).toContain('backgroundColor')
    expect(text).toContain('removed')
    // Target selector: create-new (default) + merge-into-existing.
    expect(text).toContain('Create a new profile')
    expect(text).toContain('Merge selected blocks into an existing profile')
  })

  it('drives end-to-end: deselect a block, Import (create) → resolved list is applied', async () => {
    selectFilesMock.mockResolvedValue([fakeImportFile])
    const onImportApply = jest.fn<void, [TypographyProfile[]]>()
    renderImport(onImportApply)

    await act(async () => {
      findExact('Choose file…')!.click()
    })

    // Deselect the "Title" variant block, so only "paragraph" is imported.
    const titleCheckbox = document.body.querySelector('input[aria-label="Title in Imported One"]') as HTMLInputElement
    expect(titleCheckbox).toBeTruthy()
    expect(titleCheckbox.checked).toBe(true)
    await act(async () => {
      titleCheckbox.click()
    })

    // Primary action reflects the remaining single block.
    const importButton = findStartsWith('Import')
    expect(importButton).toBeDefined()
    expect(importButton!.textContent).toContain('Import 1 block')

    await act(async () => {
      importButton!.click()
    })

    expect(onImportApply).toHaveBeenCalledTimes(1)
    const resolved = onImportApply.mock.calls[0][0]
    // create-new: existing Default preserved + one appended profile carrying ONLY
    // the selected paragraph block (title was deselected, url() bg was sanitised).
    expect(resolved).toHaveLength(existingProfiles.length + 1)
    expect(resolved[0].id).toBe('default')
    const created = resolved[resolved.length - 1]
    expect(created.name).toBe('Imported One')
    expect(Object.keys(created.blocks)).toEqual(['paragraph'])
    expect(created.blocks.paragraph).toEqual({ fontSize: '18px' })

    // Confirm step rendered.
    expect(document.body.textContent).toContain('Import complete')
  })
})

describe('ProfileTransferWizard — export mode', () => {
  const renderExport = (onExportDownload: (s: SerializedExport) => void, initialProfileId?: string) => {
    act(() => {
      root.render(
        createElement(ProfileTransferWizard, {
          mode: 'export',
          isOpen: true,
          close: () => undefined,
          profiles: exportProfiles,
          initialProfileId,
          onImportApply: () => undefined,
          onExportDownload,
        }),
      )
    })
  }

  it('renders Select → Preview → Export and hands back the real serialized bundle', async () => {
    const onExportDownload = jest.fn<void, [SerializedExport]>()
    renderExport(onExportDownload)

    // Select step: the tree over both profiles.
    let text = document.body.textContent ?? ''
    expect(text).toContain('Reading')
    expect(text).toContain('Compact')
    // Reading carries a title variant, so the Variants group renders.
    expect(text).toContain('Variants')

    // Next → Preview.
    await act(async () => {
      findExact('Next')!.click()
    })
    text = document.body.textContent ?? ''
    expect(text).toContain('Ready to export')
    expect(text).toContain('typography-profiles.typography.json')
    expect(text).toContain('Multi-profile bundle')

    // Export → download callback receives the real serialization.
    await act(async () => {
      findExact('Export')!.click()
    })
    expect(onExportDownload).toHaveBeenCalledTimes(1)
    const serialized = onExportDownload.mock.calls[0][0]
    expect(serialized.isBundle).toBe(true)
    expect(serialized.fileName).toBe('typography-profiles.typography.json')
    const parsed = JSON.parse(serialized.json)
    expect(Array.isArray(parsed.profiles)).toBe(true)
    expect(parsed.profiles).toHaveLength(2)

    // Final step rendered.
    expect(document.body.textContent).toContain('Export ready')
  })

  it('pre-scopes to a single profile → legacy single-file shape', async () => {
    const onExportDownload = jest.fn<void, [SerializedExport]>()
    renderExport(onExportDownload, 'p1')

    await act(async () => {
      findExact('Next')!.click()
    })
    expect(document.body.textContent).toContain('Single profile (legacy)')

    await act(async () => {
      findExact('Export')!.click()
    })
    const serialized = onExportDownload.mock.calls[0][0]
    expect(serialized.isBundle).toBe(false)
    // Legacy shape: a bare profile object (no top-level `profiles` array).
    const parsed = JSON.parse(serialized.json)
    expect(parsed.profiles).toBeUndefined()
    expect(parsed.name).toBe('Reading')
  })
})
