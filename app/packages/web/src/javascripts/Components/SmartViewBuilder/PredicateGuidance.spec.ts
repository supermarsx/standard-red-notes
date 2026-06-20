import { predicateFromJson } from '@standardnotes/snjs'
import {
  getPredicatePresets,
  presetToJsonString,
  validatePredicateJsonString,
} from './PredicateGuidance'

describe('PredicateGuidance', () => {
  describe('presets', () => {
    const presets = getPredicatePresets()

    it('produces a non-empty list of presets', () => {
      expect(presets.length).toBeGreaterThan(0)
    })

    it.each(presets.map((preset) => [preset.label, preset]))(
      'preset "%s" parses with the real predicate parser',
      (_label, preset) => {
        expect(() => predicateFromJson(preset.predicate)).not.toThrow()
        const parsed = predicateFromJson(preset.predicate)
        expect(parsed).toBeDefined()
        // The parsed predicate should be able to serialize back to JSON form.
        expect(parsed.toJson()).toBeDefined()
      },
    )

    it('serializes each preset to valid JSON that also passes string validation', () => {
      for (const preset of presets) {
        const jsonString = presetToJsonString(preset)
        expect(() => JSON.parse(jsonString)).not.toThrow()
        expect(validatePredicateJsonString(jsonString).isValid).toBe(true)
      }
    })

    it('substitutes the example tag title into tag-related presets', () => {
      const presetsForTag = getPredicatePresets('work')
      const tagPreset = presetsForTag.find((preset) => preset.label.includes('work'))
      expect(tagPreset).toBeDefined()
    })
  })

  describe('validatePredicateJsonString', () => {
    it('reports empty input as invalid with a helpful message', () => {
      const result = validatePredicateJsonString('')
      expect(result.isValid).toBe(false)
      expect(result.error).toMatch(/predicate/i)
    })

    it('reports malformed JSON as invalid', () => {
      const result = validatePredicateJsonString('{ not valid json')
      expect(result.isValid).toBe(false)
      expect(result.error).toMatch(/json/i)
    })

    it('rejects a top-level array', () => {
      const result = validatePredicateJsonString('["tags", "includes", ["title", "=", "todo"]]')
      expect(result.isValid).toBe(false)
      expect(result.error).toMatch(/array/i)
    })

    it('rejects an object missing an operator', () => {
      const result = validatePredicateJsonString('{ "keypath": "pinned", "value": true }')
      expect(result.isValid).toBe(false)
      expect(result.error).toMatch(/operator/i)
    })

    it('accepts a valid simple predicate', () => {
      const result = validatePredicateJsonString('{ "keypath": "pinned", "operator": "=", "value": true }')
      expect(result.isValid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('accepts a valid compound predicate', () => {
      const result = validatePredicateJsonString(
        JSON.stringify({
          operator: 'and',
          value: [
            { keypath: 'trashed', operator: '=', value: false },
            { keypath: 'pinned', operator: '=', value: true },
          ],
        }),
      )
      expect(result.isValid).toBe(true)
    })
  })
})
