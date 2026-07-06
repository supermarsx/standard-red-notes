import { PreferencesSubtab, resolveActiveSubtabId } from './PreferencesSubtabs'

const tab = (id: string, hidden = false): PreferencesSubtab => ({
  id,
  title: id,
  icon: 'settings',
  content: null,
  hidden,
})

describe('resolveActiveSubtabId', () => {
  it('returns the active tab when it is visible', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(resolveActiveSubtabId(tabs, 'b')).toBe('b')
  })

  it('falls back to the first visible tab when the active tab is hidden', () => {
    const tabs = [tab('a'), tab('b', true), tab('c')]
    expect(resolveActiveSubtabId(tabs, 'b')).toBe('a')
  })

  it('falls back to the first visible tab when the active tab is unknown', () => {
    const tabs = [tab('a', true), tab('b'), tab('c')]
    expect(resolveActiveSubtabId(tabs, 'does-not-exist')).toBe('b')
  })

  it('returns undefined when no tabs are visible', () => {
    const tabs = [tab('a', true), tab('b', true)]
    expect(resolveActiveSubtabId(tabs, 'a')).toBeUndefined()
  })
})
