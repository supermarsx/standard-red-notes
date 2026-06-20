/**
 * @jest-environment jsdom
 *
 * Home config: local persistence + normalization + deleted-target pruning + reorder.
 *
 * Persistence uses localStorage (not a synced PrefKey) because adding a PrefKey would
 * require touching @standardnotes/models, which is off-limits for this web-only change.
 */
import {
  createHomeCardId,
  DEFAULT_HOME_CONFIG,
  HomeCard,
  HomeConfig,
  loadHomeConfig,
  normalizeHomeConfig,
  pruneMissingTargets,
  reorderCards,
  saveHomeConfig,
} from './homeConfigStorage'

const STORAGE_KEY = 'standardnotes.homeConfig.v1'

const card = (overrides: Partial<HomeCard> = {}): HomeCard => ({
  id: 'home_1',
  kind: 'note',
  targetUuid: 'note-uuid',
  ...overrides,
})

describe('normalizeHomeConfig', () => {
  it('returns the canonical default for non-object input', () => {
    expect(normalizeHomeConfig(null)).toEqual(DEFAULT_HOME_CONFIG)
    expect(normalizeHomeConfig('nope')).toEqual(DEFAULT_HOME_CONFIG)
    expect(normalizeHomeConfig(42)).toEqual(DEFAULT_HOME_CONFIG)
  })

  it('falls back to default mode for an unknown mode', () => {
    expect(normalizeHomeConfig({ mode: 'frobnicate', cards: [] }).mode).toBe('default')
  })

  it('keeps a valid mode and a non-empty noteUuid', () => {
    const result = normalizeHomeConfig({ mode: 'note', noteUuid: 'n1', cards: [] })
    expect(result.mode).toBe('note')
    expect(result.noteUuid).toBe('n1')
  })

  it('drops an empty-string noteUuid', () => {
    expect(normalizeHomeConfig({ mode: 'note', noteUuid: '', cards: [] }).noteUuid).toBeUndefined()
  })

  it('coerces a missing cards array to []', () => {
    expect(normalizeHomeConfig({ mode: 'cards' }).cards).toEqual([])
  })

  it('drops malformed cards and unknown kinds', () => {
    const result = normalizeHomeConfig({
      mode: 'cards',
      cards: [
        card({ id: 'good', kind: 'tag', targetUuid: 'tag-x' }),
        { id: 'bad-kind', kind: 'wormhole', targetUuid: 'tag-y' },
        { id: 'no-target', kind: 'note' },
        'not-an-object',
      ],
    })
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0].id).toBe('good')
  })
})

describe('pruneMissingTargets', () => {
  const exists = (live: string[]) => (uuid: string) => live.includes(uuid)

  it('removes cards whose target no longer exists', () => {
    const config: HomeConfig = {
      mode: 'cards',
      cards: [card({ id: 'a', targetUuid: 'alive' }), card({ id: 'b', targetUuid: 'dead' })],
    }
    const result = pruneMissingTargets(config, exists(['alive']))
    expect(result.cards.map((c) => c.id)).toEqual(['a'])
  })

  it('clears noteUuid and falls back to default mode when the home note is gone', () => {
    const config: HomeConfig = { mode: 'note', noteUuid: 'dead', cards: [] }
    const result = pruneMissingTargets(config, exists([]))
    expect(result.noteUuid).toBeUndefined()
    expect(result.mode).toBe('default')
  })

  it('keeps noteUuid + mode when the home note still exists', () => {
    const config: HomeConfig = { mode: 'note', noteUuid: 'alive', cards: [] }
    const result = pruneMissingTargets(config, exists(['alive']))
    expect(result.noteUuid).toBe('alive')
    expect(result.mode).toBe('note')
  })

  it('does not force-default when noteUuid is gone but mode is cards', () => {
    const config: HomeConfig = { mode: 'cards', noteUuid: 'dead', cards: [] }
    const result = pruneMissingTargets(config, exists([]))
    expect(result.mode).toBe('cards')
    expect(result.noteUuid).toBeUndefined()
  })
})

describe('reorderCards', () => {
  const cards = [card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c' })]

  it('moves a card up', () => {
    expect(reorderCards(cards, 1, -1).map((c) => c.id)).toEqual(['b', 'a', 'c'])
  })

  it('moves a card down', () => {
    expect(reorderCards(cards, 1, 1).map((c) => c.id)).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op at the boundaries', () => {
    expect(reorderCards(cards, 0, -1)).toBe(cards)
    expect(reorderCards(cards, 2, 1)).toBe(cards)
  })

  it('does not mutate the input array', () => {
    const input = [...cards]
    reorderCards(input, 1, -1)
    expect(input.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('load/save round-trip', () => {
  beforeEach(() => localStorage.clear())

  it('returns the default when nothing is stored', () => {
    expect(loadHomeConfig()).toEqual(DEFAULT_HOME_CONFIG)
  })

  it('persists and restores a config', () => {
    const config: HomeConfig = {
      mode: 'cards',
      noteUuid: undefined,
      cards: [card({ id: 'a', kind: 'note', targetUuid: 'n1', label: 'Welcome' }), card({ id: 'b', kind: 'tag', targetUuid: 't1' })],
    }
    saveHomeConfig(config)
    expect(loadHomeConfig()).toEqual(config)
  })

  it('falls back to default when stored JSON is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{ not json')
    expect(loadHomeConfig()).toEqual(DEFAULT_HOME_CONFIG)
  })

  it('normalizes a stored value that is not an object-shaped config', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(loadHomeConfig()).toEqual(DEFAULT_HOME_CONFIG)
  })
})

describe('createHomeCardId', () => {
  it('produces unique-ish ids', () => {
    expect(createHomeCardId()).not.toBe(createHomeCardId())
    expect(createHomeCardId().startsWith('home_')).toBe(true)
  })
})
