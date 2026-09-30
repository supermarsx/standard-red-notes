import { ProtocolVersion } from '@standardnotes/models'
import { SNProtocolOperator001 } from './001/Operator001'
import { SNProtocolOperator002 } from './002/Operator002'
import { SNProtocolOperator003 } from './003/Operator003'
import { SNProtocolOperator004 } from './004/Operator004'
import { createOperatorForVersion } from './Functions'
import { getMockedLegacyCrypto } from './MockedLegacyCrypto'

/**
 * The version-to-operator dispatch. A note encrypted under 001 handed to the 002 operator
 * does not fail loudly, it fails as "cannot decrypt", so every arm of this mapping matters.
 */
describe('createOperatorForVersion', () => {
  const crypto = getMockedLegacyCrypto()

  it('maps each protocol version to the operator that reports that same version', () => {
    const cases: [ProtocolVersion, new (...args: never[]) => unknown][] = [
      [ProtocolVersion.V001, SNProtocolOperator001],
      [ProtocolVersion.V002, SNProtocolOperator002],
      [ProtocolVersion.V003, SNProtocolOperator003],
      [ProtocolVersion.V004, SNProtocolOperator004],
    ]

    for (const [version, expectedClass] of cases) {
      const operator = createOperatorForVersion(version, crypto)

      expect(operator).toBeInstanceOf(expectedClass)
      /**
       * `instanceof` alone would accept 002 for 001 and 003 for 002, since each legacy
       * operator subclasses the one below it. The reported version is what callers route on.
       */
      expect(operator.version).toEqual(version)
    }
  })

  it('throws rather than silently returning the latest operator for an unrecognised version', () => {
    expect(() => createOperatorForVersion('009' as ProtocolVersion, crypto)).toThrow(
      'Unable to find operator for version 009',
    )
  })
})
