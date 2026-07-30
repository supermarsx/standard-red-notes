import test from 'ava'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

type CopyPattern = {
  to: string
  toType?: string
}

const require = createRequire(import.meta.url)
const runtimeDependencyCopyPatterns = require('../runtime-dependency-copy-patterns') as (
  appManifestPath: string,
) => CopyPattern[]

test('copies dotted dependency names as directories', (t) => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const patterns = runtimeDependencyCopyPatterns(path.join(currentDir, '..', 'app', 'package.json'))
  const dottedPackage = patterns.find(({ to }) => to === 'node_modules/fn.name')

  t.truthy(dottedPackage)
  t.is(dottedPackage?.toType, 'dir')
  t.true(patterns.every(({ toType }) => toType === 'dir'))
})
