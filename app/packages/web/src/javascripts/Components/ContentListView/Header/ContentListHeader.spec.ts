import { shouldShowCollapsedNavigationExpander } from './ContentListHeader'

describe('ContentListHeader navigation controls', () => {
  it('does not duplicate the navigation menu with a topics expander on responsive layouts', () => {
    expect(shouldShowCollapsedNavigationExpander(true, true)).toBe(false)
  })

  it('keeps the desktop recovery control when the navigation pane is collapsed', () => {
    expect(shouldShowCollapsedNavigationExpander(true, false)).toBe(true)
  })

  it('does not show an expander for an already visible navigation pane', () => {
    expect(shouldShowCollapsedNavigationExpander(false, false)).toBe(false)
  })
})
