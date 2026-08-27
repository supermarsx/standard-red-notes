/**
 * @jest-environment jsdom
 *
 * The "All files" chip rendered its label with no glyph beside it.
 *
 * `Icon` looks its `type` up in IconNameToSvgMapping and, when there is no
 * match, treats the value as an emoji and renders the string itself inside a
 * <label>. `VectorIconNameOrEmoji` is `EmojiString | IconType` where
 * `EmojiString = Omit<string, IconType>` — i.e. any string — so a name that
 * does not exist typechecks cleanly and ships as visible text. `files` was one
 * such name, which is exactly what the report described: "doesnt have an icon
 * just shows the icon label".
 *
 * tsc cannot catch this class of bug, so it is pinned here by rendering the real
 * component (react-dom/client + act; the repo has no @testing-library) and
 * asserting each chip carries an <svg> and no stray icon-name text.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import FilesFolderBar, { FilesFolderFilterAll } from './FilesFolderBar'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const navigationController = {
  folders: [],
  allLocalRootFolders: [],
  getFolderChildren: () => [],
  createFolder: jest.fn(),
} as unknown as NavigationController

describe('FilesFolderBar icons', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        createElement(FilesFolderBar, {
          navigationController,
          activeFilter: FilesFolderFilterAll,
          onChange: jest.fn(),
        }),
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders an svg glyph in the All files chip, not the icon name as text', () => {
    const allFilesChip = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('allFiles'),
    )

    expect(allFilesChip).toBeDefined()
    expect(allFilesChip?.querySelector('svg')).not.toBeNull()
    expect(allFilesChip?.textContent).not.toContain('files ')
    expect(allFilesChip?.querySelector('label')).toBeNull()
  })

  it('renders a glyph in every chip, so no icon name falls through as a label', () => {
    const buttons = [...container.querySelectorAll('button')]

    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull()
      // The emoji fallback path renders a <label>; a real icon never does.
      expect(button.querySelector('label')).toBeNull()
    }
  })
})
