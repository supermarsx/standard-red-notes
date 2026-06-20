import { COLLABORATOR_PALETTE, collaboratorColor, collaboratorInitials } from './collaboratorColor'

describe('collaboratorColor', () => {
  it('always returns a color from the palette', () => {
    for (const id of ['a', 'user-1', '00000000-0000-0000-0000-000000000000', '🙂']) {
      expect(COLLABORATOR_PALETTE).toContain(collaboratorColor(id))
    }
  })

  it('is deterministic — the same id always maps to the same color', () => {
    const id = 'd290f1ee-6c54-4b01-90e6-d701748f0851'
    expect(collaboratorColor(id)).toBe(collaboratorColor(id))
  })

  it('maps the empty string to the first palette entry (hash 5381 % 8)', () => {
    // hashString('') === 5381; 5381 % 8 === 5
    expect(collaboratorColor('')).toBe(COLLABORATOR_PALETTE[5381 % COLLABORATOR_PALETTE.length])
  })

  it('distributes different ids across more than one color', () => {
    const colors = new Set(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'].map(collaboratorColor))
    expect(colors.size).toBeGreaterThan(1)
  })
})

describe('collaboratorInitials', () => {
  it('derives initials from the first two tokens of an email (splits on @ and .)', () => {
    // 'ada@x.com' splits into ['ada','x','com'] -> first letters of the first two.
    expect(collaboratorInitials('ada@x.com')).toBe('AX')
  })

  it('derives two initials from a multi-word email local part', () => {
    expect(collaboratorInitials('ada.lovelace@x.com')).toBe('AL')
  })

  it('derives initials from the first two whitespace-separated words', () => {
    expect(collaboratorInitials('Ada Lovelace')).toBe('AL')
  })

  it('splits on dots, underscores and hyphens', () => {
    expect(collaboratorInitials('ada.lovelace')).toBe('AL')
    expect(collaboratorInitials('ada_lovelace')).toBe('AL')
    expect(collaboratorInitials('ada-lovelace')).toBe('AL')
  })

  it('returns the uppercased first two characters for a single-word name', () => {
    expect(collaboratorInitials('ada')).toBe('AD')
  })

  it('uppercases a single-character name without padding', () => {
    expect(collaboratorInitials('a')).toBe('A')
  })

  it('trims surrounding whitespace before deriving initials', () => {
    expect(collaboratorInitials('  Ada Lovelace  ')).toBe('AL')
  })

  it('returns a placeholder for empty or whitespace-only input', () => {
    expect(collaboratorInitials('')).toBe('?')
    expect(collaboratorInitials('   ')).toBe('?')
  })
})
