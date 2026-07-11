/**
 * Tests for the pure fit/overflow math behind the responsive inline block-style
 * gallery bar: given the available track width and a square width, how many
 * squares render inline vs. spill into the overflow "▾" dropdown.
 */
import {
  computeGalleryFit,
  GALLERY_BLOCKS,
  GALLERY_SQUARE_GAP,
  GALLERY_SQUARE_WIDTH,
  resolveActiveGalleryKey,
} from './typographyGallery'
import { blockStyleToStyleEntries } from '@/Utils/typographyProfiles'

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
