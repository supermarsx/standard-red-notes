import { parseEphemeralCleanupSession } from './EphemeralSession'
describe('cleanup cache parser', () => {
  it.each(['null', '[]', '{}', '{broken', '{"uuid":"","userUuid":"user"}', '{"uuid":"id"}'])(
    'skips malformed entries without blocking the remainder of a cleanup batch %s',
    (value) => {
      expect(parseEphemeralCleanupSession(value)).toBeUndefined()
    },
  )
  it('retains genuine server session identity fields', () => {
    expect(
      parseEphemeralCleanupSession('{"uuid":"id","userUuid":"user","createdAt":"2026-10-14T00:00:00Z"}'),
    ).toMatchObject({ uuid: 'id', userUuid: 'user' })
  })
})
