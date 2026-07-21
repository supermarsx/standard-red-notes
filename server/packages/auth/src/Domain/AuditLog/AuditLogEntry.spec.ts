import { UniqueEntityId } from '@standardnotes/domain-core'

import { AuditLogEntry } from './AuditLogEntry'
import { AuditLogEntryProps } from './AuditLogEntryProps'

describe('AuditLogEntry', () => {
  const propsWith = (action: string): AuditLogEntryProps => ({
    actorUuid: '00000000-0000-0000-0000-000000000000',
    action,
    targetType: 'session',
    targetUuid: 'session-1',
    ip: '127.0.0.1',
    metadata: { reason: 'user requested' },
    createdAt: new Date(1),
  })

  it('should refuse an empty action', () => {
    const result = AuditLogEntry.create(propsWith(''))

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Audit log action cannot be empty')
  })

  it('should refuse an action longer than 255 characters', () => {
    const result = AuditLogEntry.create(propsWith('a'.repeat(256)))

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Audit log action cannot be longer than 255 characters')
  })

  it('should accept an action of exactly 255 characters', () => {
    const result = AuditLogEntry.create(propsWith('a'.repeat(255)))

    expect(result.isFailed()).toBe(false)
  })

  it('should keep the props and the supplied id', () => {
    const id = new UniqueEntityId('audit-1')

    const result = AuditLogEntry.create(propsWith('session.revoke'), id)

    expect(result.isFailed()).toBe(false)
    const entry = result.getValue()
    expect(entry.props.action).toEqual('session.revoke')
    expect(entry.props.metadata).toEqual({ reason: 'user requested' })
    expect(entry.id.toString()).toEqual('audit-1')
  })
})
