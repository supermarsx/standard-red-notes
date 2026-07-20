import { classNames } from './ClassNames'

describe('classNames', () => {
  it('should join the string values with a space', () => {
    expect(classNames('a', 'b', 'c')).toBe('a b c')
  })

  it('should drop null, undefined and boolean values', () => {
    expect(classNames('a', null, undefined, false, true, 'b')).toBe('a b')
  })

  it('should return an empty string when nothing is supplied', () => {
    expect(classNames()).toBe('')
  })

  it('should return an empty string when every value is dropped', () => {
    expect(classNames(false, null, undefined)).toBe('')
  })

  it('should keep an empty string value, producing a leading separator', () => {
    expect(classNames('', 'b')).toBe(' b')
  })
})
