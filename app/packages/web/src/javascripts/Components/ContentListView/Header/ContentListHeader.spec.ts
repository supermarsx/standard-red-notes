import { getNavigationControlVisibility } from './ContentListHeader'

describe('ContentListHeader navigation controls', () => {
  it('shows the navigation menu button on any touch layout', () => {
    expect(getNavigationControlVisibility(true, false)).toEqual({ showNavigationMenu: true })
    expect(getNavigationControlVisibility(false, true)).toEqual({ showNavigationMenu: true })
    expect(getNavigationControlVisibility(true, true)).toEqual({ showNavigationMenu: true })
  })

  it('shows no navigation control at all on a fine-pointer desktop layout', () => {
    expect(getNavigationControlVisibility(false, false)).toEqual({ showNavigationMenu: false })
  })

  // The desktop collapse/expand affordances used to live here (a topics expander
  // on the left, a notes-panel collapse button on the right). They moved to the
  // footer bar; this header must not grow one back.
  it('exposes no collapse/expand affordance of its own', () => {
    for (const isTabletOrMobile of [true, false]) {
      for (const usesTabletLayout of [true, false]) {
        expect(Object.keys(getNavigationControlVisibility(isTabletOrMobile, usesTabletLayout))).toEqual([
          'showNavigationMenu',
        ])
      }
    }
  })
})
