const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function findManifestFromPath(resolvedPath) {
  let directory = resolvedPath
  if (!fs.statSync(directory).isDirectory()) {
    directory = path.dirname(directory)
  }

  while (true) {
    const manifestPath = path.join(directory, 'package.json')
    if (fs.existsSync(manifestPath)) {
      return manifestPath
    }

    const parent = path.dirname(directory)
    if (parent === directory) {
      throw new Error(`Unable to find package.json for ${resolvedPath}`)
    }
    directory = parent
  }
}

function resolveManifest(packageName, issuerManifestPath) {
  const issuerRequire = createRequire(issuerManifestPath)

  try {
    return issuerRequire.resolve(`${packageName}/package.json`)
  } catch (directResolutionError) {
    for (const searchPath of issuerRequire.resolve.paths(packageName) || []) {
      const manifestPath = path.join(searchPath, packageName, 'package.json')
      if (fs.existsSync(manifestPath)) {
        return manifestPath
      }
    }

    try {
      return findManifestFromPath(issuerRequire.resolve(packageName))
    } catch {
      try {
        const pnpApi = issuerRequire('pnpapi')
        const unqualifiedPath = pnpApi.resolveToUnqualified(packageName, issuerManifestPath)
        return findManifestFromPath(unqualifiedPath)
      } catch {
        throw directResolutionError
      }
    }
  }
}

function collectDependencyGraph(appManifestPath) {
  const nodes = new Map()
  const requests = new Map()
  const incomingCounts = new Map()

  function visit(packageName, issuerManifestPath, optional) {
    let manifestPath
    try {
      manifestPath = resolveManifest(packageName, issuerManifestPath)
    } catch (error) {
      if (optional) {
        return undefined
      }
      throw error
    }

    let node = nodes.get(manifestPath)
    if (!node) {
      const manifest = readManifest(manifestPath)
      node = {
        id: manifestPath,
        manifest,
        root: path.dirname(manifestPath),
        edges: [],
      }
      nodes.set(manifestPath, node)

      const dependencies = manifest.dependencies || {}
      const optionalDependencies = manifest.optionalDependencies || {}
      const dependencyNames = new Set([...Object.keys(dependencies), ...Object.keys(optionalDependencies)])

      for (const dependencyName of dependencyNames) {
        const dependencyNode = visit(
          dependencyName,
          manifestPath,
          Object.prototype.hasOwnProperty.call(optionalDependencies, dependencyName),
        )
        if (dependencyNode) {
          node.edges.push({ request: dependencyName, node: dependencyNode })
        }
      }
    }

    const candidates = requests.get(packageName) || new Map()
    candidates.set(node.id, node)
    requests.set(packageName, candidates)

    const incomingKey = `${packageName}\0${node.id}`
    incomingCounts.set(incomingKey, (incomingCounts.get(incomingKey) || 0) + 1)
    return node
  }

  const appManifest = readManifest(appManifestPath)
  const roots = new Map()
  for (const packageName of Object.keys(appManifest.dependencies || {})) {
    roots.set(packageName, visit(packageName, appManifestPath, false))
  }

  return { requests, incomingCounts, roots }
}

function preferredPackages(graph) {
  const preferred = new Map(graph.roots)

  for (const [packageName, candidates] of graph.requests) {
    if (preferred.has(packageName)) {
      continue
    }

    const candidate = [...candidates.values()].sort((left, right) => {
      const leftCount = graph.incomingCounts.get(`${packageName}\0${left.id}`) || 0
      const rightCount = graph.incomingCounts.get(`${packageName}\0${right.id}`) || 0
      return rightCount - leftCount || left.id.localeCompare(right.id)
    })[0]
    preferred.set(packageName, candidate)
  }

  return preferred
}

function copyPattern(node, target) {
  const bundledDependencies = node.manifest.bundleDependencies || node.manifest.bundledDependencies
  const globOptions = { dot: true }
  if (!bundledDependencies || bundledDependencies.length === 0) {
    globOptions.ignore = ['**/node_modules/**']
  }

  return {
    context: node.root,
    from: '**/*',
    to: target.split(path.sep).join('/'),
    // Package names can contain dots (for example, `fn.name`). Without an
    // explicit directory target, CopyWebpackPlugin treats those names as
    // filenames and repeatedly overwrites the package with each source file.
    toType: 'dir',
    globOptions,
  }
}

module.exports = function runtimeDependencyCopyPatterns(appManifestPath) {
  const graph = collectDependencyGraph(appManifestPath)
  const preferred = preferredPackages(graph)
  const patterns = []
  const copiedTargets = new Map()
  const topLevelPackages = new Map([...preferred].map(([name, node]) => [name, node.id]))

  function addPackage(packageName, node, target, availablePackages) {
    const existingNode = copiedTargets.get(target)
    if (existingNode) {
      if (existingNode !== node.id) {
        throw new Error(`Conflicting runtime packages for ${target}`)
      }
      return
    }

    copiedTargets.set(target, node.id)
    patterns.push(copyPattern(node, target))

    const childPackages = new Map(availablePackages)
    childPackages.set(packageName, node.id)

    for (const edge of node.edges) {
      if (childPackages.get(edge.request) === edge.node.id) {
        continue
      }
      addPackage(edge.request, edge.node, path.join(target, 'node_modules', edge.request), childPackages)
    }
  }

  for (const [packageName, node] of preferred) {
    addPackage(packageName, node, path.join('node_modules', packageName), topLevelPackages)
  }

  return patterns
}
