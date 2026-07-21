import { ProtocolVersion, leftVersionGreaterThanOrEqualToRight } from './ProtocolVersion'

describe('ProtocolVersion', () => {
  it('should serialize each version to its zero-padded wire value', () => {
    expect(ProtocolVersion.V001).toEqual('001')
    expect(ProtocolVersion.V002).toEqual('002')
    expect(ProtocolVersion.V003).toEqual('003')
    expect(ProtocolVersion.V004).toEqual('004')
  })

  it('should expose exactly the four known protocol versions', () => {
    expect(Object.values(ProtocolVersion)).toEqual(['001', '002', '003', '004'])
  })
})

describe('leftVersionGreaterThanOrEqualToRight', () => {
  it('should hold when the left version is newer', () => {
    expect(leftVersionGreaterThanOrEqualToRight(ProtocolVersion.V004, ProtocolVersion.V001)).toBe(true)
    expect(leftVersionGreaterThanOrEqualToRight(ProtocolVersion.V002, ProtocolVersion.V001)).toBe(true)
  })

  it('should hold when the versions are equal', () => {
    expect(leftVersionGreaterThanOrEqualToRight(ProtocolVersion.V003, ProtocolVersion.V003)).toBe(true)
  })

  it('should not hold when the left version is older', () => {
    expect(leftVersionGreaterThanOrEqualToRight(ProtocolVersion.V001, ProtocolVersion.V004)).toBe(false)
    expect(leftVersionGreaterThanOrEqualToRight(ProtocolVersion.V003, ProtocolVersion.V004)).toBe(false)
  })

  it('should compare numerically rather than by string, so the leading zeros do not decide the order', () => {
    const ascending = [ProtocolVersion.V004, ProtocolVersion.V002, ProtocolVersion.V003, ProtocolVersion.V001].sort(
      (a, b) => (leftVersionGreaterThanOrEqualToRight(a, b) ? 1 : -1),
    )

    expect(ascending).toEqual([ProtocolVersion.V001, ProtocolVersion.V002, ProtocolVersion.V003, ProtocolVersion.V004])
  })
})
