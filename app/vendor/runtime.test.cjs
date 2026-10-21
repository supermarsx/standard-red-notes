const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const zlib = require('node:zlib')
const desktopRequire = createRequire(path.resolve(__dirname, '../packages/desktop/app/package.json'))
const names = [
  'predicates',
  'security',
  'common',
  'time',
  'sncrypto-node',
  'domain-events',
  'grpc',
  'domain-events-infra',
]
function installed(name) {
  return desktopRequire(`@standardnotes/${name}`)
}
test('vendor archives normalize permissions and timestamps across host operating systems', () => {
  require('./package-upstream.cjs').packageUpstream(true)
  for (const name of names) {
    const compressed = fs.readFileSync(path.join(__dirname, 'archives', `${name}.tgz`))
    assert.equal(compressed[9], 255)
    const tar = zlib.gunzipSync(compressed)
    for (let offset = 0; tar[offset] !== 0;) {
      const header = tar.subarray(offset, offset + 512)
      const number = (start, length) => Number.parseInt(header.toString('ascii', start, start + length), 8)
      assert.equal(number(100, 8), header[156] === 53 ? 0o755 : 0o644)
      assert.equal(number(108, 8), 0)
      assert.equal(number(116, 8), 0)
      assert.equal(number(136, 12), 0)
      offset += 512 + Math.ceil(number(124, 12) / 512) * 512
    }
  }
})
test('installed embedded dependencies use the complete matching vendored cohort', () => {
  for (const name of names) {
    const manifest = desktopRequire(`@standardnotes/${name}/package.json`)
    assert.equal(manifest.version, require(`./${name}/package.json`).version)
    assert.ok(installed(name))
  }
})
test('direct event delivery awaits handlers and propagates errors', async () => {
  const { DirectCallDomainEventPublisher, DirectCallEventMessageHandler } = installed('domain-events-infra')
  const publisher = new DirectCallDomainEventPublisher()
  const events = []
  const event = { type: 'test', payload: { value: 1 } }
  publisher.register(
    new DirectCallEventMessageHandler(new Map([['test', { handle: async (value) => events.push(value) }]]), {
      debug() {},
    }),
  )
  await publisher.publish(event)
  assert.deepEqual(events, [event])
  publisher.register({
    handleMessage: async () => {
      throw new Error('handler failure')
    },
  })
  await assert.rejects(publisher.publish(event), /handler failure/)
})
test('JWT round trip and invalid expiration retain upstream validation', () => {
  const { TokenEncoder, TokenDecoder } = installed('security')
  const encoder = new TokenEncoder('test-only-secret')
  const decoder = new TokenDecoder('test-only-secret')
  assert.equal(decoder.decodeToken(encoder.encodeExpirableToken({ value: 42 }, '1h')).value, 42)
  assert.equal(new TokenDecoder('different-secret').decodeToken(encoder.encodeToken({ value: 42 })), undefined)
  assert.throws(() => encoder.encodeExpirableToken({ value: 42 }, 'invalid expiration'))
})
test('UTC timer loads its CommonJS plugin correctly', () => {
  const { Timer } = installed('time')
  assert.equal(new Timer().convertStringDateToMilliseconds('2020-01-01T00:00:00Z'), 1577836800000)
})
test('published home-server imports without starting and remains loopback patched', () => {
  const home = desktopRequire('@standardnotes/home-server')
  assert.equal(typeof home.HomeServer, 'function')
  const manifest = desktopRequire.resolve('@standardnotes/home-server/package.json')
  const source = fs.readFileSync(path.join(path.dirname(manifest), 'dist/src/Server/HomeServer.js'), 'utf8')
  assert.match(source, /server\.build\(\)\.listen\(port, ['"]127\.0\.0\.1['"]\)/)
  assert.doesNotMatch(source, /server\.build\(\)\.listen\(port\)/)
})
