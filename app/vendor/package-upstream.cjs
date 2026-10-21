// Portable USTAR archives: never inherit filesystem permission bits or timestamps.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
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
function header(name, size, directory) {
  const bytes = Buffer.alloc(512)
  let basename = name
  if (Buffer.byteLength(name) > 100) {
    const split = name.lastIndexOf('/', 100)
    const prefix = name.slice(0, split)
    basename = name.slice(split + 1)
    if (split < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(basename) > 100)
      throw new Error(`USTAR path too long: ${name}`)
    bytes.write(prefix, 345, 155)
  }
  bytes.write(basename, 0, 100)
  const octal = (value, offset, length) =>
    bytes.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length)
  octal(directory ? 0o755 : 0o644, 100, 8)
  octal(0, 108, 8)
  octal(0, 116, 8)
  octal(size, 124, 12)
  octal(0, 136, 12)
  bytes.fill(32, 148, 156)
  bytes[156] = directory ? 53 : 48
  bytes.write('ustar\0', 257, 6)
  bytes.write('00', 263, 2)
  const sum = bytes.reduce((total, byte) => total + byte, 0)
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return bytes
}
function archive(name) {
  const chunks = []
  function visit(directory, relative) {
    chunks.push(header(relative + '/', 0, true))
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const source = path.join(directory, entry.name)
      const target = relative + '/' + entry.name
      if (entry.isDirectory()) visit(source, target)
      else if (entry.isFile()) {
        const contents = fs.readFileSync(source)
        chunks.push(
          header(target, contents.length, false),
          contents,
          Buffer.alloc((512 - (contents.length % 512)) % 512),
        )
      } else throw new Error(`Unsupported vendored filesystem entry: ${source}`)
    }
  }
  visit(path.join(__dirname, name), 'package')
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}
function packageUpstream(check) {
  const directory = path.join(__dirname, 'archives')
  if (!check) fs.mkdirSync(directory, { recursive: true })
  const hashes = {}
  for (const name of names) {
    const tar = archive(name)
    const filename = `${name}.tgz`
    const destination = path.join(directory, filename)
    if (check) {
      if (!zlib.gunzipSync(fs.readFileSync(destination)).equals(tar))
        throw new Error(`Archive contents differ: ${filename}`)
    } else {
      const compressed = zlib.gzipSync(tar, { level: 9 })
      compressed[9] = 255 // gzip OS is deliberately unspecified, identical on Windows and Unix.
      fs.writeFileSync(destination, compressed)
    }
    hashes[filename] = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
  }
  const manifest = JSON.stringify(hashes, null, 2) + '\n'
  const manifestPath = path.join(directory, 'sha256.json')
  if (check) {
    if (fs.readFileSync(manifestPath, 'utf8') !== manifest) throw new Error('Archive checksum manifest differs')
  } else fs.writeFileSync(manifestPath, manifest)
}
module.exports = { packageUpstream }
if (require.main === module) {
  packageUpstream(process.argv.includes('--check'))
  console.log('Portable vendor archives verified')
}
