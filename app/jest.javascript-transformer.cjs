const ts = require('typescript')
const { createHash } = require('node:crypto')
const fs = require('node:fs')

// Dependency JavaScript needs module conversion, not a second checked TS program.
// ts-jest shares config sets within a project, so keep this transformer separate
// from the typechecked application/test TypeScript transformer.
const compilerOptions = {
  allowJs: true,
  isolatedModules: true,
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  sourceMap: true,
  inlineSources: true,
}
const identity = fs.readFileSync(__filename, 'utf8') + ts.version

module.exports = {
  getCacheKey(source, filename, options) {
    return createHash('sha256')
      .update(identity)
      .update(source)
      .update(filename)
      .update(options.configString)
      .update(String(options.instrument))
      .digest('hex')
  },
  process(source, filename) {
    const result = ts.transpileModule(source, { fileName: filename, compilerOptions })
    return { code: result.outputText, map: result.sourceMapText }
  },
}
