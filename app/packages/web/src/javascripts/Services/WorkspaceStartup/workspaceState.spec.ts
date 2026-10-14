import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'
import { readWorkspaceState, serializeWorkspaceState, startupBehavior, startupView } from './workspaceState'

describe('workspace resume metadata', () => {
  it('defaults to all-tab resume and a valid startup view', () => {
    expect(startupBehavior(undefined)).toBe('resume')
    expect(startupBehavior('old-setting')).toBe('resume')
    expect(startupView('invalid')).toBe(AppPaneId.Home)
  })
  it('rejects another account and malformed versions', () => {
    expect(readWorkspaceState({ version: 1, owner: 'other', items: [], views: [] }, 'me')).toBeUndefined()
    expect(readWorkspaceState({ version: 2, owner: 'me', items: [], views: [] }, 'me')).toBeUndefined()
  })
  it('preserves ordered notes, files, view and empty tabs without storing titles or text', () => {
    const state = readWorkspaceState(
      {
        version: 1,
        owner: 'me',
        items: [
          { uuid: 'b', kind: 'note', text: 'secret' },
          { uuid: 'a', kind: 'file' },
          { uuid: 'b', kind: 'note' },
        ],
        views: [
          { kind: 'pane', paneId: AppPaneId.Calendar, title: 'secret' },
          { kind: 'empty', id: 'empty:5' },
          { kind: 'empty', id: 'empty:999999999999999999999' },
          { kind: 'pane', paneId: 'unsafe' },
        ],
        activeItemUuid: 'a',
        activeViewId: AppPaneId.Calendar,
      },
      'me',
    )!
    expect(state.items.map((item) => item.uuid)).toEqual(['b', 'a'])
    expect(state.views.map((view) => view.id)).toEqual([AppPaneId.Calendar, 'empty:5'])
    const stored = serializeWorkspaceState(state)
    expect(JSON.stringify(stored)).not.toContain('secret')
    expect(JSON.stringify(stored)).not.toContain('title')
    expect(readWorkspaceState(stored, 'me')).toEqual(state)
  })
})
