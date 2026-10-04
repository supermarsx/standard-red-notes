/**
 * The Mermaid block's stored width/height is a SYNCED value: another client, an
 * older build, or a hand-edited note can put anything there. These tests pin
 * the two properties that matter for that — nothing throws, and nothing
 * unvalidated is ever handed back as a CSS string — plus the clamping ranges
 * and the bare-number decision (pixels).
 */
import {
  formatMermaidWidth,
  MAX_MERMAID_HEIGHT_PX,
  MAX_MERMAID_WIDTH_PERCENT,
  MAX_MERMAID_WIDTH_PX,
  MIN_MERMAID_HEIGHT_PX,
  MIN_MERMAID_WIDTH_PERCENT,
  MIN_MERMAID_WIDTH_PX,
  normalizeMermaidHeight,
  normalizeMermaidWidth,
  parseMermaidWidth,
  widthFromDrag,
} from './MermaidWidth'

describe('parseMermaidWidth — accepted spellings', () => {
  it('reads a percentage', () => {
    expect(parseMermaidWidth('50%')).toEqual({ value: 50, unit: '%' })
  })

  it('reads pixels', () => {
    expect(parseMermaidWidth('420px')).toEqual({ value: 420, unit: 'px' })
  })

  it('treats a BARE NUMBER as pixels, never as a percentage', () => {
    expect(parseMermaidWidth('420')).toEqual({ value: 420, unit: 'px' })
    // 90 as a percentage would be a legal width; it is still pixels, clamped up
    // to the floor, because "90" means ninety pixels.
    expect(parseMermaidWidth('90')).toEqual({ value: 90, unit: 'px' })
  })

  it('ignores surrounding whitespace and unit case', () => {
    expect(parseMermaidWidth('  60%  ')).toEqual({ value: 60, unit: '%' })
    expect(parseMermaidWidth('300PX')).toEqual({ value: 300, unit: 'px' })
  })

  it('keeps up to two decimals on a percentage', () => {
    expect(parseMermaidWidth('33.333333%')).toEqual({ value: 33.33, unit: '%' })
  })

  it('rounds pixels to whole device-independent pixels', () => {
    expect(parseMermaidWidth('420.6px')).toEqual({ value: 421, unit: 'px' })
  })
})

describe('parseMermaidWidth — clamping a value that is parseable but out of range', () => {
  it('clamps a percentage to the legible range', () => {
    expect(parseMermaidWidth('1%')).toEqual({ value: MIN_MERMAID_WIDTH_PERCENT, unit: '%' })
    expect(parseMermaidWidth('400%')).toEqual({ value: MAX_MERMAID_WIDTH_PERCENT, unit: '%' })
    expect(parseMermaidWidth('0%')).toEqual({ value: MIN_MERMAID_WIDTH_PERCENT, unit: '%' })
  })

  it('clamps pixels to the resizable range', () => {
    expect(parseMermaidWidth('4px')).toEqual({ value: MIN_MERMAID_WIDTH_PX, unit: 'px' })
    expect(parseMermaidWidth('999999px')).toEqual({ value: MAX_MERMAID_WIDTH_PX, unit: 'px' })
  })
})

describe('parseMermaidWidth — unparseable input falls back to fitting, and never throws', () => {
  // Everything a synced note, a hand edit, or a typo could realistically hold.
  const unparseable: unknown[] = [
    undefined,
    null,
    '',
    '   ',
    'auto',
    'fit',
    'half',
    '50 %',
    '50 px',
    '50em',
    '50rem',
    '50vw',
    '-20%',
    '+20%',
    '1e3px',
    '.5%',
    '50%%',
    '50px;color:red',
    'calc(100% - 10px)',
    '50%)',
    'NaN',
    'Infinity',
    420,
    50.5,
    true,
    false,
    {},
    [],
    ['50%'],
    { value: 50, unit: '%' },
    () => '50%',
    Symbol('50%'),
    NaN,
  ]

  it.each(
    unparseable.map((value) => [
      typeof value === 'symbol' ? 'Symbol(50%)' : (JSON.stringify(value) ?? String(value)),
      value,
    ]),
  )('returns null for %s without throwing', (_label, value) => {
    expect(() => parseMermaidWidth(value)).not.toThrow()
    expect(parseMermaidWidth(value)).toBeNull()
  })

  it('normalizes every one of those to undefined — i.e. fit the container', () => {
    for (const value of unparseable) {
      expect(normalizeMermaidWidth(value)).toBeUndefined()
    }
  })
})

describe('formatMermaidWidth / normalizeMermaidWidth — only self-constructed strings get out', () => {
  it('builds the canonical string from the parsed number and unit', () => {
    expect(formatMermaidWidth({ value: 50, unit: '%' })).toBe('50%')
    expect(formatMermaidWidth({ value: 420, unit: 'px' })).toBe('420px')
  })

  it('returns undefined for no width', () => {
    expect(formatMermaidWidth(null)).toBeUndefined()
    expect(formatMermaidWidth(undefined)).toBeUndefined()
  })

  it('never passes a dangerous payload through: an injection attempt is dropped entirely', () => {
    expect(normalizeMermaidWidth('50px; background:url(javascript:alert(1))')).toBeUndefined()
    expect(normalizeMermaidWidth('100%;position:fixed;inset:0')).toBeUndefined()
  })

  it('round-trips its own output unchanged (so a re-sync cannot drift)', () => {
    for (const stored of ['10%', '50%', '33.33%', '100%', '80px', '420px', '4000px']) {
      expect(normalizeMermaidWidth(stored)).toBe(stored)
    }
  })
})

describe('normalizeMermaidHeight', () => {
  it('clamps a stored height into the preview range', () => {
    expect(normalizeMermaidHeight(5)).toBe(MIN_MERMAID_HEIGHT_PX)
    expect(normalizeMermaidHeight(99999)).toBe(MAX_MERMAID_HEIGHT_PX)
    expect(normalizeMermaidHeight(320)).toBe(320)
  })

  it('rounds to whole pixels', () => {
    expect(normalizeMermaidHeight(320.7)).toBe(321)
  })

  it('returns undefined — auto-fit — for anything that is not a finite number', () => {
    for (const value of [undefined, null, '320', '320px', NaN, Infinity, -Infinity, {}, []]) {
      expect(normalizeMermaidHeight(value)).toBeUndefined()
    }
  })

  it('clamps a negative height up to the floor rather than returning a negative box', () => {
    expect(normalizeMermaidHeight(-500)).toBe(MIN_MERMAID_HEIGHT_PX)
  })
})

describe('widthFromDrag — a drag keeps the unit the block already uses', () => {
  it('converts a dragged pixel width to a percentage for a percentage-sized block', () => {
    expect(widthFromDrag(350, 700, '%')).toBe('50%')
  })

  it('keeps pixels for a pixel-sized block', () => {
    expect(widthFromDrag(350, 700, 'px')).toBe('350px')
  })

  it('falls back to pixels when the container width is unknown (0)', () => {
    expect(widthFromDrag(350, 0, '%')).toBe('350px')
  })

  it('clamps the dragged result like any other width', () => {
    expect(widthFromDrag(2, 700, 'px')).toBe(`${MIN_MERMAID_WIDTH_PX}px`)
    expect(widthFromDrag(1400, 700, '%')).toBe(`${MAX_MERMAID_WIDTH_PERCENT}%`)
  })
})
