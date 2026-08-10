const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { commandArguments, pruneLinuxNativePrebuilds } = require('./pruneLinuxNativePrebuilds')

const CBOR_TARGETS = [
  'cbor-extract-darwin-arm64',
  'cbor-extract-darwin-x64',
  'cbor-extract-linux-arm',
  'cbor-extract-linux-arm64',
  'cbor-extract-linux-x64',
  'cbor-extract-win32-x64',
]
const MICROTIME_TARGETS = ['darwin-x64+arm64', 'linux-arm', 'linux-arm64', 'linux-x64', 'win32-ia32', 'win32-x64']

async function nativeGraph(nodeModules, { omitCbor, omitMicrotime } = {}) {
  const cbor = path.join(nodeModules, '@cbor-extract')
  const microtime = path.join(nodeModules, 'microtime', 'prebuilds')
  await fs.promises.mkdir(cbor, { recursive: true })
  await fs.promises.mkdir(microtime, { recursive: true })
  for (const target of CBOR_TARGETS.filter((target) => target !== omitCbor)) {
    await fs.promises.mkdir(path.join(cbor, target))
    await fs.promises.writeFile(path.join(cbor, target, 'binding.node'), target)
  }
  for (const target of MICROTIME_TARGETS.filter((target) => target !== omitMicrotime)) {
    await fs.promises.mkdir(path.join(microtime, target))
    await fs.promises.writeFile(path.join(microtime, target, 'binding.node'), target)
  }
  return { cbor, microtime, nodeModules }
}

async function fixture(t, { omitCopiedCbor, omitCopiedMicrotime } = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'srn-native-prebuilds-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const source = await nativeGraph(path.join(root, 'node_modules'))
  const copied = await nativeGraph(path.join(root, 'app', 'dist', 'node_modules'), {
    omitCbor: omitCopiedCbor,
    omitMicrotime: omitCopiedMicrotime,
  })
  return { graphs: [source, copied], nodeModulesDirectories: [source.nodeModules, copied.nodeModules] }
}

async function directories(directory) {
  return (await fs.promises.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function assertExactTarget(graphs, architecture) {
  for (const { cbor, microtime } of graphs) {
    assert.deepEqual(await directories(cbor), [`cbor-extract-linux-${architecture}`])
    assert.deepEqual(await directories(microtime), [`linux-${architecture}`])
  }
}

async function assertOriginalTargets(graphs, { copiedMicrotime = MICROTIME_TARGETS } = {}) {
  for (const [index, { cbor, microtime }] of graphs.entries()) {
    assert.deepEqual(await directories(cbor), [...CBOR_TARGETS].sort())
    assert.deepEqual(await directories(microtime), [...(index === 1 ? copiedMicrotime : MICROTIME_TARGETS)].sort())
  }
}

test('x64 pruning keeps only x64 Linux native prebuilds in both packaged graphs', async (t) => {
  const { graphs, nodeModulesDirectories } = await fixture(t)
  const removed = await pruneLinuxNativePrebuilds(nodeModulesDirectories, 'x64')

  await assertExactTarget(graphs, 'x64')
  assert.equal(removed.length, 2 * (CBOR_TARGETS.length + MICROTIME_TARGETS.length - 2))
})

test('arm64 pruning keeps only arm64 Linux native prebuilds in both packaged graphs', async (t) => {
  const { graphs, nodeModulesDirectories } = await fixture(t)
  const removed = await pruneLinuxNativePrebuilds(nodeModulesDirectories, 'arm64')

  await assertExactTarget(graphs, 'arm64')
  assert.equal(removed.length, 2 * (CBOR_TARGETS.length + MICROTIME_TARGETS.length - 2))
})

test('unknown Linux architecture is rejected without pruning', async (t) => {
  const { graphs, nodeModulesDirectories } = await fixture(t)

  await assert.rejects(
    pruneLinuxNativePrebuilds(nodeModulesDirectories, 'riscv64'),
    /Unsupported Linux native prebuild architecture/,
  )
  await assertOriginalTargets(graphs)
})

test('missing expected target in copied graph is rejected before any graph is pruned', async (t) => {
  const { graphs, nodeModulesDirectories } = await fixture(t, { omitCopiedMicrotime: 'linux-arm64' })
  const copiedMicrotime = MICROTIME_TARGETS.filter((target) => target !== 'linux-arm64')

  await assert.rejects(
    pruneLinuxNativePrebuilds(nodeModulesDirectories, 'arm64'),
    /missing expected target linux-arm64/,
  )
  await assertOriginalTargets(graphs, { copiedMicrotime })
})

test('CLI requires both real desktop build node_modules paths', () => {
  assert.deepEqual(
    commandArguments(['--arch', 'x64', '--node-modules', 'node_modules', '--node-modules', 'app/dist/node_modules']),
    {
      architecture: 'x64',
      nodeModulesDirectories: ['node_modules', 'app/dist/node_modules'],
    },
  )
  assert.throws(
    () => commandArguments(['--arch', 'x64', '--node-modules', 'node_modules']),
    /exactly two --node-modules/,
  )
})
