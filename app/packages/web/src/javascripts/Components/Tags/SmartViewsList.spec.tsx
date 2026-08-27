/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { SystemViewId } from '@standardnotes/snjs'

jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const mockApplication = {
  items: {
    streamItems: jest.fn(() => () => undefined),
    numberOfNotesWithConflicts: jest.fn(() => 0),
  },
}

jest.mock('../ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

import SmartViewsList from './SmartViewsList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestView = { uuid: string; title: string; iconString: string }

const view = (uuid: string, title: string): TestView => ({ uuid, title, iconString: 'notes' })

const ALL_NOTES = view(SystemViewId.AllNotes, 'All notes')
const FILES = view(SystemViewId.Files, 'Files')
const ARCHIVED = view(SystemViewId.ArchivedNotes, 'Archived')
const USER_VIEW = view('user-smart-view', 'My work')

describe('SmartViewsList — the Files system view is not a sidebar entry', () => {
  let container: HTMLDivElement
  let root: Root

  const renderList = async (views: TestView[], isSearching = false) => {
    const navigationController = {
      smartViews: views,
      isSearching,
      selected: undefined,
      editingTag: undefined,
      allNotesCount: 12,
      allFilesCount: 7,
      setSelectedTag: jest.fn(async () => undefined),
      save: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
    }

    await act(async () => {
      root.render(
        createElement(SmartViewsList, {
          navigationController: navigationController as never,
          featuresController: {} as never,
          setEditingSmartView: jest.fn(),
        }),
      )
    })
  }

  /** The real rendered row titles, read out of the DOM the component actually produced. */
  const renderedRows = () =>
    Array.from(container.querySelectorAll('[id^="react-tag-"]')).map((element) => ({
      id: element.id,
      title: element.textContent,
    }))

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('omits the Files row while still rendering every other view', async () => {
    await renderList([ALL_NOTES, FILES, ARCHIVED, USER_VIEW])

    const rows = renderedRows()

    expect(rows.map((row) => row.id)).toEqual([
      `react-tag-${SystemViewId.AllNotes}`,
      `react-tag-${SystemViewId.ArchivedNotes}`,
      'react-tag-user-smart-view',
    ])
    expect(rows.map((row) => row.title)).toEqual(['All notes', 'Archived', 'My work'])
  })

  it('renders no row whose title is Files, so the sidebar has a single Files affordance', async () => {
    await renderList([ALL_NOTES, FILES, ARCHIVED])

    expect(renderedRows().some((row) => row.title === 'Files')).toBe(false)
    expect(container.querySelector(`#react-tag-${SystemViewId.Files}`)).toBeNull()
  })

  it('does not render the Files count that the row used to display', async () => {
    await renderList([ALL_NOTES, FILES])

    // allFilesCount is 7 and allNotesCount is 12; only the notes count should survive.
    expect(container.textContent).toContain('12')
    expect(container.textContent).not.toContain('7')
  })

  it('treats a Files-only list as empty while searching rather than rendering a blank section', async () => {
    await renderList([FILES], true)

    expect(renderedRows()).toHaveLength(0)
    expect(container.textContent).toContain('noSmartViewsFound')
  })
})
