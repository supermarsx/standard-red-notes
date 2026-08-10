const fs = require('node:fs')
const path = require('node:path')

const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64'])

async function realDirectoryEntries(directory, description) {
  let stat
  try {
    stat = await fs.promises.lstat(directory)
  } catch (error) {
    throw new Error(`Missing ${description}: ${directory}`, { cause: error })
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory: ${directory}`)
  }
  return fs.promises.readdir(directory, { withFileTypes: true })
}

async function nativeDirectoryInventory(directory, description, matches) {
  const entries = (await realDirectoryEntries(directory, description)).filter((entry) => matches(entry.name))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`${description} entry must be a real directory: ${entry.name}`)
    }
  }
  return entries.map((entry) => entry.name).sort()
}

async function pruneLinuxNativePrebuilds(nodeModulesDirectories, architecture) {
  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    throw new Error(`Unsupported Linux native prebuild architecture: ${architecture}`)
  }
  if (!Array.isArray(nodeModulesDirectories) || nodeModulesDirectories.length !== 2) {
    throw new Error('Exactly two desktop runtime node_modules directories are required')
  }

  const nodeModulesRoots = nodeModulesDirectories.map((directory) => path.resolve(directory))
  if (new Set(nodeModulesRoots).size !== nodeModulesRoots.length) {
    throw new Error('Desktop runtime node_modules directories must be distinct')
  }

  const plans = []
  for (const nodeModules of nodeModulesRoots) {
    if (path.basename(nodeModules) !== 'node_modules' || path.parse(nodeModules).root === nodeModules) {
      throw new Error(`Native prebuild root must be a node_modules directory: ${nodeModules}`)
    }
    await realDirectoryEntries(nodeModules, 'desktop runtime node_modules')
    plans.push(
      {
        nodeModules,
        directory: path.join(nodeModules, '@cbor-extract'),
        description: `${nodeModules} @cbor-extract native packages`,
        expected: `cbor-extract-linux-${architecture}`,
        matches: (name) => name.startsWith('cbor-extract-'),
      },
      {
        nodeModules,
        directory: path.join(nodeModules, 'microtime', 'prebuilds'),
        description: `${nodeModules} microtime native prebuilds`,
        expected: `linux-${architecture}`,
        matches: () => true,
      },
    )
  }

  for (const plan of plans) {
    plan.inventory = await nativeDirectoryInventory(plan.directory, plan.description, plan.matches)
    if (!plan.inventory.includes(plan.expected)) {
      throw new Error(`${plan.description} is missing expected target ${plan.expected}`)
    }
  }

  const removed = []
  for (const plan of plans) {
    for (const entry of plan.inventory) {
      if (entry === plan.expected) {
        continue
      }
      const candidate = path.join(plan.directory, entry)
      if (path.dirname(candidate) !== plan.directory) {
        throw new Error(`Native prebuild path escaped its fixed parent: ${candidate}`)
      }
      await fs.promises.rm(candidate, { recursive: true, force: false })
      const relative = path.relative(plan.nodeModules, candidate).split(path.sep).join('/')
      removed.push(`${plan.nodeModules}:${relative}`)
    }
    const remaining = await nativeDirectoryInventory(plan.directory, plan.description, plan.matches)
    if (remaining.length !== 1 || remaining[0] !== plan.expected) {
      throw new Error(`${plan.description} retained unexpected targets: ${remaining.join(', ')}`)
    }
  }

  return removed.sort()
}

function commandArguments(arguments_) {
  let architecture
  const nodeModulesDirectories = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Invalid native prebuild pruning arguments: ${arguments_.join(' ')}`)
    }
    if (flag === '--arch' && architecture === undefined) {
      architecture = value
    } else if (flag === '--node-modules') {
      nodeModulesDirectories.push(value)
    } else {
      throw new Error(`Invalid native prebuild pruning arguments: ${arguments_.join(' ')}`)
    }
    index += 1
  }
  if (!architecture || nodeModulesDirectories.length !== 2) {
    throw new Error('One --arch and exactly two --node-modules arguments are required')
  }
  return { architecture, nodeModulesDirectories }
}

async function main() {
  const options = commandArguments(process.argv.slice(2))
  const removed = await pruneLinuxNativePrebuilds(options.nodeModulesDirectories, options.architecture)
  console.log(`Pruned ${removed.length} foreign Linux native prebuild directories for ${options.architecture}:`)
  for (const entry of removed) {
    console.log(`  ${entry}`)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

module.exports = { commandArguments, pruneLinuxNativePrebuilds }
