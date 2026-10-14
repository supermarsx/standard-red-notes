/* Return the stable emitted URL; a blob URL would create a different worker per tab. */
module.exports = function sharedWorkerUrl(source) {
  const match = /return new Worker\((__webpack_public_path__ \+ "[^"\n]+")\);/.exec(source)
  if (!match) {
    throw new Error('The shared sync worker must have a stable emitted URL')
  }
  return `export default ${match[1]};\n`
}
