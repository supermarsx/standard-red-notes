import 'reflect-metadata'

import { ApiVersion } from './ApiVersion'
import { usesModernSyncResponse } from './ModernSyncResponse'
import { SyncResponseFactory20161215 } from '../Item/SyncResponse/SyncResponseFactory20161215'
import { SyncResponseFactory20200115 } from '../Item/SyncResponse/SyncResponseFactory20200115'
import { SyncResponseFactoryResolver } from '../Item/SyncResponse/SyncResponseFactoryResolver'

describe('usesModernSyncResponse', () => {
  const factory20161215 = {} as jest.Mocked<SyncResponseFactory20161215>
  const factory20200115 = {} as jest.Mocked<SyncResponseFactory20200115>
  const resolver = new SyncResponseFactoryResolver(factory20161215, factory20200115)

  const candidates: (string | undefined)[] = [...Object.values(ApiVersion), undefined, '', 'not-a-version', '20240227']

  it.each(candidates)('agrees with the upstream resolver for %p', (apiVersion) => {
    const resolvesToModernFactory = resolver.resolveSyncResponseFactoryVersion(apiVersion) === factory20200115

    expect(usesModernSyncResponse(apiVersion)).toBe(resolvesToModernFactory)
  })

  it('accepts the current API version so durable commands are not rejected', () => {
    expect(usesModernSyncResponse(ApiVersion.v20240226)).toBe(true)
  })

  it('rejects the legacy response family so durable commands cannot store a legacy shape', () => {
    expect(usesModernSyncResponse(ApiVersion.v20161215)).toBe(false)
    expect(usesModernSyncResponse(undefined)).toBe(false)
  })
})
