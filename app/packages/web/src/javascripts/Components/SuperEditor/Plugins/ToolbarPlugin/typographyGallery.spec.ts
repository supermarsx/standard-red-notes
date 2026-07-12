/**
 * Tests for the pure fit/overflow math behind the responsive inline block-style
 * gallery bar: given the available track width and a square width, how many
 * squares render inline vs. spill into the overflow "▾" dropdown.
 */
import {
  computeGalleryFit,
  DEFAULT_GALLERY_ORDER,
  GALLERY_BLOCKS,
  GALLERY_LEADING_DIVIDER_WIDTH,
  GALLERY_LEADING_INDICATOR_WIDTH,
  GALLERY_SQUARE_GAP,
  GALLERY_SQUARE_WIDTH,
  orderGalleryBlocks,
  reorderGalleryKeys,
  resolveActiveGalleryKey,
} from './typographyGallery'
import type { BlockTypeKey } from '@standardnotes/models'
import { blockStyleToStyleEntries } from '@/Utils/typographyProfiles'

/** Resolve a saved order to its concrete key sequence (test convenience). */
const resolvedKeys = (order?: BlockTypeKey[] | null): BlockTypeKey[] =>
  orderGalleryBlocks(order).map((descriptor) => descriptor.key)

const S = GALLERY_SQUARE_WIDTH
const G = GALLERY_SQUARE_GAP

// Exact pixel width that fits exactly `n` squares (n*S + (n-1)*G).
const widthForExactly = (n: number): number => n * S + (n - 1) * G

describe('computeGalleryFit', () => {
  it('returns nothing for a non-positive total', () => {
    expect(computeGalleryFit({ containerWidth: 1000, total: 0 })).toEqual({ inlineCount: 0, overflowCount: 0 })
    expect(computeGalleryFit({ containerWidth: 1000, total: -3 })).toEqual({ inlineCount: 0, overflowCount: 0 })
  })

  it('shows all squares inline (no overflow) when they all fit', () => {
    // A generous width fits all 9 with room to spare → no toggle reserved.
    expect(computeGalleryFit({ containerWidth: 5000, total: 9 })).toEqual({ inlineCount: 9, overflowCount: 0 })
  })

  it('fits all inline at the exact width for the full set', () => {
    expect(computeGalleryFit({ containerWidth: widthForExactly(9), total: 9 })).toEqual({
      inlineCount: 9,
      overflowCount: 0,
    })
  })

  it('reserves the overflow toggle and spills the rest when not all fit', () => {
    // Width fits 5 squares outright, but total is 9, so 5 do not all fit → we
    // reserve the toggle (34+gap) and refit into the smaller track.
    const fit = computeGalleryFit({ containerWidth: widthForExactly(5), total: 9 })
    expect(fit.inlineCount).toBeGreaterThan(0)
    expect(fit.inlineCount).toBeLessThan(9)
    expect(fit.inlineCount + fit.overflowCount).toBe(9)
    // The reserved toggle costs one slot vs. the no-reserve fit-of-5.
    expect(fit.inlineCount).toBe(4)
  })

  it('never lets the inline run equal the total when overflowing (leaves room for the toggle)', () => {
    // A width one pixel short of fitting all 9 must overflow at least one.
    const fit = computeGalleryFit({ containerWidth: widthForExactly(9) - 1, total: 9 })
    expect(fit.overflowCount).toBeGreaterThanOrEqual(1)
    expect(fit.inlineCount).toBeLessThanOrEqual(8)
    expect(fit.inlineCount + fit.overflowCount).toBe(9)
  })

  it('degrades to all-overflow at very narrow widths', () => {
    expect(computeGalleryFit({ containerWidth: 0, total: 9 })).toEqual({ inlineCount: 0, overflowCount: 9 })
    expect(computeGalleryFit({ containerWidth: S - 1, total: 9 })).toEqual({ inlineCount: 0, overflowCount: 9 })
  })

  it('more squares fit inline as the container widens (monotonic)', () => {
    const counts = [3, 5, 7, 9].map(
      (n) => computeGalleryFit({ containerWidth: widthForExactly(n), total: 12 }).inlineCount,
    )
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
  })

  it('honours a custom square width / gap', () => {
    const fit = computeGalleryFit({ containerWidth: 200, total: 10, squareWidth: 40, gap: 0, overflowWidth: 0 })
    // 200 / 40 = 5 fit; total 10 → 5 inline, 5 overflow.
    expect(fit).toEqual({ inlineCount: 5, overflowCount: 5 })
  })
})

describe('GALLERY_LEADING_INDICATOR_WIDTH (leading "current style" slot reservation)', () => {
  it('is one square + a 1px divider, each flanked by the flex gap (88 + 1 + 12 = 101)', () => {
    expect(GALLERY_LEADING_INDICATOR_WIDTH).toBe(GALLERY_SQUARE_WIDTH + GALLERY_LEADING_DIVIDER_WIDTH + 2 * GALLERY_SQUARE_GAP)
    expect(GALLERY_LEADING_INDICATOR_WIDTH).toBe(101)
  })

  it('reserving the leading width costs exactly one inline square vs. the un-reduced track', () => {
    // With a large total (forces overflow in both cases), a 1000px track fits 10
    // inline; subtracting the leading indicator (1000 − 101 = 899) fits 9 — exactly
    // one fewer, the slot the persistent leading square occupies at the front.
    const total = 20
    const full = computeGalleryFit({ containerWidth: 1000, total })
    const reduced = computeGalleryFit({ containerWidth: 1000 - GALLERY_LEADING_INDICATOR_WIDTH, total })
    expect(full.inlineCount).toBe(10)
    expect(reduced.inlineCount).toBe(9)
    expect(full.inlineCount - reduced.inlineCount).toBe(1)
  })
})

describe('resolveActiveGalleryKey', () => {
  // Build the exact stamped inline style a variant produces (baseStyle only,
  // fresh profile) — the same pairs applied at click time.
  const styleStringFor = (key: string): string => {
    const base = GALLERY_BLOCKS.find((d) => d.key === key)?.baseStyle ?? {}
    return blockStyleToStyleEntries(base)
      .map(([prop, value]) => `${prop}: ${value}`)
      .join('; ')
  }

  it('maps a real heading block type directly to its gallery key (h4 → h4)', () => {
    expect(resolveActiveGalleryKey({ blockType: 'h4', style: '', profile: null })).toBe('h4')
  })

  it('maps a bullet list block type to bulletList', () => {
    expect(resolveActiveGalleryKey({ blockType: 'bullet', style: '', profile: null })).toBe('bulletList')
  })

  it('returns null for a block type with no gallery square (h6)', () => {
    expect(resolveActiveGalleryKey({ blockType: 'h6', style: '', profile: null })).toBeNull()
  })

  it('treats a plain paragraph with no stamped style as Normal (paragraph)', () => {
    expect(resolveActiveGalleryKey({ blockType: 'paragraph', style: '', profile: null })).toBe('paragraph')
  })

  it('detects the Emphasis variant from a paragraph carrying font-style: italic', () => {
    expect(resolveActiveGalleryKey({ blockType: 'paragraph', style: 'font-style: italic', profile: null })).toBe(
      'emphasis',
    )
  })

  it('detects the Title variant from a paragraph carrying its merged style', () => {
    expect(resolveActiveGalleryKey({ blockType: 'paragraph', style: styleStringFor('title'), profile: null })).toBe(
      'title',
    )
  })
})

describe('GALLERY_BLOCKS default order', () => {
  it('leads with Normal, Normal (spaced), the headings h1–h5, then Title', () => {
    expect(GALLERY_BLOCKS.map((d) => d.key).slice(0, 8)).toEqual([
      'paragraph',
      'normalSpaced',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'title',
    ])
  })

  it('DEFAULT_GALLERY_ORDER mirrors the GALLERY_BLOCKS key sequence', () => {
    expect(DEFAULT_GALLERY_ORDER).toEqual(GALLERY_BLOCKS.map((d) => d.key))
  })
})

describe('orderGalleryBlocks (merge rules)', () => {
  it('yields the full default order for empty / undefined / null', () => {
    expect(resolvedKeys([])).toEqual(DEFAULT_GALLERY_ORDER)
    expect(resolvedKeys(undefined)).toEqual(DEFAULT_GALLERY_ORDER)
    expect(resolvedKeys(null)).toEqual(DEFAULT_GALLERY_ORDER)
  })

  it('hoists a partial saved order, then appends the rest in default order (no dupes, full length)', () => {
    const out = resolvedKeys(['title', 'code'])
    expect(out.slice(0, 2)).toEqual(['title', 'code'])
    expect(out).toHaveLength(GALLERY_BLOCKS.length)
    expect(new Set(out).size).toBe(out.length)
    expect(out.slice(2)).toEqual(DEFAULT_GALLERY_ORDER.filter((k) => k !== 'title' && k !== 'code'))
  })

  it('drops unknown/stale keys and appends every real block in default order', () => {
    const out = resolvedKeys(['bogus' as BlockTypeKey, 'h1'])
    expect(out[0]).toBe('h1')
    expect(out).not.toContain('bogus')
    expect(out).toHaveLength(GALLERY_BLOCKS.length)
    expect(out.slice(1)).toEqual(DEFAULT_GALLERY_ORDER.filter((k) => k !== 'h1'))
  })

  it('collapses duplicate keys to the first occurrence', () => {
    const out = resolvedKeys(['code', 'code', 'h2'])
    expect(out.slice(0, 2)).toEqual(['code', 'h2'])
    expect(out).toHaveLength(GALLERY_BLOCKS.length)
    expect(new Set(out).size).toBe(out.length)
  })

  it('is idempotent: resolving an already-resolved full order is stable', () => {
    const once = resolvedKeys(['emphasis', 'title', 'bulletList'])
    expect(resolvedKeys(once)).toEqual(once)
  })
})

describe('reorderGalleryKeys (bounds-safe, immutable)', () => {
  const base: BlockTypeKey[] = ['paragraph', 'normalSpaced', 'h1', 'h2']

  it('moves a key down (+1) by swapping with its successor', () => {
    expect(reorderGalleryKeys(base, 'normalSpaced', 1)).toEqual(['paragraph', 'h1', 'normalSpaced', 'h2'])
  })

  it('moves a key up (-1) by swapping with its predecessor', () => {
    expect(reorderGalleryKeys(base, 'h1', -1)).toEqual(['paragraph', 'h1', 'normalSpaced', 'h2'])
  })

  it('is a no-op moving the first item up', () => {
    expect(reorderGalleryKeys(base, 'paragraph', -1)).toEqual(base)
  })

  it('is a no-op moving the last item down', () => {
    expect(reorderGalleryKeys(base, 'h2', 1)).toEqual(base)
  })

  it('returns an unchanged copy for an unknown key (never mutates input)', () => {
    const out = reorderGalleryKeys(base, 'code', 1)
    expect(out).toEqual(base)
    expect(out).not.toBe(base)
  })
})

describe('detection order is decoupled from display order (regression)', () => {
  // The gallery's DEFAULT order now leads with paragraph/normalSpaced and places
  // Title AFTER the headings, but resolveActiveGalleryKey disambiguates paragraph
  // variants via the SEPARATE fixed PARAGRAPH_VARIANT_PRIORITY (most-specific
  // first), NOT GALLERY_BLOCKS array order. So Title's 6-property superset must
  // still win over the 2-property normalSpaced/accented despite trailing them.
  const styleStringFor = (key: string): string => {
    const base = GALLERY_BLOCKS.find((d) => d.key === key)?.baseStyle ?? {}
    return blockStyleToStyleEntries(base)
      .map(([prop, value]) => `${prop}: ${value}`)
      .join('; ')
  }

  it('Title still wins over normalSpaced/accented even though it now trails them in display order', () => {
    expect(resolveActiveGalleryKey({ blockType: 'paragraph', style: styleStringFor('title'), profile: null })).toBe(
      'title',
    )
  })

  it('an italic paragraph still resolves to Emphasis', () => {
    expect(resolveActiveGalleryKey({ blockType: 'paragraph', style: 'font-style: italic', profile: null })).toBe(
      'emphasis',
    )
  })
})
