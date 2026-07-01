import { predicateFromJson } from '@standardnotes/snjs'
import { PredicateKeypath, PredicateKeypathTypes } from './PredicateKeypaths'
import {
  booleanStatementLabel,
  booleanValueIsTrue,
  dateModeFromPredicate,
  defaultOperatorForType,
  friendlyOperatorsForType,
  getFieldGroups,
  isBuilderCompatiblePredicate,
  isRelativeDateValue,
  predicatePartsForDateMode,
  RelativeDateOptions,
  toDateInputValue,
} from './friendlyPredicate'

describe('friendlyPredicate', () => {
  describe('getFieldGroups', () => {
    const groups = getFieldGroups()

    it('groups fields into human categories', () => {
      expect(groups.map((group) => group.label)).toEqual(['Content', 'Status', 'Dates', 'Type', 'Advanced'])
    })

    it('covers every supported keypath exactly once with a label and description', () => {
      const keypaths = groups.flatMap((group) => group.fields.map((field) => field.keypath))
      const expected = Object.keys(PredicateKeypathTypes) as PredicateKeypath[]
      expect(new Set(keypaths)).toEqual(new Set(expected))
      expect(keypaths.length).toBe(expected.length)

      for (const group of groups) {
        for (const field of group.fields) {
          expect(field.label.length).toBeGreaterThan(0)
          expect(field.description.length).toBeGreaterThan(0)
        }
      }
    })
  })

  describe('friendlyOperatorsForType', () => {
    it('maps string operators to plain phrases (no raw symbols in labels)', () => {
      const ops = friendlyOperatorsForType('string')
      expect(ops.find((op) => op.operator === 'includes')?.label).toBe('contains')
      expect(ops.find((op) => op.operator === '=')?.label).toBe('is exactly')
      expect(ops.find((op) => op.operator === 'startsWith')?.label).toBe('starts with')
      expect(ops.find((op) => op.operator === '!=')?.label).toBe('is not')
      // The regex option is clearly labeled as advanced.
      expect(ops.find((op) => op.operator === 'matches')?.label).toMatch(/regex/i)
    })

    it('maps number operators to comparison phrases', () => {
      const ops = friendlyOperatorsForType('number')
      expect(ops.map((op) => [op.operator, op.label])).toEqual([
        ['>', 'is more than'],
        ['<', 'is less than'],
        ['=', 'equals'],
      ])
    })

    it('maps date operators to before/after phrases', () => {
      const ops = friendlyOperatorsForType('date')
      expect(ops.find((op) => op.operator === '>')?.label).toBe('is after')
      expect(ops.find((op) => op.operator === '<')?.label).toBe('is before')
    })

    it('maps type fields to is / is not', () => {
      for (const type of ['noteType', 'editorIdentifier'] as const) {
        const ops = friendlyOperatorsForType(type)
        expect(ops.map((op) => op.label)).toEqual(['is', 'is not'])
      }
    })

    it('never exposes a raw operator symbol as a label', () => {
      const rawSymbols = ['=', '!=', '<', '>', '<=', '>=']
      for (const type of ['string', 'number', 'date', 'boolean', 'noteType', 'editorIdentifier'] as const) {
        for (const op of friendlyOperatorsForType(type)) {
          expect(rawSymbols).not.toContain(op.label)
        }
      }
    })

    it('exposes a stable default operator per type', () => {
      expect(defaultOperatorForType('string')).toBe('includes')
      expect(defaultOperatorForType('number')).toBe('>')
      expect(defaultOperatorForType('date')).toBe('>')
      expect(defaultOperatorForType('boolean')).toBe('=')
    })
  })

  describe('boolean helpers', () => {
    it('renders a plain statement label for boolean fields', () => {
      expect(booleanStatementLabel('pinned')).toBe('Is pinned')
      expect(booleanStatementLabel('trashed')).toBe('Is in the trash')
    })

    it('normalizes boolean and string values', () => {
      expect(booleanValueIsTrue(true)).toBe(true)
      expect(booleanValueIsTrue('true')).toBe(true)
      expect(booleanValueIsTrue(false)).toBe(false)
      expect(booleanValueIsTrue('false')).toBe(false)
    })
  })

  describe('relative date helper', () => {
    it('offers relative presets whose values are valid model date DSL strings', () => {
      const dsl = /^\d+\.(days|hours|months|years)\.ago$/
      for (const option of RelativeDateOptions) {
        expect(option.value).toMatch(dsl)
        expect(isRelativeDateValue(option.value)).toBe(true)
      }
    })

    it('produces relative-date predicates the real parser accepts', () => {
      for (const option of RelativeDateOptions) {
        expect(() =>
          predicateFromJson({ keypath: 'userModifiedDate', operator: '>', value: option.value }),
        ).not.toThrow()
      }
    })

    it('detects relative vs exact values', () => {
      expect(isRelativeDateValue('7.days.ago')).toBe(true)
      expect(isRelativeDateValue('2022-06-01')).toBe(false)
      expect(isRelativeDateValue(0)).toBe(false)
    })

    it('derives the correct date UI mode from a stored predicate', () => {
      expect(dateModeFromPredicate('>', '7.days.ago')).toBe('inLast')
      expect(dateModeFromPredicate('>', '2022-06-01')).toBe('after')
      expect(dateModeFromPredicate('<', '2022-06-01')).toBe('before')
    })

    it('maps a date mode to the matching operator + value', () => {
      expect(predicatePartsForDateMode('inLast')).toEqual({ operator: '>', value: '7.days.ago' })
      expect(predicatePartsForDateMode('after').operator).toBe('>')
      expect(predicatePartsForDateMode('before').operator).toBe('<')
    })

    it('formats a date for an <input type="date">', () => {
      expect(toDateInputValue(new Date('2022-06-01T12:00:00'))).toBe('2022-06-01')
    })
  })

  describe('isBuilderCompatiblePredicate', () => {
    it('accepts simple leaf predicates on supported keypaths', () => {
      expect(isBuilderCompatiblePredicate({ keypath: 'pinned', operator: '=', value: true })).toBe(true)
      expect(isBuilderCompatiblePredicate({ keypath: 'text.length', operator: '>', value: 1000 })).toBe(true)
    })

    it('accepts compound predicates whose leaves are all compatible', () => {
      expect(
        isBuilderCompatiblePredicate({
          operator: 'and',
          value: [
            { keypath: 'trashed', operator: '=', value: false },
            { keypath: 'text', operator: 'includes', value: 'todo' },
          ],
        }),
      ).toBe(true)
    })

    it('rejects predicates with nested object values (e.g. tags includes {...})', () => {
      expect(
        isBuilderCompatiblePredicate({
          keypath: 'tags',
          operator: 'includes',
          value: { keypath: 'title', operator: '=', value: 'todo' },
        }),
      ).toBe(false)
    })

    it('rejects unsupported keypaths', () => {
      expect(isBuilderCompatiblePredicate({ keypath: 'tags', operator: '=', value: 'x' })).toBe(false)
    })
  })
})
