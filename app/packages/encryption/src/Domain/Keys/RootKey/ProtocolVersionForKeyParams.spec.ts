import { ProtocolVersion } from '@standardnotes/common'
import { KeyParamsData } from '@standardnotes/responses'
import { V001Algorithm, V002Algorithm } from '../../Algorithm'
import { ProtocolVersionForKeyParams } from './ProtocolVersionForKeyParams'

/**
 * This function decides which protocol operator will derive a legacy account's root key
 * when the stored key params carry no version number. Choose wrong and the derived key is
 * wrong, so the account cannot be opened and the user's notes cannot be decrypted. Nothing
 * else in the repository exercises the disambiguation rules.
 */
describe('ProtocolVersionForKeyParams', () => {
  const params = (content: KeyParamsData): KeyParamsData => content

  it('returns an explicitly stated version without inspecting the cost or the nonce', () => {
    /** pw_cost 3000 would otherwise be read as 001, so the explicit version has to win. */
    expect(
      ProtocolVersionForKeyParams(params({ version: ProtocolVersion.V004, pw_cost: 3000, pw_nonce: 'nonce' })),
    ).toEqual(ProtocolVersion.V004)

    expect(ProtocolVersionForKeyParams(params({ version: ProtocolVersion.V003 }))).toEqual(ProtocolVersion.V003)
  })

  it('reads a cost only 002 ever used as 002', () => {
    for (const cost of [100_000, 101_000, 102_000, 103_000]) {
      expect(ProtocolVersionForKeyParams(params({ pw_cost: cost, pw_nonce: 'nonce' }))).toEqual(ProtocolVersion.V002)
    }
  })

  it('reads a cost both versions used as 002 when no nonce is stored, since late 001 always stored one', () => {
    for (const cost of [3000, 5000, 10_000, 60_000]) {
      expect(ProtocolVersionForKeyParams(params({ pw_cost: cost }))).toEqual(ProtocolVersion.V002)
    }
  })

  it('reads a shared cost with a nonce as 001 only for the two costs 002 improbably used', () => {
    expect(V002Algorithm.ImprobablePbkdfCostsUsed).toEqual([3000, 5000])

    for (const cost of V002Algorithm.ImprobablePbkdfCostsUsed) {
      expect(ProtocolVersionForKeyParams(params({ pw_cost: cost, pw_nonce: 'nonce' }))).toEqual(ProtocolVersion.V001)
    }
  })

  it('reads the remaining shared costs with a nonce as 002', () => {
    for (const cost of [10_000, 60_000]) {
      expect(ProtocolVersionForKeyParams(params({ pw_cost: cost, pw_nonce: 'nonce' }))).toEqual(ProtocolVersion.V002)
    }
  })

  it('falls back to 002 for a cost neither version is recorded as having used', () => {
    expect(ProtocolVersionForKeyParams(params({ pw_cost: 42, pw_nonce: 'nonce' }))).toEqual(ProtocolVersion.V002)
  })

  it('has an unreachable 001 branch, because every 001 cost is also a 002 cost', () => {
    /**
     * The `appearsInV001 && !appearsInV002` branch cannot be taken while
     * V002Algorithm.PbkdfCostsUsed is built as `V001Algorithm.PbkdfCostsUsed.concat(...)`.
     * Asserting the containment here means that if that construction is ever narrowed, this
     * test fails and points at the branch that has just become live and is still untested,
     * rather than the branch silently starting to matter.
     */
    for (const cost of V001Algorithm.PbkdfCostsUsed) {
      expect(V002Algorithm.PbkdfCostsUsed).toContain(cost)
    }
  })
})
