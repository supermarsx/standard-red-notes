import { ContentType, Dates, UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { RevisionMetadata } from './RevisionMetadata'

describe('RevisionMetadata', () => {
  const props = () => ({
    contentType: ContentType.create('Note').getValue(),
    itemUuid: Uuid.create('84c0f8e8-544a-4c7e-9adf-26209303bc1d').getValue(),
    sharedVaultUuid: null,
    dates: Dates.create(new Date(1), new Date(2)).getValue(),
  })

  it('should create an entity carrying the given props', () => {
    const entityOrError = RevisionMetadata.create(props())

    expect(entityOrError.isFailed()).toBeFalsy()

    const entity = entityOrError.getValue()
    expect(entity.props.contentType.value).toEqual('Note')
    expect(entity.props.itemUuid.value).toEqual('84c0f8e8-544a-4c7e-9adf-26209303bc1d')
    expect(entity.props.sharedVaultUuid).toBeNull()
    expect(entity.props.dates.createdAt).toEqual(new Date(1))
  })

  it('should assign an identifier when none is given', () => {
    const first = RevisionMetadata.create(props()).getValue()
    const second = RevisionMetadata.create(props()).getValue()

    expect(first.id).not.toBeNull()
    expect(first.id.toString()).not.toEqual(second.id.toString())
  })

  it('should keep the identifier it is given', () => {
    const entity = RevisionMetadata.create(
      props(),
      new UniqueEntityId('00000000-0000-0000-0000-000000000000'),
    ).getValue()

    expect(entity.id.toString()).toEqual('00000000-0000-0000-0000-000000000000')
  })

  it('should consider two entities with the same identifier equal regardless of their props', () => {
    const id = new UniqueEntityId('00000000-0000-0000-0000-000000000000')

    const entity = RevisionMetadata.create(props(), id).getValue()
    const sameId = RevisionMetadata.create(
      { ...props(), itemUuid: Uuid.create('11111111-1111-1111-1111-111111111111').getValue() },
      id,
    ).getValue()

    expect(entity.equals(sameId)).toBeTruthy()
    expect(entity.equals(RevisionMetadata.create(props()).getValue())).toBeFalsy()
  })
})
