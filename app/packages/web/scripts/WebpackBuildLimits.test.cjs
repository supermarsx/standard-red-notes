const assert = require('node:assert/strict')
const { test } = require('node:test')
const productionConfig = require('../web.webpack.prod.js')

function withLimits(values, run) {
  const names = ['WEBPACK_PARALLELISM', 'WEBPACK_MINIFY_WORKERS']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name]
      else process.env[name] = values[name]
    }
    run()
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

test('production caps concurrency while preserving compression and source-map policy', () => {
  withLimits({}, () => {
    const config = productionConfig({}, {})
    assert.equal(config.parallelism, 32)
    assert.equal(config.devtool, false)
    assert.equal(config.optimization.minimizer.length, 1)
    const options = config.optimization.minimizer[0].options
    assert.equal(options.parallel, 2)
    assert.equal(options.minimizer.options.compress.passes, 2)
  })
})

test('operators can select serial minimization and lower module concurrency', () => {
  withLimits({ WEBPACK_PARALLELISM: '8', WEBPACK_MINIFY_WORKERS: '0' }, () => {
    const config = productionConfig({}, {})
    assert.equal(config.parallelism, 8)
    assert.equal(config.optimization.minimizer[0].options.parallel, false)
  })
})

test('invalid limits fail clearly instead of enabling automatic worker fan-out', () => {
  for (const value of ['-1', '1.5', 'many', '65']) {
    withLimits({ WEBPACK_MINIFY_WORKERS: value }, () => {
      assert.throws(() => productionConfig({}, {}), /WEBPACK_MINIFY_WORKERS must be an integer/)
    })
  }
  withLimits({ WEBPACK_PARALLELISM: '0' }, () => {
    assert.throws(() => productionConfig({}, {}), /WEBPACK_PARALLELISM must be an integer/)
  })
})

test('vendor exclusion works on Windows and Linux without transforming sodium before its WASM loader', () => {
  const config = productionConfig({}, {})
  const rule = config.module.rules.find((rule) => rule.use?.some?.((use) => use.loader === 'esbuild-loader'))
  assert.ok(rule)
  for (const separator of ['/', '\\']) {
    const vendor = ['project', 'node_modules', 'libsodium-sumo', 'dist', 'modules-sumo', 'libsodium-sumo.js'].join(
      separator,
    )
    assert.equal(rule.exclude.test(vendor), true)
    const allowed = ['project', 'node_modules', '@standardnotes', 'common', 'index.js'].join(separator)
    assert.equal(rule.exclude.test(allowed), false)
  }
})

test('Node build contracts have their own mandatory runner without excluding application Jest suites', () => {
  const { scripts } = require('../package.json')
  const jestConfig = require('../jest.config.js')
  const ignored = (path) =>
    jestConfig.testPathIgnorePatterns.some((pattern) =>
      new RegExp(pattern.replace('<rootDir>', '/web')).test(`/web/${path}`),
    )
  assert.equal(ignored('scripts/GuardTextSizeAdjust.test.cjs'), true)
  assert.equal(ignored('scripts/WebpackBuildLimits.test.cjs'), true)
  assert.equal(ignored('src/javascripts/example.spec.tsx'), false)
  assert.equal(ignored('src/javascripts/example.test.ts'), false)
  assert.equal(scripts['lint:css-compat'], 'node --test scripts/GuardTextSizeAdjust.test.cjs')
  assert.equal(scripts['lint:build-config'], 'node --test scripts/WebpackBuildLimits.test.cjs')
  assert.ok(scripts.lint.split(' && ').includes('yarn lint:css-compat'))
  assert.ok(scripts.lint.split(' && ').includes('yarn lint:build-config'))
})
