const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const desktop = path.resolve(__dirname, '../packages/desktop/app')
const ts = require(require.resolve('typescript', { paths: [desktop] }))
const packages = [
  'predicates',
  'security',
  'common',
  'time',
  'sncrypto-node',
  'domain-events',
  'grpc',
  'domain-events-infra',
]
const verifyOnly = process.argv.includes('--verify')
const checkBuild = process.argv.includes('--check')
const artifactPath = path.join(__dirname, 'artifacts.json')
const artifacts = {}
// Keep originals immutable. Future reviewed source fixes are explicit, exact replacements.
const patches = require('./source-patches.json')
for (const patch of patches) {
  if (
    typeof patch.path !== 'string' ||
    !/^[a-z-]+\/src\/.+\.ts$/.test(patch.path) ||
    patch.path.includes('..') ||
    patch.path.endsWith('.spec.ts') ||
    typeof patch.before !== 'string' ||
    !patch.before ||
    typeof patch.after !== 'string'
  ) {
    throw new Error('Invalid vendored source patch')
  }
  const [name, ...parts] = patch.path.split('/')
  if (
    !packages.includes(name) ||
    !require(`./${name}/provenance.json`).sourceBlobs.some(
      (entry) => entry.path === `packages/${name}/${parts.join('/')}`,
    )
  ) {
    throw new Error(`Patch does not target a verified upstream source: ${patch.path}`)
  }
}
function collectArtifacts(directory, relative = '') {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const next = path.join(directory, entry.name)
    const key = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectArtifacts(next, key)
    else artifacts[key] = crypto.createHash('sha256').update(fs.readFileSync(next)).digest('hex')
  }
}
for (const name of packages) {
  const directory = path.join(__dirname, name)
  const provenance = require(path.join(directory, 'provenance.json'))
  for (const entry of provenance.sourceBlobs) {
    const relative = entry.path.replace(`packages/${name}/`, '')
    const contents = fs.readFileSync(
      path.join(directory, relative === 'package.json' ? 'upstream-package.json' : relative),
    )
    const hash = crypto.createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex')
    if (hash !== entry.sha) throw new Error(`Upstream source checksum mismatch: ${name}/${relative}`)
  }
  const licenseHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(directory, 'LICENSE')))
    .digest('hex')
  if (licenseHash !== provenance.licenseSha256) throw new Error(`License checksum mismatch: ${name}`)
  if (verifyOnly || name === 'grpc') continue // grpc's generated JS/declarations are verified upstream blobs.
  const configFile = ts.readConfigFile(path.join(directory, 'tsconfig.build.json'), ts.sys.readFile)
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, directory)
  const installedManifest = require.resolve(`@standardnotes/${name}/package.json`, { paths: [desktop] })
  const installedSource = path.join(path.dirname(installedManifest), 'src/index.ts')
  const host = ts.createCompilerHost(config.options)
  const readSource = host.readFile.bind(host)
  host.readFile = (file) => {
    let source = readSource(file)
    const relative = path.relative(__dirname, file).split(path.sep).join('/')
    for (const patch of patches.filter((entry) => entry.path === relative)) {
      if (source === undefined || !patch.before || source.split(patch.before).length !== 2) {
        throw new Error(`Source patch must match exactly once: ${relative}`)
      }
      source = source.replace(patch.before, patch.after)
    }
    return source
  }
  host.resolveModuleNames = (names, containingFile) =>
    names.map((moduleName) => {
      const cohortName = moduleName.replace('@standardnotes/', '')
      if (packages.includes(cohortName)) {
        const manifest = require(path.join(__dirname, cohortName, 'package.json'))
        return { resolvedFileName: path.join(__dirname, cohortName, manifest.types), extension: ts.Extension.Dts }
      }
      return (
        ts.resolveModuleName(
          moduleName,
          moduleName.startsWith('.') ? containingFile : installedSource,
          config.options,
          host,
        ).resolvedModule ||
        ts.resolveModuleName(moduleName, path.join(desktop, 'index.ts'), config.options, host).resolvedModule
      )
    })
  if (checkBuild)
    host.writeFile = (file, contents) => {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents)
        throw new Error(`Rebuild differs: ${file}`)
    }
  const program = ts.createProgram(config.fileNames, config.options, host)
  const result = program.emit()
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program), ...result.diagnostics]
  if (diagnostics.length)
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => directory,
        getNewLine: () => '\n',
      }),
    )
  if (result.emitSkipped || diagnostics.some((entry) => entry.category === ts.DiagnosticCategory.Error)) process.exit(1)
  console.log(`Built ${name} from verified upstream source`)
}
for (const name of packages)
  collectArtifacts(
    path.join(__dirname, name, name === 'grpc' ? 'lib' : 'dist'),
    `${name}/${name === 'grpc' ? 'lib' : 'dist'}`,
  )
const artifactManifest =
  JSON.stringify(
    {
      compilerVersion: ts.version,
      patchesSha256: crypto.createHash('sha256').update(JSON.stringify(patches)).digest('hex'),
      artifacts,
    },
    null,
    2,
  ) + '\n'
if (verifyOnly || checkBuild) {
  if (fs.readFileSync(artifactPath, 'utf8') !== artifactManifest)
    throw new Error('Vendored artifact hashes or compiler version differ; rebuild and review the artifact manifest')
} else fs.writeFileSync(artifactPath, artifactManifest)
require('./package-upstream.cjs').packageUpstream(verifyOnly || checkBuild)
console.log(verifyOnly ? 'All upstream sources verified' : 'All vendored packages built')
