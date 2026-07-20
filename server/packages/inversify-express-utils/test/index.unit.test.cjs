const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { after, before, test } = require('node:test')

require('reflect-metadata')

const { Container } = require('inversify')

const { SetHeader } = require('@inversifyjs/http-core')

const {
  BaseHttpController,
  BaseMiddleware,
  InversifyExpressServer,
  all,
  controller,
  getControllerMethodMetadata,
  httpDelete,
  httpGet,
  httpPatch,
  httpPost,
  httpPut,
  response,
  results,
} = require('../dist/src/index.js')

const FUNCTION_MIDDLEWARE = Symbol('FunctionMiddleware')
const OBJECT_MIDDLEWARE = Symbol('ObjectMiddleware')
const CLASS_MIDDLEWARE = Symbol('ClassMiddleware')
const INVALID_MIDDLEWARE = Symbol('InvalidMiddleware')
const UNBOUND_MIDDLEWARE = Symbol('UnboundMiddleware')

const middlewareCallLog = []

class HeaderStampMiddleware extends BaseMiddleware {
  handler(_request, nativeResponse, next) {
    middlewareCallLog.push('class')
    nativeResponse.setHeader('x-class-middleware', 'applied')
    next()
  }
}

class VerbsController extends BaseHttpController {
  getRoute() {
    return this.ok({ verb: 'get' })
  }

  postRoute() {
    return this.json({ verb: 'post' }, 201)
  }

  putRoute() {
    return this.ok()
  }

  patchRoute() {
    return this.badRequest()
  }

  deleteRoute() {
    return this.notFound()
  }

  allRoute(request) {
    return this.json({ verb: request.method.toLowerCase() })
  }

  badRequestMessage() {
    return this.badRequest('missing-parameter')
  }

  customStatus() {
    return this.statusCode(418)
  }

  textBody() {
    return 'plain-text-body'
  }

  streamBody() {
    return Readable.from(['streamed-chunk'])
  }

  decoratedHeader() {
    return this.json({ decorated: true })
  }

  decoratedHeaderAfterManualReply(_request, nativeResponse) {
    nativeResponse.status(205).send('already-sent')
  }

  // Writes the reply itself and *also* returns a result: the manual reply must win.
  manualReplyThenReturn(_request, nativeResponse) {
    nativeResponse.status(202).send('manual-response')

    return this.json({ late: true }, 500)
  }

  // Delegates to a slower downstream route and *also* returns a result: the
  // delegated route must win even though it replies after this handler resolves.
  delegateThenReturn(_request, _nativeResponse, next) {
    next()

    return this.json({ late: true }, 500)
  }
}

class MiddlewareController extends BaseHttpController {
  functionMiddleware() {
    return this.ok({ ok: true })
  }

  objectMiddleware() {
    return this.ok({ ok: true })
  }

  classMiddleware() {
    return this.ok({ ok: true })
  }

  invalidMiddleware() {
    return this.ok({ ok: true })
  }

  unboundMiddleware() {
    return this.ok({ unbound: true })
  }
}

const decorate = (routeDecorator, target, methodName, path, ...middleware) => {
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, methodName)
  routeDecorator(path, ...middleware)(target.prototype, methodName, descriptor)
}

decorate(httpGet, VerbsController, 'getRoute', '/get')
decorate(httpPost, VerbsController, 'postRoute', '/post')
decorate(httpPut, VerbsController, 'putRoute', '/put')
decorate(httpPatch, VerbsController, 'patchRoute', '/patch')
decorate(httpDelete, VerbsController, 'deleteRoute', '/delete')
decorate(all, VerbsController, 'allRoute', '/all')
decorate(httpGet, VerbsController, 'badRequestMessage', '/bad-request-message')
decorate(httpGet, VerbsController, 'customStatus', '/custom-status')
decorate(httpGet, VerbsController, 'textBody', '/text')
decorate(httpGet, VerbsController, 'streamBody', '/stream')

const applySetHeader = (methodName, key, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(VerbsController.prototype, methodName)
  SetHeader(key, value)(VerbsController.prototype, methodName, descriptor)
}

applySetHeader('decoratedHeader', 'x-decorated-header', 'from-decorator')
decorate(httpGet, VerbsController, 'decoratedHeader', '/decorated-header')
applySetHeader('decoratedHeaderAfterManualReply', 'x-decorated-header', 'from-decorator')
decorate(httpGet, VerbsController, 'decoratedHeaderAfterManualReply', '/decorated-header-manual')
decorate(httpGet, VerbsController, 'manualReplyThenReturn', '/manual-then-return')
decorate(httpGet, VerbsController, 'delegateThenReturn', '/delegate-then-return')

controller('/verbs')(VerbsController)

decorate(httpGet, MiddlewareController, 'functionMiddleware', '/function', FUNCTION_MIDDLEWARE)
decorate(httpGet, MiddlewareController, 'objectMiddleware', '/object', OBJECT_MIDDLEWARE)
decorate(httpGet, MiddlewareController, 'invalidMiddleware', '/invalid', INVALID_MIDDLEWARE)
decorate(httpGet, MiddlewareController, 'unboundMiddleware', '/unbound', UNBOUND_MIDDLEWARE)
decorate(httpGet, MiddlewareController, 'classMiddleware', '/class')
controller('/middleware', CLASS_MIDDLEWARE)(MiddlewareController)

let baseUrl
let server
let configuredApp

before(async () => {
  const container = new Container()
  container.bind(FUNCTION_MIDDLEWARE).toConstantValue((_request, nativeResponse, next) => {
    middlewareCallLog.push('function')
    nativeResponse.setHeader('x-function-middleware', 'applied')
    next()
  })
  container.bind(OBJECT_MIDDLEWARE).toConstantValue({
    execute: (_request, nativeResponse, next) => {
      middlewareCallLog.push('object')
      nativeResponse.setHeader('x-object-middleware', 'applied')
      next()
    },
  })
  container.bind(CLASS_MIDDLEWARE).toConstantValue(new HeaderStampMiddleware())
  container.bind(INVALID_MIDDLEWARE).toConstantValue({ notExecute: true })

  const inversifyServer = new InversifyExpressServer(container)
  inversifyServer.setConfig((app) => {
    configuredApp = app
    app.set('x-powered-by', false)
  })
  inversifyServer.setErrorConfig((app) => {
    app.get('/verbs/delegate-then-return', async (_request, nativeResponse) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      nativeResponse.status(207).json({ delegated: true })
    })
  })

  const app = await inversifyServer.build()
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('setConfig receives the express application before controllers are mounted', () => {
  assert.equal(typeof configuredApp, 'function')
  assert.equal(configuredApp.get('x-powered-by'), false)
})

test('httpGet returns an OkResult serialized as an empty 200 for ok()', async () => {
  const withBody = await fetch(`${baseUrl}/verbs/get`)
  assert.equal(withBody.status, 200)
  assert.deepEqual(await withBody.json(), { verb: 'get' })

  const withoutBody = await fetch(`${baseUrl}/verbs/put`, { method: 'PUT' })
  assert.equal(withoutBody.status, 200)
  assert.equal(await withoutBody.text(), '')
})

test('httpPost serializes a JsonResult with its explicit status code', async () => {
  const result = await fetch(`${baseUrl}/verbs/post`, { method: 'POST' })
  assert.equal(result.status, 201)
  assert.deepEqual(await result.json(), { verb: 'post' })
})

test('httpPatch maps badRequest() to a bodyless 400', async () => {
  const result = await fetch(`${baseUrl}/verbs/patch`, { method: 'PATCH' })
  assert.equal(result.status, 400)
  assert.equal(await result.text(), '')
})

test('badRequest(message) sends the message as the 400 body', async () => {
  const result = await fetch(`${baseUrl}/verbs/bad-request-message`)
  assert.equal(result.status, 400)
  assert.equal(await result.text(), 'missing-parameter')
})

test('httpDelete maps notFound() to a 404', async () => {
  const result = await fetch(`${baseUrl}/verbs/delete`, { method: 'DELETE' })
  assert.equal(result.status, 404)
})

test('statusCode() forwards an arbitrary status code', async () => {
  const result = await fetch(`${baseUrl}/verbs/custom-status`)
  assert.equal(result.status, 418)
})

test('all() registers the route for every request method', async () => {
  const getResult = await fetch(`${baseUrl}/verbs/all`)
  assert.deepEqual(await getResult.json(), { verb: 'get' })

  const postResult = await fetch(`${baseUrl}/verbs/all`, { method: 'POST' })
  assert.deepEqual(await postResult.json(), { verb: 'post' })

  const deleteResult = await fetch(`${baseUrl}/verbs/all`, { method: 'DELETE' })
  assert.deepEqual(await deleteResult.json(), { verb: 'delete' })
})

test('a returned string is replied as a text body', async () => {
  const result = await fetch(`${baseUrl}/verbs/text`)
  assert.equal(result.status, 200)
  assert.equal(await result.text(), 'plain-text-body')
})

test('a returned Readable is streamed to the response', async () => {
  const result = await fetch(`${baseUrl}/verbs/stream`)
  assert.equal(result.status, 200)
  assert.equal(await result.text(), 'streamed-chunk')
})

test('a SetHeader-decorated route has its header applied to the reply', async () => {
  const result = await fetch(`${baseUrl}/verbs/decorated-header`)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('x-decorated-header'), 'from-decorator')
  assert.deepEqual(await result.json(), { decorated: true })
})

test('a SetHeader-decorated route that replied manually is not written to again', async () => {
  const result = await fetch(`${baseUrl}/verbs/decorated-header-manual`)
  assert.equal(result.status, 205)
  assert.equal(result.headers.get('x-decorated-header'), null)
})

test('a handler that replied manually does not have its returned result sent as well', async () => {
  const result = await fetch(`${baseUrl}/verbs/manual-then-return`)
  assert.equal(result.status, 202)
  assert.equal(await result.text(), 'manual-response')
})

test('a delegated route still wins when it replies after the delegating handler resolves', async () => {
  const result = await fetch(`${baseUrl}/verbs/delegate-then-return`)
  assert.equal(result.status, 207)
  assert.deepEqual(await result.json(), { delegated: true })
})

test('a legacy express function middleware is adapted and executed', async () => {
  middlewareCallLog.length = 0
  const result = await fetch(`${baseUrl}/middleware/function`)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('x-function-middleware'), 'applied')
  assert.deepEqual(middlewareCallLog, ['class', 'function'])
})

test('an object exposing execute() is used as middleware unchanged', async () => {
  middlewareCallLog.length = 0
  const result = await fetch(`${baseUrl}/middleware/object`)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('x-object-middleware'), 'applied')
  assert.deepEqual(middlewareCallLog, ['class', 'object'])
})

test('controller-level middleware applies to every route of the controller', async () => {
  middlewareCallLog.length = 0
  const result = await fetch(`${baseUrl}/middleware/class`)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('x-class-middleware'), 'applied')
  assert.deepEqual(middlewareCallLog, ['class'])
})

test('middleware that is neither a function nor exposes execute() is rejected', async () => {
  const result = await fetch(`${baseUrl}/middleware/invalid`)
  assert.equal(result.status, 500)
})

test('a middleware identifier absent from the container fails the request rather than the build', async () => {
  // build() only binds an adapter for identifiers that are already bound, so an unknown
  // identifier survives startup and surfaces as a resolution failure on the first request.
  const result = await fetch(`${baseUrl}/middleware/unbound`)
  assert.equal(result.status, 500)
})

test('build() throws when the same server is built twice', async () => {
  const inversifyServer = new InversifyExpressServer(new Container())
  await inversifyServer.build()
  await assert.rejects(() => inversifyServer.build(), /already been built/)
})

test('build() mounts onto a custom express application when one is supplied', async () => {
  const express = require('express')
  const customApp = express()
  const inversifyServer = new InversifyExpressServer(new Container(), null, undefined, customApp)
  const built = await inversifyServer.build()
  assert.equal(built, customApp)
})

test('setConfig and setErrorConfig return the server for chaining', () => {
  const inversifyServer = new InversifyExpressServer(new Container())
  assert.equal(
    inversifyServer.setConfig(() => undefined),
    inversifyServer,
  )
  assert.equal(
    inversifyServer.setErrorConfig(() => undefined),
    inversifyServer,
  )
})

test('getControllerMethodMetadata records each decorated route and returns a copy', () => {
  const metadata = getControllerMethodMetadata(VerbsController)
  const paths = metadata.map((entry) => entry.path).sort()
  assert.deepEqual(paths, [
    '/all',
    '/bad-request-message',
    '/custom-status',
    '/decorated-header',
    '/decorated-header-manual',
    '/delegate-then-return',
    '/delete',
    '/get',
    '/manual-then-return',
    '/patch',
    '/post',
    '/put',
    '/stream',
    '/text',
  ])

  const getEntry = metadata.find((entry) => entry.path === '/get')
  assert.equal(getEntry.key, 'getRoute')
  assert.deepEqual(getEntry.middleware, [])

  metadata.push({ key: 'mutated', middleware: [], path: '/mutated' })
  assert.equal(getControllerMethodMetadata(VerbsController).length, 14)
})

test('getControllerMethodMetadata returns an empty list for an undecorated class', () => {
  class Undecorated {}
  assert.deepEqual(getControllerMethodMetadata(Undecorated), [])
})

test('route metadata carries the middleware identifiers declared on the route', () => {
  const metadata = getControllerMethodMetadata(MiddlewareController)
  const functionEntry = metadata.find((entry) => entry.path === '/function')
  assert.deepEqual(functionEntry.middleware, [FUNCTION_MIDDLEWARE])

  const classEntry = metadata.find((entry) => entry.path === '/class')
  assert.deepEqual(classEntry.middleware, [])
})

test('response() rejects being applied to a constructor parameter', () => {
  class NoMethodKey {}
  assert.throws(() => response()(NoMethodKey, undefined, 0), {
    name: 'TypeError',
    message: /only be used on controller methods/,
  })
})

test('results.JsonResult exposes the json body and status code', async () => {
  const result = new results.JsonResult({ a: 1 }, 202)
  assert.equal(result.statusCode, 202)
  assert.deepEqual(result.json, { a: 1 })
  assert.deepEqual(result.body, { a: 1 })
  assert.equal(await result.executeAsync(), result)
})

test('results.StatusCodeResult carries no body', () => {
  const result = new results.StatusCodeResult(204)
  assert.equal(result.statusCode, 204)
  assert.equal(result.body, undefined)
})

test('results.OkResult, BadRequestResult and NotFoundResult use their canonical status codes', () => {
  assert.equal(new results.OkResult().statusCode, 200)
  assert.equal(new results.BadRequestResult().statusCode, 400)
  assert.equal(new results.NotFoundResult().statusCode, 404)
})

test('results.BadRequestErrorMessageResult carries the message as its body', () => {
  const result = new results.BadRequestErrorMessageResult('nope')
  assert.equal(result.statusCode, 400)
  assert.equal(result.message, 'nope')
  assert.equal(result.body, 'nope')
})

test('BaseMiddleware.execute delegates to handler and returns its result', async () => {
  const calls = []
  class RecordingMiddleware extends BaseMiddleware {
    async handler(request, nativeResponse, next) {
      calls.push([request, nativeResponse, next])
      return 'handled'
    }
  }

  const middleware = new RecordingMiddleware()
  const next = () => undefined
  assert.equal(await middleware.execute('req', 'res', next), 'handled')
  assert.deepEqual(calls, [['req', 'res', next]])
})
