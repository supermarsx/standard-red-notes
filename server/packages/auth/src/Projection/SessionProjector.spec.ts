import { Session } from '../Domain/Session/Session'
import { SessionProjector } from './SessionProjector'

describe('SessionProjector access policy wire representation', () => {
  const projector = new SessionProjector(
    { getDeviceInfo: () => 'Test device' } as never,
    { convertDateToISOString: (date: Date) => date.toISOString() } as never,
  )
  const session = (readonlyAccess: unknown): Session =>
    Object.assign(new Session(), {
      uuid: 'session-1',
      apiVersion: '20200115',
      readonlyAccess,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      accessExpiration: new Date(1),
      refreshExpiration: new Date(2),
    })

  it.each([
    [false, false],
    [true, true],
    [0, false],
    [1, true],
  ])('projects boolean and database tinyint %s as canonical boolean %s for both session views', (value, expected) => {
    const current = session(value)
    const simple = projector.projectSimple(current)
    const listed = projector.projectCustom(SessionProjector.CURRENT_SESSION_PROJECTION, current, current)
    expect(simple.readonly_access).toBe(expected)
    expect(listed.readonly_access).toBe(expected)
    expect(simple).toMatchObject({ uuid: 'session-1', device_info: 'Test device' })
    expect(listed.current).toBe(true)
  })

  it.each([undefined, null, -1, 2, '0', '1', 'false'])(
    'rejects invalid stored access policies instead of granting write access: %s',
    (value) => {
      expect(() => projector.projectSimple(session(value))).toThrow('invalid representation')
      expect(() =>
        projector.projectCustom(SessionProjector.CURRENT_SESSION_PROJECTION, session(value), session(value)),
      ).toThrow('invalid representation')
    },
  )
})
