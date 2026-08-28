import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { ViewTab, viewTabOwnsCreateShortcut } from './ViewTab'

describe('viewTabOwnsCreateShortcut', () => {
  const paneTab = (paneId: AppPaneId): ViewTab => ({ id: paneId, kind: 'pane', paneId, title: 'Tab', icon: 'window' })

  it('yields the create shortcut to the Files tab, which binds it to upload', () => {
    expect(viewTabOwnsCreateShortcut(paneTab(AppPaneId.Files))).toBe(true)
  })

  it('keeps the create shortcut on the notes list when no view tab is active', () => {
    expect(viewTabOwnsCreateShortcut(undefined)).toBe(false)
  })

  it.each([AppPaneId.Home, AppPaneId.Dashboard, AppPaneId.Todos, AppPaneId.Calendar, AppPaneId.Bookmarks])(
    'keeps the create shortcut on the notes list under the %s tab, which binds nothing',
    (paneId) => {
      expect(viewTabOwnsCreateShortcut(paneTab(paneId))).toBe(false)
    },
  )

  it('keeps the create shortcut on the notes list for tabs that carry no pane', () => {
    const conflict: ViewTab = { id: 'c', kind: 'conflict', noteUuid: 'n', title: 'Conflict', icon: 'merge' }
    const empty: ViewTab = { id: 'e', kind: 'empty', title: 'New tab', icon: 'add' }

    expect(viewTabOwnsCreateShortcut(conflict)).toBe(false)
    expect(viewTabOwnsCreateShortcut(empty)).toBe(false)
  })
})
