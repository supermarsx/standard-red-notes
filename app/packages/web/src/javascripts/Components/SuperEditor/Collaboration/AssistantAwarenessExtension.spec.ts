import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { TextDecoder, TextEncoder } from 'node:util'
import { assistantAwarenessAAD, mergeAssistantAwareness, splitAssistantAwareness } from './AssistantAwarenessExtension'

beforeAll(() => {
  Object.assign(globalThis, { TextEncoder, TextDecoder })
})
const update = (state: unknown, clientId = 7) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint(encoder, clientId)
  encoding.writeVarUint(encoder, 2)
  encoding.writeVarString(encoder, JSON.stringify(state))
  return encoding.toUint8Array(encoder)
}
const stateOf = (bytes: Uint8Array) => {
  const decoder = decoding.createDecoder(bytes)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  decoding.readVarUint(decoder)
  return JSON.parse(decoding.readVarString(decoder))
}

it('keeps ordinary human awareness compatible and injects bounded AI decoration only on the same client', () => {
  const human = { name: 'Human', focusing: true, awarenessData: { userUuid: 'user', deviceId: 'device' } }
  const original = {
    ...human,
    awarenessData: { ...human.awarenessData, assistantActivity: [{ runId: 'run', status: 'editing' }] },
  }
  const split = splitAssistantAwareness(update(original))
  expect(stateOf(split.human)).toEqual(human)
  expect(new TextDecoder().decode(split.extension)).not.toContain('Human')
  expect(new TextDecoder().decode(split.extension)).not.toContain('user')
  expect(stateOf(mergeAssistantAwareness(split.human, split.extension!))).toEqual(original)
  expect(stateOf(mergeAssistantAwareness(update(human, 8), split.extension!))).toEqual(human)
  expect(assistantAwarenessAAD('room', 'cipher-one')).not.toEqual(assistantAwarenessAAD('room', 'cipher-two'))
})

it('ignores malformed, oversized and unknown activity while preserving human presence', () => {
  const human = update({ name: 'Human', awarenessData: { userUuid: 'user' } })
  for (const extension of [
    'bad',
    JSON.stringify({ clientId: 7, activities: [{ runId: 'run', status: 'unknown' }] }),
    JSON.stringify({ clientId: 7, activities: [], prompt: 'private' }),
    'x'.repeat(4097),
  ]) {
    expect(mergeAssistantAwareness(human, new TextEncoder().encode(extension))).toBe(human)
  }
  const invalid = update({
    name: 'Human',
    awarenessData: { userUuid: 'user', assistantActivity: [{ runId: 'run', status: 'editing', prompt: 'private' }] },
  })
  const split = splitAssistantAwareness(invalid)
  expect(split.extension).toBeUndefined()
  expect(stateOf(split.human).awarenessData).toEqual({ userUuid: 'user' })
})
