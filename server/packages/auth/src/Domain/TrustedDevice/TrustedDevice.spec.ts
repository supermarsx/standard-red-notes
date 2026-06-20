import { TrustedDevice } from './TrustedDevice'

describe('TrustedDevice', () => {
  const baseProps = {
    userUuid: '00000000-0000-0000-0000-000000000000',
    hashedToken: 'hashed-token',
    label: 'Chrome on macOS',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastUsedAt: null,
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
  }

  it('should create a valid trusted device', () => {
    const result = TrustedDevice.create(baseProps)

    expect(result.isFailed()).toBe(false)
  })

  it('should fail when the user uuid is empty', () => {
    const result = TrustedDevice.create({ ...baseProps, userUuid: '' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail when the token hash is empty', () => {
    const result = TrustedDevice.create({ ...baseProps, hashedToken: '' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail when the label is empty', () => {
    const result = TrustedDevice.create({ ...baseProps, label: '' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail when the label is too long', () => {
    const result = TrustedDevice.create({ ...baseProps, label: 'a'.repeat(256) })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail when expiry is not after creation', () => {
    const result = TrustedDevice.create({
      ...baseProps,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(result.isFailed()).toBe(true)
  })

  it('should report not expired before its expiry', () => {
    const device = TrustedDevice.create(baseProps).getValue()

    expect(device.isExpired(new Date('2026-01-15T00:00:00.000Z'))).toBe(false)
  })

  it('should report expired at or after its expiry', () => {
    const device = TrustedDevice.create(baseProps).getValue()

    expect(device.isExpired(new Date('2026-02-01T00:00:00.000Z'))).toBe(true)
    expect(device.isExpired(new Date('2026-03-01T00:00:00.000Z'))).toBe(true)
  })
})
