import { ContentType } from '@standardnotes/domain-core'
import { ItemHash } from './ItemHash'

describe('ItemHash', () => {
  it('should create a value object', () => {
    const valueOrError = ItemHash.create({
      uuid: '00000000-0000-0000-0000-000000000000',
      content_type: ContentType.TYPES.Note,
      user_uuid: '00000000-0000-0000-0000-000000000000',
      content: 'foobar',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      created_at_timestamp: 123,
      updated_at_timestamp: 123,
      key_system_identifier: null,
      shared_vault_uuid: null,
    })

    expect(valueOrError.isFailed()).toBeFalsy()
  })

  it('should return error if shared vault uuid is not valid', () => {
    const valueOrError = ItemHash.create({
      uuid: '00000000-0000-0000-0000-000000000000',
      content_type: ContentType.TYPES.Note,
      user_uuid: '00000000-0000-0000-0000-000000000000',
      content: 'foobar',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      created_at_timestamp: 123,
      updated_at_timestamp: 123,
      key_system_identifier: null,
      shared_vault_uuid: 'invalid',
    })

    expect(valueOrError.isFailed()).toBeTruthy()
  })

  /**
   * Standard Red Notes: a client must not be able to write a row its own syncs
   * can never read again. A `created_at_timestamp` past the safe-integer range
   * is a number, so `Timestamps.create` accepts it, the save paths adopt it
   * verbatim and MySQL hands the BIGINT back as a string that the persistence
   * mapper refuses — the row is then reported by an integrity check forever and
   * delivered by nothing. Refusing at this boundary costs the client a 400 it
   * can correct and costs the account nothing.
   */
  describe('timestamps a column cannot give back', () => {
    const hashWith = (timestamps: { created_at_timestamp?: number; updated_at_timestamp?: number }) =>
      ItemHash.create({
        uuid: '00000000-0000-0000-0000-000000000000',
        content_type: ContentType.TYPES.Note,
        user_uuid: '00000000-0000-0000-0000-000000000000',
        content: 'foobar',
        key_system_identifier: null,
        shared_vault_uuid: null,
        ...timestamps,
      })

    it('refuses a created_at_timestamp beyond the safe integer range', () => {
      // 1e17 microseconds is a date MySQL stores happily (year 5138) and a
      // BIGINT no JavaScript number can represent exactly, which is the whole
      // trap: nothing downstream notices until the row is read back.
      expect(hashWith({ created_at_timestamp: 100000000000000000 }).isFailed()).toBe(true)
    })

    it('refuses an updated_at_timestamp beyond the safe integer range', () => {
      expect(hashWith({ updated_at_timestamp: 100000000000000000 }).isFailed()).toBe(true)
    })

    it('refuses a fractional timestamp the column would silently truncate', () => {
      expect(hashWith({ created_at_timestamp: 1626435852000000.5 }).isFailed()).toBe(true)
    })

    it('refuses a timestamp that is not a finite number at all', () => {
      expect(hashWith({ created_at_timestamp: Number.NaN }).isFailed()).toBe(true)
      expect(hashWith({ created_at_timestamp: Number.POSITIVE_INFINITY }).isFailed()).toBe(true)
    })

    it('accepts the largest timestamp that still round trips, and the ordinary ones', () => {
      expect(hashWith({ created_at_timestamp: Number.MAX_SAFE_INTEGER }).isFailed()).toBe(false)
      expect(hashWith({ created_at_timestamp: 1626435852000000 }).isFailed()).toBe(false)
      expect(hashWith({ created_at_timestamp: 0, updated_at_timestamp: 0 }).isFailed()).toBe(false)
    })

    it('leaves an absent timestamp absent rather than inventing a rejection', () => {
      expect(hashWith({}).isFailed()).toBe(false)
      expect(
        hashWith({
          created_at_timestamp: undefined,
          updated_at_timestamp: undefined,
        }).isFailed(),
      ).toBe(false)
    })
  })
})
