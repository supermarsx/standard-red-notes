const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')

require('reflect-metadata')

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
