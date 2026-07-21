import { Result, Timestamps, Uuid } from '@standardnotes/domain-core'

import { Connection } from '../../Domain/Connection/Connection'
import { SQLConnection } from '../../Infra/TypeORM/SQLConnection'
import { ConnectionPersistenceMapper } from './ConnectionPersistenceMapper'

describe('ConnectionPersistenceMapper', () => {
  const userUuid = '00000000-0000-0000-0000-000000000000'
  const sessionUuid = '11111111-1111-1111-1111-111111111111'

  const createMapper = () => new ConnectionPersistenceMapper()

  const createProjection = (overrides: Partial<SQLConnection> = {}): SQLConnection => {
    const projection = new SQLConnection()
    projection.uuid = '22222222-2222-2222-2222-222222222222'
    projection.userUuid = userUuid
    projection.sessionUuid = sessionUuid
    projection.connectionId = 'connection-id'
    projection.createdAtTimestamp = 123
    projection.updatedAtTimestamp = 456

    return Object.assign(projection, overrides)
  }

  describe('toDomain', () => {
    it('maps every persisted column onto the domain entity', () => {
      const connection = createMapper().toDomain(createProjection())

      expect(connection.props.userUuid.value).toBe(userUuid)
      expect(connection.props.sessionUuid.value).toBe(sessionUuid)
      expect(connection.props.connectionId).toBe('connection-id')
      expect(connection.props.timestamps.createdAt).toBe(123)
      expect(connection.props.timestamps.updatedAt).toBe(456)
    })

    it('throws when the persisted user uuid is not a uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ userUuid: 'not-a-uuid' }))).toThrow(
        /^Failed to create connection from projection: /,
      )
    })

    it('throws when the persisted session uuid is not a uuid', () => {
      expect(() => createMapper().toDomain(createProjection({ sessionUuid: 'not-a-uuid' }))).toThrow(
        /^Failed to create connection from projection: /,
      )
    })

    it('throws when the persisted timestamps are not numbers', () => {
      expect(() => createMapper().toDomain(createProjection({ createdAtTimestamp: NaN }))).toThrow(
        /^Failed to create connection from projection: /,
      )
    })

    it('throws when the connection entity itself cannot be constructed', () => {
      const createSpy = jest.spyOn(Connection, 'create').mockReturnValue(Result.fail<Connection>('entity rejected'))

      try {
        expect(() => createMapper().toDomain(createProjection())).toThrow(
          'Failed to create connection from projection: entity rejected',
        )
      } finally {
        createSpy.mockRestore()
      }
    })
  })

  describe('toProjection', () => {
    const createDomain = () =>
      Connection.create({
        userUuid: Uuid.create(userUuid).getValue(),
        sessionUuid: Uuid.create(sessionUuid).getValue(),
        connectionId: 'connection-id',
        timestamps: Timestamps.create(123, 456).getValue(),
      }).getValue()

    it('unwraps the value objects into persistable columns', () => {
      const projection = createMapper().toProjection(createDomain())

      expect(projection).toBeInstanceOf(SQLConnection)
      expect(projection.userUuid).toBe(userUuid)
      expect(projection.sessionUuid).toBe(sessionUuid)
      expect(projection.connectionId).toBe('connection-id')
      expect(projection.createdAtTimestamp).toBe(123)
      expect(projection.updatedAtTimestamp).toBe(456)
    })

    it('round-trips a domain entity through persistence without losing data', () => {
      const mapper = createMapper()

      const restored = mapper.toDomain(mapper.toProjection(createDomain()))

      expect(restored.props.userUuid.value).toBe(userUuid)
      expect(restored.props.sessionUuid.value).toBe(sessionUuid)
      expect(restored.props.connectionId).toBe('connection-id')
      expect(restored.props.timestamps.createdAt).toBe(123)
      expect(restored.props.timestamps.updatedAt).toBe(456)
    })
  })
})
