/**
 * Unit tests for `buildInsertSections` — the pure mapping that drives the Insert
 * tab's always-visible captioned sections. It folds the catalog's eight
 * categories into seven ordered sections (Embeds + Advanced collapse into the
 * trailing "Others"), so we assert: the fixed order, representative membership,
 * the Embeds+Advanced fold, and — critically — that EVERY catalog entry lands in
 * exactly one section (no drops, no duplicates), since the sections replace the
 * former "insert anything" dropdown as the only toolbar surface for these blocks.
 */
import { BLOCK_CATALOG, buildInsertSections, INSERT_SECTION_ORDER, InsertSectionId } from './blockCatalog'

const sections = buildInsertSections(BLOCK_CATALOG)
const byId = (id: InsertSectionId) => sections.find((section) => section.id === id)
const namesIn = (id: InsertSectionId) => (byId(id)?.entries ?? []).map((entry) => entry.name)

describe('buildInsertSections', () => {
  it('returns exactly the seven sections in the fixed order', () => {
    expect(sections.map((section) => section.id)).toEqual([
      'basic',
      'lists',
      'media',
      'dataTables',
      'diagramsCharts',
      'finance',
      'others',
    ])
    // The exported order constant matches the built output.
    expect(sections.map((section) => section.id)).toEqual(INSERT_SECTION_ORDER)
  })

  it('places the Comment block in the Basic section (insertable annotation node)', () => {
    expect(namesIn('basic')).toContain('Comment')
    // Present in the flat catalog too, so both insert surfaces (toolbar + slash
    // picker) surface it — they derive from the same BLOCK_CATALOG.
    expect(BLOCK_CATALOG.some((entry) => entry.name === 'Comment')).toBe(true)
  })

  it('places the Symbol entry in the Basic section (opens the Insert -> Symbol picker)', () => {
    expect(namesIn('basic')).toContain('Symbol')
    // Present in the flat catalog too, so both insert surfaces surface it.
    const symbol = BLOCK_CATALOG.find((entry) => entry.key === 'Symbol')
    expect(symbol).toBeDefined()
    expect(symbol?.category).toBe('Basic')
  })

  it('places representative catalog items in their expected section', () => {
    expect(namesIn('basic')).toEqual(expect.arrayContaining(['Paragraph', 'Heading 1']))
    expect(namesIn('lists')).toContain('Bulleted List')
    expect(namesIn('media')).toEqual(expect.arrayContaining(['Upload file', 'Drawing']))
    expect(namesIn('dataTables')).toContain('Table')
    expect(namesIn('diagramsCharts')).toContain('Mermaid Diagram')
    expect(namesIn('finance')).toContain('TradingView Chart')
  })

  it('folds the Embeds and Advanced categories into "Others"', () => {
    // Embed is an Embeds-category block; Equation / Footnote / Table of Contents
    // are Advanced. All must surface under the single trailing Others section.
    expect(namesIn('others')).toEqual(
      expect.arrayContaining(['Embed', 'Shipment Tracking', 'Equation', 'Footnote', 'Table of Contents']),
    )
    // Nothing from Embeds/Advanced leaks into an earlier section.
    const nonOthers = sections.filter((section) => section.id !== 'others')
    for (const section of nonOthers) {
      for (const entry of section.entries) {
        expect(entry.category === 'Embeds' || entry.category === 'Advanced').toBe(false)
      }
    }
  })

  it('surfaces Shipment Tracking through the shared catalog as an Embed', () => {
    const shipmentTracking = BLOCK_CATALOG.find((entry) => entry.key === 'Shipment Tracking')
    expect(shipmentTracking).toBeDefined()
    expect(shipmentTracking?.category).toBe('Embeds')
    expect(namesIn('others')).toContain('Shipment Tracking')
  })

  it('assigns every catalog entry to exactly one section (no drops, no duplicates)', () => {
    const placedKeys = sections.flatMap((section) => section.entries.map((entry) => entry.key))
    // No entry appears twice.
    expect(new Set(placedKeys).size).toBe(placedKeys.length)
    // Every catalog entry is placed, and nothing extra is invented.
    expect(placedKeys.length).toBe(BLOCK_CATALOG.length)
    expect(new Set(placedKeys)).toEqual(new Set(BLOCK_CATALOG.map((entry) => entry.key)))
  })

  it('drops sections that would be empty', () => {
    // Feed only Finance entries: the result is a single `finance` section.
    const financeOnly = BLOCK_CATALOG.filter((entry) => entry.category === 'Finance')
    const result = buildInsertSections(financeOnly)
    expect(result.map((section) => section.id)).toEqual(['finance'])
    expect(result[0].entries.length).toBe(financeOnly.length)
  })
})
