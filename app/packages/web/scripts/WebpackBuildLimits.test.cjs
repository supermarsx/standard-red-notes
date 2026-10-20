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
