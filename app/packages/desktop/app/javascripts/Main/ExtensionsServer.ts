import fs from 'fs'
import http, { IncomingMessage, ServerResponse } from 'http'
import mime from 'mime-types'
import path from 'path'
import { URL } from 'url'
import { extensions as str } from './Strings'
import { RuntimePaths } from './Types/RuntimePaths'
import { app } from 'electron'
import { FileErrorCodes } from './File/FileErrorCodes'

const Protocol = 'http'

type ExtensionsServerPaths = Pick<typeof RuntimePaths, 'components' | 'extensionsDir'>

export type ExtensionsServerDependencies = {
  createServer: (requestListener: http.RequestListener) => http.Server
  getVersion: () => string
  paths: ExtensionsServerPaths
}

export type ExtensionsServerOptions = Partial<ExtensionsServerDependencies> & {
  ip?: string
  port?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logError(...message: any) {
  console.error('extServer:', ...message)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function log(...message: any) {
  // eslint-disable-next-line no-console
  console.log('extServer:', ...message)
}

export function normalizeFilePath(
  requestUrl: string,
  host = '127.0.0.1',
  paths: ExtensionsServerPaths = RuntimePaths,
): string {
  const isThirdPartyComponent = requestUrl.startsWith('/Extensions')
  const isNativeComponent = requestUrl.startsWith('/components')
  if (!isThirdPartyComponent && !isNativeComponent) {
    throw new Error(`URL '${requestUrl}' falls outside of the extensions/features domain.`)
  }

  const removedPrefix = requestUrl.replace('/components', '').replace('/Extensions', '')

  const base = `${Protocol}://${host}`
  const url = new URL(removedPrefix, base)

  /**
   * Normalize path (parse '..' and '.') so that we prevent path traversal by
   * joining a fully resolved path to the Extensions dir.
   */
  const modifiedReqUrl = path.normalize(url.pathname)
  if (isThirdPartyComponent) {
    return path.join(paths.extensionsDir, modifiedReqUrl)
  } else {
    return path.join(paths.components, modifiedReqUrl)
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ExtensionsServerDependencies,
) {
  try {
    if (!request.url) {
      throw new Error('No url.')
    }
    if (!request.headers.host) {
      throw new Error('No `host` header.')
    }

    const filePath = normalizeFilePath(request.url, request.headers.host, dependencies.paths)

    const stat = await fs.promises.lstat(filePath)

    if (!stat.isFile()) {
      throw new Error('Client requested something that is not a file.')
    }

    const mimeType = mime.lookup(path.parse(filePath).ext)

    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Cache-Control', 'no-cache')
    response.setHeader('ETag', dependencies.getVersion())
    response.setHeader('Content-Type', `${mimeType}; charset=utf-8`)

    const data = fs.readFileSync(filePath)

    response.writeHead(200)

    response.end(data)
  } catch (error) {
    onRequestError(error as Error, response)
  }
}

function onRequestError(error: Error | { code: string }, response: ServerResponse) {
  let responseCode: number
  let message: string

  if ('code' in error && error.code === FileErrorCodes.FileDoesNotExist) {
    responseCode = 404
    message = str().missingExtension
  } else {
    logError(error)
    responseCode = 500
    message = str().unableToLoadExtension
  }

  response.writeHead(responseCode)
  response.end(message)
}

export function createExtensionsServer(options: ExtensionsServerOptions = {}): string {
  const port = options.port ?? 45653
  const ip = options.ip ?? '127.0.0.1'
  const host = `${Protocol}://${ip}:${port}`
  const dependencies: ExtensionsServerDependencies = {
    createServer: options.createServer ?? ((requestListener) => http.createServer(requestListener)),
    getVersion: options.getVersion ?? (() => app.getVersion()),
    paths: options.paths ?? RuntimePaths,
  }

  const initCallback = () => {
    log(`Server started at ${host}`)
  }

  try {
    dependencies
      .createServer((request, response) => {
        void handleRequest(request, response, dependencies)
      })
      .listen(port, ip, initCallback)
      .on('error', (err) => {
        console.error('Error listening on extServer', err)
      })
  } catch (error) {
    console.error('Error creating ext server', error)
  }

  return host
}
