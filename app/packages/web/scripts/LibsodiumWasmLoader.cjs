const { createHash } = require('node:crypto')

/** Give embedded sodium WASM a real URL for streaming compilation and debugger metadata. */
module.exports = function libsodiumWasmLoader(source) {
  const binaries = [...source.matchAll(/"(AGFzbQE[A-Za-z0-9+/=]+)"/g)]
  const calls = [...source.matchAll(/WebAssembly\.instantiate\(([$\w]+),([$\w]+)\)/g)]
  if (binaries.length !== 1 || calls.length !== 1) {
    throw new Error('Unexpected libsodium WASM format; review the streaming loader before upgrading sodium.')
  }
  const bytes = Buffer.from(binaries[0][1], 'base64')
  if (!WebAssembly.validate(bytes)) {
    throw new Error('The embedded libsodium module is not valid WebAssembly.')
  }
  const filename = `libsodium-sumo.${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}.wasm`
  this.emitFile(filename, bytes)
  const imports = calls[0][2]
  // The URL is absolute even in worker-loader's blob fallback. Its parent bundle
  // uses ../ relative publicPath, while the WASM asset is emitted at the app root.
  const base =
    "(globalThis.location.href.startsWith('blob:') ? globalThis.location.origin + '/' : globalThis.location.href)"
  const url = `new URL(${JSON.stringify(filename)}, new URL(__webpack_public_path__, ${base})).href`
  const replacement = `(WebAssembly.instantiateStreaming ? WebAssembly.instantiateStreaming(fetch(${url}),${imports}) : fetch(${url}).then(response => { if (!response.ok) throw new Error('Unable to load the crypto module.'); return response.arrayBuffer(); }).then(bytes => WebAssembly.instantiate(bytes,${imports})))`
  return source.replace(calls[0][0], replacement).replace(binaries[0][0], '""')
}
