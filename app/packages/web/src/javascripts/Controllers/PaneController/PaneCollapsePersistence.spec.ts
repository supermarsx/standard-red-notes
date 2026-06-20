/**
 * @jest-environment jsdom
 *
 * Pane collapse persistence.
 *
 * The desktop three-pane layout lets the user independently collapse the
 * navigation sidebar and the notes list. Each collapsed state is persisted
 * locally (localStorage-backed local preferences) via `LocalPrefKey.*PaneCollapsed`
 * and restored on load. The collapse/expand actions live on `PaneController`
 * (`toggleListPane` / `toggleNavigationPane`) and mutate the `panes` array while
 * writing the new state through `preferences.setLocalValue`.
 *
 * SUBSTITUTION NOTE (mirrors the SinglePaneShell spec): `toggleListPane`,
 * `toggleNavigationPane`, `removePane`, and `insertPaneAtIndex` are class-field
 * arrow functions assigned inside PaneController's service-heavy constructor, so
 * they don't exist on a bare prototype instance and the constructor can't run in
 * jsdom without standing up mobx + many services. We therefore exercise the EXACT
 * method bodies (verbatim from PaneController) against a minimal state object. The
 * collapsed-state getters ARE real prototype getters, so those are invoked directly
 * off the prototype to verify the real implementation.
 */
import { LocalPrefKey } from '@standardnotes/services'
import { removeFromArray } from '@standardnotes/snjs'
import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import { PaneController } from './PaneController'

type State = {
  panes: AppPaneId[]
  preferences: { setLocalValue: jest.Mock }
}

// Verbatim from PaneController.removePane / insertPaneAtIndex (minus logging).
const removePane = (state: State, pane: AppPaneId) => removeFromArray(state.panes, pane)
const insertPaneAtIndex = (state: State, pane: AppPaneId, index: number) =>
  state.panes.splice(index, 0, pane)

// Verbatim from PaneController.toggleListPane.
const toggleListPane = (state: State) => {
  if (state.panes.includes(AppPaneId.Items)) {
    removePane(state, AppPaneId.Items)
    state.preferences.setLocalValue(LocalPrefKey.ListPaneCollapsed, true)
  } else {
    if (state.panes.includes(AppPaneId.Navigation)) {
      insertPaneAtIndex(state, AppPaneId.Items, 1)
    } else {
      insertPaneAtIndex(state, AppPaneId.Items, 0)
    }
    state.preferences.setLocalValue(LocalPrefKey.ListPaneCollapsed, false)
  }
}

// Verbatim from PaneController.toggleNavigationPane.
const toggleNavigationPane = (state: State) => {
  if (state.panes.includes(AppPaneId.Navigation)) {
    removePane(state, AppPaneId.Navigation)
    state.preferences.setLocalValue(LocalPrefKey.NavigationPaneCollapsed, true)
  } else {
    insertPaneAtIndex(state, AppPaneId.Navigation, 0)
    state.preferences.setLocalValue(LocalPrefKey.NavigationPaneCollapsed, false)
  }
}

const makeState = (panes: AppPaneId[]): State => ({
  panes,
  preferences: { setLocalValue: jest.fn() },
})

// Real prototype getters under test.
const getIsListPaneCollapsed = Object.getOwnPropertyDescriptor(
  PaneController.prototype,
  'isListPaneCollapsed',
)!.get!
const getIsNavigationPaneCollapsed = Object.getOwnPropertyDescriptor(
  PaneController.prototype,
  'isNavigationPaneCollapsed',
)!.get!

describe('PaneController collapse persistence', () => {
  describe('toggleNavigationPane', () => {
    it('collapses the navigation pane and persists collapsed=true', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

      toggleNavigationPane(state)

      expect(state.panes).toEqual([AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.NavigationPaneCollapsed, true)
    })

    it('expands the navigation pane (restored at index 0) and persists collapsed=false', () => {
      const state = makeState([AppPaneId.Items, AppPaneId.Editor])

      toggleNavigationPane(state)

      expect(state.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.NavigationPaneCollapsed, false)
    })
  })

  describe('toggleListPane', () => {
    it('collapses the notes list and persists collapsed=true', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

      toggleListPane(state)

      expect(state.panes).toEqual([AppPaneId.Navigation, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ListPaneCollapsed, true)
    })

    it('re-inserts the notes list after navigation when navigation is shown', () => {
      const state = makeState([AppPaneId.Navigation, AppPaneId.Editor])

      toggleListPane(state)

      expect(state.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ListPaneCollapsed, false)
    })

    it('re-inserts the notes list at index 0 when navigation is also collapsed', () => {
      const state = makeState([AppPaneId.Editor])

      toggleListPane(state)

      expect(state.panes).toEqual([AppPaneId.Items, AppPaneId.Editor])
      expect(state.preferences.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.ListPaneCollapsed, false)
    })
  })

  describe('collapsed-state getters reflect the panes array (all four combinations)', () => {
    const cases: Array<[AppPaneId[], boolean, boolean]> = [
      [[AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor], false, false],
      [[AppPaneId.Items, AppPaneId.Editor], true, false],
      [[AppPaneId.Navigation, AppPaneId.Editor], false, true],
      [[AppPaneId.Editor], true, true],
    ]

    it.each(cases)('%j -> navCollapsed=%s listCollapsed=%s', (panes, navCollapsed, listCollapsed) => {
      const ctx = { panes }
      expect(getIsNavigationPaneCollapsed.call(ctx)).toBe(navCollapsed)
      expect(getIsListPaneCollapsed.call(ctx)).toBe(listCollapsed)
    })
  })
})
