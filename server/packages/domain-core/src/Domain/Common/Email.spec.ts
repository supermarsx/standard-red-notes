import { Email } from './Email'

describe('Email', () => {
  it('should create a value object', () => {
    const valueOrError = Email.create('test@test.te')

    expect(valueOrError.isFailed()).toBeFalsy()
    expect(valueOrError.getValue().value).toEqual('test@test.te')
  })

  it('should not create an invalid value object', () => {
    const valueOrError = Email.create('foobar')

    expect(valueOrError.isFailed()).toBeTruthy()
  })

  it('should not create an invalid type object', () => {
    const valueOrError = Email.create(undefined as unknown as string)

    expect(valueOrError.isFailed()).toBeTruthy()
  })

  describe('edge cases', () => {
    it('should reject an empty string', () => {
      expect(Email.create('').isFailed()).toBeTruthy()
    })

    it('should reject a whitespace-only string', () => {
      expect(Email.create('   ').isFailed()).toBeTruthy()
      expect(Email.create('\t\n').isFailed()).toBeTruthy()
    })

    it('should reject an address with a missing @', () => {
      expect(Email.create('testtest.te').isFailed()).toBeTruthy()
    })

    it('should reject an address with multiple @', () => {
      expect(Email.create('foo@bar@test.te').isFailed()).toBeTruthy()
    })

    it('should trim leading and trailing spaces', () => {
      const valueOrError = Email.create('  test@test.te  ')

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().value).toEqual('test@test.te')
    })

    it('should lowercase the email address', () => {
      const valueOrError = Email.create('TEST@Test.TE')

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().value).toEqual('test@test.te')
    })

    it('should accept plus-addressing', () => {
      const valueOrError = Email.create('user+tag@test.te')

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().value).toEqual('user+tag@test.te')
    })

    it('should accept a very long email (>255 chars) since there is no length cap', () => {
      const longLocal = 'a'.repeat(300)
      const valueOrError = Email.create(`${longLocal}@test.te`)

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().value.length).toBeGreaterThan(255)
    })

    it('should reject a unicode/IDN domain (regex only allows ASCII letters)', () => {
      expect(Email.create('user@exämple.te').isFailed()).toBeTruthy()
      expect(Email.create('user@例え.テスト').isFailed()).toBeTruthy()
    })

    it('should reject an address ending in a single-char TLD', () => {
      expect(Email.create('user@test.t').isFailed()).toBeTruthy()
    })

    it('should accept a bracketed IP-literal domain', () => {
      const valueOrError = Email.create('user@[127.0.0.1]')

      expect(valueOrError.isFailed()).toBeFalsy()
      expect(valueOrError.getValue().value).toEqual('user@[127.0.0.1]')
    })
  })
})
