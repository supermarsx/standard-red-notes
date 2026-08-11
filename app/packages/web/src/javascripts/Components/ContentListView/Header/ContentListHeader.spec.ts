import { getNavigationControlVisibility } from './ContentListHeader'

describe('ContentListHeader navigation controls', () => {
  it.each([
    ['fine-pointer tablet', true, false],
    ['coarse-pointer tablet', true, true],
    ['fine-pointer desktop', false, false],
    ['coarse-pointer desktop', false, true],
  ])('shows exactly one recovery control on a collapsed %s layout', (_layout, isTabletOrMobile, usesTabletLayout) => {
    const visibility = getNavigationControlVisibility(true, isTabletOrMobile, usesTabletLayout)

    expect(Number(visibility.showNavigationMenu) + Number(visibility.showCollapsedNavigationExpander)).toBe(1)
  })

  it('uses the topics expander as the collapsed fine-pointer desktop recovery control', () => {
    expect(getNavigationControlVisibility(true, false, false)).toEqual({
      showNavigationMenu: false,
      showCollapsedNavigationExpander: true,
    })
  })

  it('uses the navigation menu for a wide coarse-pointer layout', () => {
    expect(getNavigationControlVisibility(true, false, true)).toEqual({
      showNavigationMenu: true,
      showCollapsedNavigationExpander: false,
    })
  })

  it('does not show a desktop expander for an already visible navigation pane', () => {
    expect(getNavigationControlVisibility(false, false, false)).toEqual({
      showNavigationMenu: false,
      showCollapsedNavigationExpander: false,
    })
  })
})
