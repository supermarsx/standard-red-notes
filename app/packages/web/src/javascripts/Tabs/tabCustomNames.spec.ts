/**
 * @jest-environment jsdom
 */
import {
  TAB_CUSTOM_NAMES_STORAGE_KEY,
  loadTabCustomNames,
  saveTabCustomNames,
  setTabCustomName,
  resolveTabLabel,
} from './tabCustomNames'

describe('tabCustomNames', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('setTabCustomName', () => {
    it('sets a trimmed custom name without mutating the input', () => {
      const original = {}
      const next = setTabCustomName(original, 'uuid-1', '  My Tab  ')
      expect(next).toEqual({ 'uuid-1': 'My Tab' })
      expect(original).toEqual({})
    })

    it('removes the entry when given an empty name (reverts to title fallback)', () => {
      const next = setTabCustomName({ 'uuid-1': 'Custom' }, 'uuid-1', '')
      expect(next).toEqual({})
    })

    it('removes the entry when given a whitespace-only name', () => {
      const next = setTabCustomName({ 'uuid-1': 'Custom' }, 'uuid-1', '   ')
      expect(next).toEqual({})
    })

    it('leaves other entries untouched', () => {
      const next = setTabCustomName({ a: 'A', b: 'B' }, 'b', 'B2')
      expect(next).toEqual({ a: 'A', b: 'B2' })
    })
  })

  describe('resolveTabLabel', () => {
    it('returns the custom name when one is set', () => {
      expect(resolveTabLabel({ 'uuid-1': 'Custom' }, 'uuid-1', 'Title')).toBe('Custom')
    })

    it('falls back to the title when no custom name exists', () => {
      expect(resolveTabLabel({}, 'uuid-1', 'Title')).toBe('Title')
    })

    it('falls back to the title when the custom name is whitespace-only', () => {
      expect(resolveTabLabel({ 'uuid-1': '   ' }, 'uuid-1', 'Title')).toBe('Title')
    })

    it('falls back to the title when uuid is undefined (e.g. template note)', () => {
      expect(resolveTabLabel({ 'uuid-1': 'Custom' }, undefined, 'Title')).toBe('Title')
    })
  })

  describe('persistence', () => {
    it('round-trips through localStorage', () => {
      saveTabCustomNames({ 'uuid-1': 'Custom' })
      expect(loadTabCustomNames()).toEqual({ 'uuid-1': 'Custom' })
    })

    it('returns an empty map when nothing is stored', () => {
      expect(loadTabCustomNames()).toEqual({})
    })

    it('returns an empty map when stored data is malformed JSON', () => {
      localStorage.setItem(TAB_CUSTOM_NAMES_STORAGE_KEY, '{not json')
      expect(loadTabCustomNames()).toEqual({})
    })

    it('returns an empty map when stored data is not a string record', () => {
      localStorage.setItem(TAB_CUSTOM_NAMES_STORAGE_KEY, JSON.stringify({ a: 5 }))
      expect(loadTabCustomNames()).toEqual({})
    })
  })
})
