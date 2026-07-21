import { Entity } from '../Core/Entity'
import { UniqueEntityId } from '../Core/UniqueEntityId'
import { CacheEntry } from './CacheEntry'

describe('CacheEntry', () => {
  const props = { key: 'a-key', value: 'a-value', expiresAt: new Date(1) }

  it('creates a successful result carrying the props', () => {
    const result = CacheEntry.create(props)

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().props).toEqual(props)
  })

  it('is an Entity', () => {
    expect(CacheEntry.create(props).getValue()).toBeInstanceOf(Entity)
  })

  it('accepts a null expiry, meaning the entry does not expire', () => {
    const entry = CacheEntry.create({ key: 'a-key', value: 'a-value', expiresAt: null }).getValue()

    expect(entry.props.expiresAt).toBeNull()
  })

  it('generates an id when none is supplied', () => {
    expect(CacheEntry.create(props).getValue().id).toBeInstanceOf(UniqueEntityId)
  })

  it('keeps a supplied id', () => {
    const id = new UniqueEntityId('cache-entry-id')

    expect(CacheEntry.create(props, id).getValue().id).toBe(id)
  })
})
