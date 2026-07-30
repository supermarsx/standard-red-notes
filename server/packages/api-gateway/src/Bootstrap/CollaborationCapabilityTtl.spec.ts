import {
  DEFAULT_COLLABORATION_CAPABILITY_TTL_SECONDS,
  parseCollaborationCapabilityTtlSeconds,
} from './CollaborationCapabilityTtl'

describe('parseCollaborationCapabilityTtlSeconds', () => {
  it.each([undefined, '', '   '])('uses the 300-second default for %p', (value) => {
    expect(parseCollaborationCapabilityTtlSeconds(value)).toBe(DEFAULT_COLLABORATION_CAPABILITY_TTL_SECONDS)
  })

  it.each(['30', '300', '900'])('accepts the bounded safe integer %s', (value) => {
    expect(parseCollaborationCapabilityTtlSeconds(value)).toBe(Number(value))
  })

  it.each(['29', '901', '-1', '30.5', 'NaN', 'Infinity', '9007199254740992'])(
    'fails closed for invalid value %s',
    (value) => {
      expect(() => parseCollaborationCapabilityTtlSeconds(value)).toThrow(/must be a safe integer between 30 and 900/)
    },
  )
})
