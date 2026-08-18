import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { ValetTokenOperation } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import * as http from 'http'
import { Container } from 'inversify'
import { InversifyExpressServer } from 'inversify-express-utils'
import { AddressInfo } from 'net'

import TYPES from '../../Bootstrap/Types'
import { FILE_DATA_NOT_FOUND_MESSAGE } from '../../Domain/UseCase/GetFileMetadata/GetFileMetadata'
import { AnnotatedFilesController } from './AnnotatedFilesController'

void AnnotatedFilesController

type HttpResult = {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

function buildContainer(): Container {
  const container = new Container()
  const noop = {} as never

  container.bind(TYPES.Files_UploadFileChunk).toConstantValue(noop)
  container.bind(TYPES.Files_CreateUploadSession).toConstantValue(noop)
  container.bind(TYPES.Files_FinishUploadSession).toConstantValue(noop)
  container.bind(TYPES.Files_StreamDownloadFile).toConstantValue(noop)
  container.bind(TYPES.Files_RemoveFile).toConstantValue(noop)
  container.bind(TYPES.Files_MAX_CHUNK_BYTES).toConstantValue(1024)
  container.bind(TYPES.Files_FILE_DOWNLOAD_DEADLINE_MS).toConstantValue(30_000)
  container.bind(TYPES.Files_Logger).toConstantValue({ error: () => undefined } as never)
  container.bind(TYPES.Files_GetFileMetadata).toConstantValue({
    execute: () => Result.fail(FILE_DATA_NOT_FOUND_MESSAGE),
  } as never)
  container
    .bind(TYPES.Files_ValetTokenAuthMiddleware)
    .toConstantValue((_request: Request, response: Response, next: NextFunction): void => {
      Object.assign(response.locals, {
        userUuid: '11111111-1111-4111-8111-111111111111',
        permittedOperation: ValetTokenOperation.Read,
        permittedResources: [
          {
            remoteIdentifier: '22222222-2222-4222-8222-222222222222',
            unencryptedFileSize: 1,
          },
        ],
      })
      next()
    })

  return container
}

function requestOf(baseUrl: string, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/v1/files`, { method: 'GET', headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode as number, body, headers: response.headers }))
    })
    request.on('error', reject)
    request.end()
  })
}

describe('file download HTTP error contract', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    const app = await new InversifyExpressServer(buildContainer()).build()
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach((done) => {
    server.close(() => done())
  })

  it('returns a structured 404 when the encrypted storage object is missing', async () => {
    const result = await requestOf(baseUrl, {
      Range: 'bytes=0-0',
      'x-chunk-size': '1',
      'x-valet-token': 'valid-test-token',
    })

    expect(result.status).toBe(404)
    expect(result.headers['content-type']).toMatch(/^application\/json\b/)
    expect(JSON.parse(result.body)).toEqual({ error: { message: FILE_DATA_NOT_FOUND_MESSAGE } })
  })

  it('returns a structured 400 when the required Range header is absent', async () => {
    const result = await requestOf(baseUrl, { 'x-valet-token': 'valid-test-token' })

    expect(result.status).toBe(400)
    expect(result.headers['content-type']).toMatch(/^application\/json\b/)
    expect(JSON.parse(result.body)).toEqual({
      error: { message: 'File download requires range header to be set.' },
    })
  })
})
