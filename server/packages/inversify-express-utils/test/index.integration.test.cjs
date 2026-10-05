const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')

require('reflect-metadata')

const { Readable } = require('node:stream')

const { Container } = require('inversify')

const { BaseHttpController, InversifyExpressServer, controller, httpGet, response } = require('../dist/src/index.js')

class CompatibilityController extends BaseHttpController {
  jsonResult(request, nativeResponse) {
    nativeResponse.setHeader('x-injected-response', 'available')

    return this.json({ method: request.method, serialized: true }, 201)
  }

  statusResult() {
    return this.statusCode(204)
  }

  manual(_request, nativeResponse) {
    nativeResponse.status(202).send('manual-response')
  }

  explicit(nativeResponse) {
    nativeResponse.setHeader('x-explicit-response', 'available')
    nativeResponse.status(206).send('explicit-response')
  }

  delegate(_request, _response, next) {
    next()
  }

  // The shape the files service uses for a ranged download: write the success head
  // first, then hand the framework a THUNK that pipes storage into the response.
  // Upstream inversify-express-utils called a returned function; without that the
  // body is never produced and the response is never ended, so the request hangs.
  async deferredStream(_request, nativeResponse) {
    nativeResponse.writeHead(206, {
      'Content-Range': 'bytes 0-7/8',
      'Content-Length': 8,
      'Content-Type': 'application/octet-stream',
    })

    return () => Readable.from([Buffer.from('deferred')]).pipe(nativeResponse)
  }

  // The 416 branch of the same handler: head already written, nothing to pipe, the
  // thunk only ends the response.
  async deferredEnd(_request, nativeResponse) {
    nativeResponse.writeHead(416, { 'Content-Range': 'bytes */8' })

    return () => nativeResponse.end()
  }
}

const decorateRoute = (methodName, path) => {
  const descriptor = Object.getOwnPropertyDescriptor(CompatibilityController.prototype, methodName)
  httpGet(path)(CompatibilityController.prototype, methodName, descriptor)
}

decorateRoute('jsonResult', '/json')
decorateRoute('statusResult', '/status')
decorateRoute('manual', '/manual')
response()(CompatibilityController.prototype, 'explicit', 0)
decorateRoute('explicit', '/explicit')
decorateRoute('delegate', '/next')
decorateRoute('deferredStream', '/deferred-stream')
decorateRoute('deferredEnd', '/deferred-end')
controller('/compatibility')(CompatibilityController)

let server
let baseUrl

before(async () => {
  const inversifyServer = new InversifyExpressServer(new Container())
  inversifyServer.setErrorConfig((app) => {
    app.get('/compatibility/next', (_request, nativeResponse) => {
      nativeResponse.status(207).json({ delegated: true })
    })
  })

  const app = await inversifyServer.build()
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
})

test('serializes a returned JsonResult after using the injected response', async () => {
  const result = await fetch(`${baseUrl}/compatibility/json`)

  assert.equal(result.status, 201)
  assert.equal(result.headers.get('x-injected-response'), 'available')
  assert.deepEqual(await result.json(), { method: 'GET', serialized: true })
})

test('serializes a returned StatusCodeResult', async () => {
  const result = await fetch(`${baseUrl}/compatibility/status`)

  assert.equal(result.status, 204)
  assert.equal(await result.text(), '')
})

test('does not send again after an implicitly injected response is completed manually', async () => {
  const result = await fetch(`${baseUrl}/compatibility/manual`)

  assert.equal(result.status, 202)
  assert.equal(await result.text(), 'manual-response')
})

test('preserves explicit response decorator native handling', async () => {
  const result = await fetch(`${baseUrl}/compatibility/explicit`)

  assert.equal(result.status, 206)
  assert.equal(result.headers.get('x-explicit-response'), 'available')
  assert.equal(await result.text(), 'explicit-response')
})

test('delegates a third next parameter without an automatic reply', async () => {
  const result = await fetch(`${baseUrl}/compatibility/next`)

  assert.equal(result.status, 207)
  assert.deepEqual(await result.json(), { delegated: true })
})

// Regression: a handler that writes its own head and returns a thunk. Both requests
// below HANG (no status line at all) when the deferred-send contract is missing, so
// every assertion is behind an explicit timeout — a hang must read as a failure, not
// as a stuck test run.
test('invokes a returned function so a deferred stream body is actually sent', async () => {
  const result = await fetch(`${baseUrl}/compatibility/deferred-stream`, {
    signal: AbortSignal.timeout(5000),
  })

  assert.equal(result.status, 206)
  assert.equal(result.headers.get('content-range'), 'bytes 0-7/8')
  assert.equal(await result.text(), 'deferred')
})

test('invokes a returned function that only ends the response', async () => {
  const result = await fetch(`${baseUrl}/compatibility/deferred-end`, {
    signal: AbortSignal.timeout(5000),
  })

  assert.equal(result.status, 416)
  assert.equal(result.headers.get('content-range'), 'bytes */8')
  assert.equal(await result.text(), '')
})
