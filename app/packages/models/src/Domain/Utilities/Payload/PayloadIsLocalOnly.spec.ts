import { FullyFormedPayloadInterface } from '../../Abstract/Payload/Interfaces/UnionTypes'
import { ContentType } from '@standardnotes/domain-core'
import { AppDataField } from '../../Abstract/Item/Types/AppDataField'
import { DefaultAppDomain } from '../../Abstract/Item/Types/DefaultAppDomain'
import { PayloadIsLocalOnly } from './PayloadIsLocalOnly'

describe('PayloadIsLocalOnly', () => {
  const decryptedPayload = (localOnly: boolean | undefined): FullyFormedPayloadInterface =>
    ({
      uuid: 'uuid',
      content_type: ContentType.TYPES.Note,
      deleted: false,
      // Presence of `content` with no `errorDecrypting`/`waitingForKey` => decrypted payload.
      content: {
        references: [],
        appData:
          localOnly === undefined
            ? { [DefaultAppDomain]: {} }
            : { [DefaultAppDomain]: { [AppDataField.LocalOnly]: localOnly } },
      },
    }) as unknown as FullyFormedPayloadInterface

  const deletedPayload = (): FullyFormedPayloadInterface =>
    ({
      uuid: 'uuid',
      content_type: ContentType.TYPES.Note,
      deleted: true,
      content: undefined,
    }) as unknown as FullyFormedPayloadInterface

  it('returns true when the local-only appData flag is set', () => {
    expect(PayloadIsLocalOnly(decryptedPayload(true))).toBe(true)
  })

  it('returns false when the flag is explicitly false', () => {
    expect(PayloadIsLocalOnly(decryptedPayload(false))).toBe(false)
  })

  it('returns false (default = syncs) when the flag is absent', () => {
    expect(PayloadIsLocalOnly(decryptedPayload(undefined))).toBe(false)
  })

  it('returns false for deleted (non-decrypted) payloads', () => {
    expect(PayloadIsLocalOnly(deletedPayload())).toBe(false)
  })
})
