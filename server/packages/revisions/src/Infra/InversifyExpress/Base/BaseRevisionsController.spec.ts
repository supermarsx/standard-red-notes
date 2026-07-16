import 'reflect-metadata'

import { Request, Response } from 'express'
import { MapperInterface, Result } from '@standardnotes/domain-core'

import { BaseRevisionsController } from './BaseRevisionsController'
import { DeleteRevision } from '../../../Domain/UseCase/DeleteRevision/DeleteRevision'
import { GetRevision } from '../../../Domain/UseCase/GetRevision/GetRevision'
import { GetRevisionsMetada } from '../../../Domain/UseCase/GetRevisionsMetada/GetRevisionsMetada'
import { Revision } from '../../../Domain/Revision/Revision'
import { RevisionMetadata } from '../../../Domain/Revision/RevisionMetadata'
import { RevisionHttpRepresentation } from '../../../Mapping/Http/RevisionHttpRepresentation'
import { RevisionMetadataHttpRepresentation } from '../../../Mapping/Http/RevisionMetadataHttpRepresentation'

describe('BaseRevisionsController', () => {
  let getRevisionsMetadata: GetRevisionsMetada
  let doGetRevision: GetRevision
  let doDeleteRevision: DeleteRevision
  let revisionHttpMapper: MapperInterface<Revision, RevisionHttpRepresentation>
  let revisionMetadataHttpMapper: MapperInterface<RevisionMetadata, RevisionMetadataHttpRepresentation>
  let request: Request
  let response: Response

  const createController = () =>
    new BaseRevisionsController(
      getRevisionsMetadata,
      doGetRevision,
      doDeleteRevision,
      revisionHttpMapper,
      revisionMetadataHttpMapper,
    )

  beforeEach(() => {
    getRevisionsMetadata = {} as jest.Mocked<GetRevisionsMetada>
    getRevisionsMetadata.execute = jest.fn()

    doGetRevision = {} as jest.Mocked<GetRevision>
    doGetRevision.execute = jest.fn()

    doDeleteRevision = {} as jest.Mocked<DeleteRevision>
    doDeleteRevision.execute = jest.fn().mockResolvedValue(Result.ok('Revision deleted.'))

    revisionHttpMapper = {} as jest.Mocked<MapperInterface<Revision, RevisionHttpRepresentation>>
    revisionMetadataHttpMapper = {} as jest.Mocked<
      MapperInterface<RevisionMetadata, RevisionMetadataHttpRepresentation>
    >

    request = {
      params: { uuid: '1-2-3', itemUuid: '2-3-4' },
    } as unknown as jest.Mocked<Request>

    response = {
      locals: {
        user: { uuid: 'user-1' },
        readOnlyAccess: false,
      },
    } as unknown as jest.Mocked<Response>
  })

  it('deletes a revision for a writable session', async () => {
    const httpResponse = await createController().deleteRevision(request, response)
    const result = await httpResponse.executeAsync()

    expect(doDeleteRevision.execute).toHaveBeenCalled()
    expect(result.statusCode).toEqual(200)
  })

  it('returns 403 Forbidden and never deletes when the session is read-only', async () => {
    response.locals.readOnlyAccess = true

    const httpResponse = await createController().deleteRevision(request, response)
    const result = await httpResponse.executeAsync()

    expect(result.statusCode).toEqual(403)
    // The delete use case must not run for a read-only session.
    expect(doDeleteRevision.execute).not.toHaveBeenCalled()
  })
})
