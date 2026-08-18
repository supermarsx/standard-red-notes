import { shouldShowLinkedItemsToggle } from './linkedItemsToggle'

describe('linked items container toggle visibility', () => {
  it('does not render a control that cannot change visible content', () => {
    expect(shouldShowLinkedItemsToggle(0, false, false)).toBe(false)
    expect(shouldShowLinkedItemsToggle(5, false, false)).toBe(false)
  })

  it('renders when collapsing hides items or removes a wrapped row', () => {
    expect(shouldShowLinkedItemsToggle(6, false, false)).toBe(true)
    expect(shouldShowLinkedItemsToggle(3, true, false)).toBe(true)
  })

  it('honors an explicit hidden toggle', () => {
    expect(shouldShowLinkedItemsToggle(10, true, true)).toBe(false)
  })
})
