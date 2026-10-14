const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const loader = require('./LibsodiumWasmLoader.cjs')

const lowSource = fs.readFileSync(require.resolve('libsodium-sumo'), 'utf8')
const wrapperSource = fs.readFileSync(require.resolve('libsodium-wrappers-sumo'), 'utf8')

test('emits the exact upstream WASM and loads it through a real URL with working crypto', async () => {
  let asset
  const transformed = loader.call(
    {
      emitFile: (name, bytes) => {
        asset = { name, bytes }
      },
    },
    lowSource,
  )
  const originalBytes = Buffer.from(lowSource.match(/"(AGFzbQE[A-Za-z0-9+/=]+)"/)[1], 'base64')
  assert.deepEqual(asset.bytes, originalBytes)
  assert.equal(WebAssembly.validate(asset.bytes), true)
  assert.match(asset.name, /^libsodium-sumo\.[a-f0-9]{20}\.wasm$/)
  const urls = []
  const lowModule = { exports: {} }
  const sandbox = {
    module: lowModule,
    exports: lowModule.exports,
    require,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    URL,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    __dirname: __dirname,
    __webpack_public_path__: '/',
    location: { origin: 'https://notes.test', href: 'https://notes.test/' },
    fetch: async (url) => {
      urls.push(url)
      return new Response(asset.bytes, { headers: { 'Content-Type': 'application/wasm' } })
    },
  }
  sandbox.global = sandbox
  vm.runInNewContext(transformed, sandbox)
  await lowModule.exports.ready
  const wrapper = { exports: {} }
  vm.runInNewContext(wrapperSource, {
    ...sandbox,
    module: wrapper,
    exports: wrapper.exports,
    require: (name) => (name === 'libsodium-sumo' ? lowModule.exports : require(name)),
  })
  await wrapper.exports.ready
  assert.deepEqual(urls, [`https://notes.test/${asset.name}`])
  assert.equal(
    wrapper.exports.crypto_hash_sha256('abc', 'hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  const nonce = new Uint8Array(24)
  const key = new Uint8Array(32)
  const ciphertext = wrapper.exports.crypto_aead_xchacha20poly1305_ietf_encrypt('note', null, null, nonce, key)
  assert.equal(
    wrapper.exports.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, null, nonce, key, 'text'),
    'note',
  )
})

test('refuses an unknown upstream format instead of changing crypto silently', () => {
  assert.throws(() => loader.call({ emitFile() {} }, 'unknown'), /Unexpected libsodium/)
})
