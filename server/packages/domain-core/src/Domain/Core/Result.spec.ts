import { Result } from './Result'

describe('Result', () => {
  describe('Result.ok', () => {
    it('should create a successful result that is not failed', () => {
      const result = Result.ok<number>(42)

      expect(result.isFailed()).toBeFalsy()
      expect(result.getValue()).toEqual(42)
    })

    it('should allow a successful result with no value (undefined)', () => {
      const result = Result.ok()

      expect(result.isFailed()).toBeFalsy()
      expect(result.getValue()).toBeUndefined()
    })

    it('should preserve falsy values such as 0, empty string and false', () => {
      expect(Result.ok<number>(0).getValue()).toEqual(0)
      expect(Result.ok<string>('').getValue()).toEqual('')
      expect(Result.ok<boolean>(false).getValue()).toEqual(false)
    })

    it('should throw when getting the error of a successful result', () => {
      const result = Result.ok<number>(1)

      expect(() => result.getError()).toThrow('Cannot get an error of a successfull result')
    })
  })

  describe('Result.fail', () => {
    it('should create a failed result', () => {
      const result = Result.fail<number>('boom')

      expect(result.isFailed()).toBeTruthy()
      expect(result.getError()).toEqual('boom')
    })

    it('should throw when getting the value of a failed result, embedding the error message', () => {
      const result = Result.fail<number>('boom')

      expect(() => result.getValue()).toThrow('Cannot get value of an unsuccessfull result: boom')
    })

    it('should treat an empty-string error as a valid failure', () => {
      const result = Result.fail<number>('')

      expect(result.isFailed()).toBeTruthy()
      // error === '' is falsy, so getError throws because error === undefined is the only guard,
      // but '' !== undefined, so it returns the empty string
      expect(result.getError()).toEqual('')
    })
  })

  describe('immutability', () => {
    it('should be frozen after construction', () => {
      const result = Result.ok<number>(1)

      expect(Object.isFrozen(result)).toBeTruthy()
    })
  })
})
