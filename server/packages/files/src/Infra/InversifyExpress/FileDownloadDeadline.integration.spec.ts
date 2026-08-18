import 'reflect-metadata'

import { ValetTokenOperation } from '@standardnotes/security'
import { NextFunction, Request, Response } from 'express'
import * as http from 'http'
import { Container } from 'inversify'
import { InversifyExpressServer } from 'inversify-express-utils'
import { AddressInfo } from 'net'

import TYPES from '../../Bootstrap/Types'
import { FileDownloaderInterface } from '../../Domain/Services/FileDownloaderInterface'
import { GetFileMetadata } from '../../Domain/UseCase/GetFileMetadata/GetFileMetadata'
import { AnnotatedFilesController } from './AnnotatedFilesController'
import { FILE_DOWNLOAD_TIMEOUT_CODE, FILE_DOWNLOAD_TIMEOUT_MESSAGE } from './FileDownloadRequestLifecycle'

void AnnotatedFilesController

describe('file download deadline HTTP contract', () => {
  let server: http.Server
  let baseUrl: string
  let metadataSignal: AbortSignal | undefined

  beforeEach(async () => {
    const container = new Container()
    const logger = { error: jest.fn(), warn: jest.fn() }
    const fileDownloader = {
      getFileSize: jest.fn((_path: string, abortSignal?: AbortSignal) => {
        metadataSignal = abortSignal
        return new Promise<number>(() => undefined)
      }),
    } as unknown as FileDownloaderInterface
    const noop = {} as never

    container.bind(TYPES.Files_UploadFileChunk).toConstantValue(noop)
    container.bind(TYPES.Files_CreateUploadSession).toConstantValue(noop)
    container.bind(TYPES.Files_FinishUploadSession).toConstantValue(noop)
    container.bind(TYPES.Files_StreamDownloadFile).toConstantValue(noop)
    container.bind(TYPES.Files_RemoveFile).toConstantValue(noop)
    container.bind(TYPES.Files_MAX_CHUNK_BYTES).toConstantValue(1024)
    container.bind(TYPES.Files_FILE_DOWNLOAD_DEADLINE_MS).toConstantValue(25)
    container.bind(TYPES.Files_Logger).toConstantValue(logger)
    container.bind(TYPES.Files_GetFileMetadata).toConstantValue(new GetFileMetadata(fileDownloader, logger as never))
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

    const app = await new InversifyExpressServer(container).build()
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach((done) => {
    server.close(() => done())
  })

  it('returns retryable JSON before the proxy timeout when metadata never settles', async () => {
    const startedAt = Date.now()
    const result = await new Promise<{ status: number; body: string; retryAfter?: string }>((resolve, reject) => {
      const request = http.request(
        `${baseUrl}/v1/files`,
        {
          method: 'GET',
          headers: {
            Range: 'bytes=0-0',
            'x-chunk-size': '1',
            'x-valet-token': 'valid-test-token',
          },
        },
        (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode as number,
              body,
              retryAfter: response.headers['retry-after'],
            }),
          )
        },
      )
      request.on('error', reject)
      request.end()
    })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(metadataSignal?.aborted).toBe(true)
    expect(result.status).toBe(503)
    expect(result.retryAfter).toBe('1')
    expect(JSON.parse(result.body)).toEqual({
      error: {
        message: FILE_DOWNLOAD_TIMEOUT_MESSAGE,
        code: FILE_DOWNLOAD_TIMEOUT_CODE,
        retryable: true,
      },
    })
  })
})
