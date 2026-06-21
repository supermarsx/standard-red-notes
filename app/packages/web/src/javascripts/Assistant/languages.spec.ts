import { COMMON_LANGUAGES, filterLanguages } from './languages'

describe('filterLanguages', () => {
  it('returns the full list for an empty or whitespace query', () => {
    expect(filterLanguages('')).toEqual(COMMON_LANGUAGES)
    expect(filterLanguages('   ')).toEqual(COMMON_LANGUAGES)
  })

  it('filters case-insensitively by substring', () => {
    expect(filterLanguages('span')).toEqual(['Spanish'])
    expect(filterLanguages('PORTUG')).toEqual(['Portuguese', 'Portuguese (Brazil)'])
  })

  it('returns an empty list when nothing matches (free-text language still allowed by caller)', () => {
    expect(filterLanguages('klingon')).toEqual([])
  })
})
