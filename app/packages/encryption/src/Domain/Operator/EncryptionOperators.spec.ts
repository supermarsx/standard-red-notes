import { ProtocolVersion } from '@standardnotes/common'
import { ProtocolVersionLatest } from '@standardnotes/models'
import { EncryptionOperators } from './EncryptionOperators'
import { getMockedLegacyCrypto } from './MockedLegacyCrypto'

describe('EncryptionOperators', () => {
  let operators: EncryptionOperators

  beforeEach(() => {
    operators = new EncryptionOperators(getMockedLegacyCrypto())
  })

  it('returns an operator reporting the requested version', () => {
    for (const version of [ProtocolVersion.V001, ProtocolVersion.V002, ProtocolVersion.V003, ProtocolVersion.V004]) {
      expect(operators.operatorForVersion(version).version).toEqual(version)
    }
  })

  it('caches one operator per version rather than building a fresh one per call', () => {
    const first = operators.operatorForVersion(ProtocolVersion.V002)
    const second = operators.operatorForVersion(ProtocolVersion.V002)

    expect(second).toBe(first)
  })

  it('keys the cache by version, so two versions never share an operator', () => {
    const v002 = operators.operatorForVersion(ProtocolVersion.V002)
    const v003 = operators.operatorForVersion(ProtocolVersion.V003)

    expect(v003).not.toBe(v002)
    expect(v002.version).toEqual(ProtocolVersion.V002)
    expect(v003.version).toEqual(ProtocolVersion.V003)
  })

  it('serves the default operator out of the same cache entry as the latest version', () => {
    const byVersion = operators.operatorForVersion(ProtocolVersionLatest)

    expect(operators.defaultOperator()).toBe(byVersion)
  })

  it('drops the cache on deinit, so a deinitialised instance cannot hand out an operator holding the old crypto', () => {
    const before = operators.operatorForVersion(ProtocolVersion.V004)

    operators.deinit()

    expect(operators.operatorForVersion(ProtocolVersion.V004)).not.toBe(before)
  })
})
