import { searchPreferences, SearchablePane } from './searchPreferences'

const PANES: SearchablePane[] = [
  { id: 'whats-new', label: "What's New" },
  { id: 'account', label: 'Account' },
  { id: 'general', label: 'General' },
  { id: 'security', label: 'Security' },
  { id: 'backups', label: 'Backups' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'help-feedback', label: 'Documentation' },
]

const ids = (query: string): string[] => searchPreferences(query, PANES).map((result) => result.id)

describe('searchPreferences', () => {
  it('returns an empty list for an empty or whitespace query', () => {
    expect(searchPreferences('', PANES)).toEqual([])
    expect(searchPreferences('   ', PANES)).toEqual([])
  })

  it('matches a pane by its exact title (case-insensitive)', () => {
    const results = searchPreferences('security', PANES)
    expect(results[0].id).toBe('security')
    expect(results[0].matchedKeyword).toBeUndefined()
  })

  it('matches a pane by a partial title substring', () => {
    expect(ids('appear')).toContain('appearance')
  })

  it('matches a pane via a keyword and surfaces the matched keyword', () => {
    const results = searchPreferences('2fa', PANES)
    expect(results[0].id).toBe('security')
    expect(results[0].matchedKeyword).toBe('2fa')
  })

  it('finds appearance settings when searching for "dark mode"', () => {
    const results = searchPreferences('dark mode', PANES)
    expect(results[0].id).toBe('appearance')
    expect(results[0].matchedKeyword).toBe('dark mode')
  })

  it('routes "theme" and "font" to the appearance pane', () => {
    expect(ids('theme')).toContain('appearance')
    expect(ids('font')).toContain('appearance')
  })

  it('routes "passcode" and "encryption" to the security pane', () => {
    expect(ids('passcode')).toContain('security')
    expect(ids('encryption')).toContain('security')
  })

  it('routes "export" to the backups pane', () => {
    expect(ids('export')).toContain('backups')
  })

  it('ranks a title match above a looser keyword match', () => {
    // "account" is the exact title of the Account pane, and also (as "subscription"
    // -> no) — ensure the exact-title pane is ranked first.
    const results = searchPreferences('account', PANES)
    expect(results[0].id).toBe('account')
  })

  it('ranks exact title equality above prefix matches', () => {
    const results = searchPreferences('general', PANES)
    expect(results[0].id).toBe('general')
  })

  it('returns no results for a query that matches nothing', () => {
    expect(searchPreferences('zzzzxxyy', PANES)).toEqual([])
  })

  it('supports fuzzy subsequence matching', () => {
    // "scrty" is a subsequence of "security".
    expect(ids('scrty')).toContain('security')
  })

  it('produces results sorted by descending score', () => {
    const results = searchPreferences('back', PANES)
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('only includes panes that are present in the provided list', () => {
    const limited: SearchablePane[] = [{ id: 'account', label: 'Account' }]
    // "theme" only maps to appearance, which is not in the limited list.
    expect(searchPreferences('theme', limited)).toEqual([])
  })
})
