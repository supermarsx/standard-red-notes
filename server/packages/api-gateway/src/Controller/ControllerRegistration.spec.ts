import * as fs from 'fs'
import * as path from 'path'

/**
 * Standard Red Notes: guard against "dead controller" regressions.
 *
 * inversify-express-utils only registers a controller if its MODULE is actually
 * imported at bootstrap. The two bootstrap paths load controllers differently:
 *
 *  - standalone gateway (`bin/server.ts`): explicit side-effect imports
 *  - home-server (`@standardnotes/api-gateway` package root): `src/index.ts`
 *    -> `export * from './Controller'` (this barrel)
 *
 * A controller exported from the barrel but not imported in `bin/server.ts`
 * compiles clean yet 404s on a live standalone gateway (this happened to
 * /v1/webhooks). This spec statically cross-checks the two lists.
 */
describe('controller bootstrap registration', () => {
  const controllerDir = __dirname
  const binServerPath = path.join(controllerDir, '..', '..', 'bin', 'server.ts')
  const barrelPath = path.join(controllerDir, 'index.ts')

  const binServerSource = fs.readFileSync(binServerPath, 'utf-8')
  const barrelSource = fs.readFileSync(barrelPath, 'utf-8')

  const routeControllersFrom = (source: string, importPattern: RegExp): string[] => {
    const modules: string[] = []
    for (const match of source.matchAll(importPattern)) {
      modules.push(match[1])
    }
    // Only versioned route controllers (v1/v2) participate in the cross-check.
    // Root-level modules differ intentionally between the two bootstrap paths
    // (LegacyController is standalone-only, FallbackController home-server-only:
    // both mount at @controller('') and must not coexist).
    return modules.filter((modulePath) => /^v\d+\//.test(modulePath)).sort()
  }

  const binImports = routeControllersFrom(binServerSource, /^import '\.\.\/src\/Controller\/(.+)'$/gm)
  const barrelExports = routeControllersFrom(barrelSource, /^export \* from '\.\/(.+)'$/gm)

  it('finds controllers in both bootstrap files (sanity check)', () => {
    expect(binImports.length).toBeGreaterThan(0)
    expect(barrelExports.length).toBeGreaterThan(0)
  })

  it('imports every barrel-exported route controller in bin/server.ts (standalone gateway)', () => {
    const missingFromStandalone = barrelExports.filter((modulePath) => !binImports.includes(modulePath))

    expect(missingFromStandalone).toEqual([])
  })

  it('imports only controller modules that exist on disk in bin/server.ts', () => {
    const missingFiles = binImports.filter(
      (modulePath) => !fs.existsSync(path.join(controllerDir, `${modulePath}.ts`)),
    )

    expect(missingFiles).toEqual([])
  })
})
