import {
  CustomThemesState,
  buildCustomThemeCss,
  customThemesReducer,
  generateCustomThemeVariables,
  hasReadableContrast,
  isCustomThemeId,
  isValidHexColor,
  normalizeCustomTheme,
  normalizeCustomThemeColors,
  normalizeCustomThemeList,
  normalizeHexColor,
} from './CustomTheme'

describe('CustomTheme hex validation + normalization', () => {
  it('accepts valid 3 and 6 digit hex colors', () => {
    expect(isValidHexColor('#fff')).toBe(true)
    expect(isValidHexColor('#FFFFFF')).toBe(true)
    expect(isValidHexColor('#086dd6')).toBe(true)
  })

  it('rejects invalid colors', () => {
    expect(isValidHexColor('fff')).toBe(false)
    expect(isValidHexColor('#gggggg')).toBe(false)
    expect(isValidHexColor('#1234')).toBe(false)
    expect(isValidHexColor(42 as unknown)).toBe(false)
  })

  it('expands 3-digit hex to 6 and lowercases', () => {
    expect(normalizeHexColor('#ABC', '#000000')).toBe('#aabbcc')
    expect(normalizeHexColor('#086DD6', '#000000')).toBe('#086dd6')
  })

  it('falls back when the input is invalid', () => {
    expect(normalizeHexColor('not-a-color', '#123456')).toBe('#123456')
    expect(normalizeHexColor('', '#123456')).toBe('#123456')
  })

  it('fills missing color fields with defaults', () => {
    const result = normalizeCustomThemeColors({ accent: '#ff0000' })
    expect(result.accent).toBe('#ff0000')
    expect(result.background).toBe('#ffffff')
    expect(result.foreground).toBe('#19191c')
    expect(result.contrast).toBe('#f4f5f7')
  })
})

describe('normalizeCustomTheme / list', () => {
  it('returns null for non-objects', () => {
    expect(normalizeCustomTheme('x')).toBeNull()
    expect(normalizeCustomTheme(null)).toBeNull()
  })

  it('preserves id and name and coerces colors', () => {
    const theme = normalizeCustomTheme({ id: 'custom-theme:abc', name: '  My Theme  ', colors: { accent: '#abc' } })
    expect(theme?.id).toBe('custom-theme:abc')
    expect(theme?.name).toBe('My Theme')
    expect(theme?.colors.accent).toBe('#aabbcc')
  })

  it('generates an id and default name when missing', () => {
    const theme = normalizeCustomTheme({ colors: {} })
    expect(isCustomThemeId(theme?.id)).toBe(true)
    expect(theme?.name).toBe('Custom Theme')
  })

  it('drops unusable entries from a list', () => {
    const list = normalizeCustomThemeList([{ name: 'A', colors: {} }, 'bad', null, { name: 'B', colors: {} }])
    expect(list).toHaveLength(2)
    expect(list[0].name).toBe('A')
    expect(list[1].name).toBe('B')
  })

  it('returns empty array for non-array input', () => {
    expect(normalizeCustomThemeList('nope')).toEqual([])
  })
})

describe('generateCustomThemeVariables', () => {
  const colors = {
    accent: '#086dd6',
    background: '#ffffff',
    foreground: '#19191c',
    contrast: '#f4f5f7',
  }

  it('maps the accent to the info/highlight tokens (headline feature)', () => {
    const vars = generateCustomThemeVariables(colors)
    expect(vars['--sn-stylekit-info-color']).toBe('#086dd6')
    expect(vars['--highlight-color']).toBe('#086dd6')
    expect(vars['--accent-color']).toBe('#086dd6')
  })

  it('maps background/foreground/contrast tokens', () => {
    const vars = generateCustomThemeVariables(colors)
    expect(vars['--sn-stylekit-background-color']).toBe('#ffffff')
    expect(vars['--sn-stylekit-foreground-color']).toBe('#19191c')
    expect(vars['--sn-stylekit-contrast-background-color']).toBe('#f4f5f7')
  })

  it('chooses a readable accent contrast color', () => {
    const lightAccent = generateCustomThemeVariables({ ...colors, accent: '#ffff00' })
    expect(lightAccent['--sn-stylekit-info-contrast-color']).toBe('#000000')
    const darkAccent = generateCustomThemeVariables({ ...colors, accent: '#000080' })
    expect(darkAccent['--sn-stylekit-info-contrast-color']).toBe('#ffffff')
  })

  it('sets theme-type based on background lightness', () => {
    expect(generateCustomThemeVariables({ ...colors, background: '#ffffff' })['--sn-stylekit-theme-type']).toBe('light')
    expect(generateCustomThemeVariables({ ...colors, background: '#101010' })['--sn-stylekit-theme-type']).toBe('dark')
  })

  it('normalizes invalid colors before generating', () => {
    const vars = generateCustomThemeVariables({ accent: 'garbage', background: '#000', foreground: '#fff', contrast: '#abc' } as never)
    expect(vars['--sn-stylekit-info-color']).toBe('#086dd6') // default accent
    expect(vars['--sn-stylekit-background-color']).toBe('#000000')
  })
})

describe('buildCustomThemeCss', () => {
  it('produces a :root block with stylekit variables', () => {
    const css = buildCustomThemeCss({ accent: '#ff0000', background: '#ffffff', foreground: '#000000', contrast: '#eeeeee' })
    expect(css.startsWith(':root {')).toBe(true)
    expect(css).toContain('--sn-stylekit-info-color: #ff0000;')
    expect(css.trimEnd().endsWith('}')).toBe(true)
  })
})

describe('hasReadableContrast', () => {
  it('flags black on white as readable and grey on white as not', () => {
    expect(hasReadableContrast('#000000', '#ffffff')).toBe(true)
    expect(hasReadableContrast('#cccccc', '#ffffff')).toBe(false)
  })
})

describe('customThemesReducer', () => {
  const empty: CustomThemesState = { themes: [], selectedId: null }
  const baseColors = { accent: '#086dd6', background: '#ffffff', foreground: '#000000', contrast: '#eeeeee' }

  it('adds a theme and can auto-select it', () => {
    const next = customThemesReducer(empty, { type: 'add', name: 'Ocean', colors: baseColors, select: true })
    expect(next.themes).toHaveLength(1)
    expect(next.themes[0].name).toBe('Ocean')
    expect(next.selectedId).toBe(next.themes[0].id)
  })

  it('adds without selecting when select is not set', () => {
    const next = customThemesReducer(empty, { type: 'add', name: 'Ocean', colors: baseColors })
    expect(next.selectedId).toBeNull()
  })

  it('falls back to a default name when blank', () => {
    const next = customThemesReducer(empty, { type: 'add', name: '   ', colors: baseColors })
    expect(next.themes[0].name).toBe('Custom Theme')
  })

  it('updates name and colors of an existing theme', () => {
    const added = customThemesReducer(empty, { type: 'add', name: 'A', colors: baseColors })
    const id = added.themes[0].id
    const updated = customThemesReducer(added, { type: 'update', id, name: 'B', colors: { ...baseColors, accent: '#ff0000' } })
    expect(updated.themes[0].name).toBe('B')
    expect(updated.themes[0].colors.accent).toBe('#ff0000')
  })

  it('keeps the existing name when update name is blank', () => {
    const added = customThemesReducer(empty, { type: 'add', name: 'Keep', colors: baseColors })
    const id = added.themes[0].id
    const updated = customThemesReducer(added, { type: 'update', id, name: '   ' })
    expect(updated.themes[0].name).toBe('Keep')
  })

  it('deletes a theme and clears selection if it was selected', () => {
    const added = customThemesReducer(empty, { type: 'add', name: 'A', colors: baseColors, select: true })
    const id = added.themes[0].id
    const deleted = customThemesReducer(added, { type: 'delete', id })
    expect(deleted.themes).toHaveLength(0)
    expect(deleted.selectedId).toBeNull()
  })

  it('selects null (built-in theme) cleanly', () => {
    const added = customThemesReducer(empty, { type: 'add', name: 'A', colors: baseColors, select: true })
    const cleared = customThemesReducer(added, { type: 'select', id: null })
    expect(cleared.selectedId).toBeNull()
    expect(cleared.themes).toHaveLength(1)
  })

  it('ignores selecting an unknown id', () => {
    const added = customThemesReducer(empty, { type: 'add', name: 'A', colors: baseColors })
    const same = customThemesReducer(added, { type: 'select', id: 'custom-theme:does-not-exist' })
    expect(same).toBe(added)
  })

  it('replaces the whole state', () => {
    const replacement: CustomThemesState = {
      themes: [{ id: 'custom-theme:x', name: 'X', colors: baseColors }],
      selectedId: 'custom-theme:x',
    }
    expect(customThemesReducer(empty, { type: 'replace', state: replacement })).toBe(replacement)
  })
})
