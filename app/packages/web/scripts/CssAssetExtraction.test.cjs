const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const webpack = require('webpack')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const configuration = require('../web.webpack.config')({})

test('CSS and SCSS extraction preserve relative assets without executing browser import.meta in Node', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-css-extraction-'))
  const rules = configuration.module.rules.filter(
    (rule) => rule.test?.test('fixture.css') || rule.test?.test('fixture.scss'),
  )
  // Keep the real extraction/css/sass settings; Tailwind processing is unrelated to asset URL evaluation.
  const fixtureRules = rules.map((rule) => ({
    ...rule,
    use: rule.use
      .filter((loader) => loader !== 'postcss-loader')
      .map((loader) =>
        typeof loader === 'string' ? require.resolve(loader) : { ...loader, loader: require.resolve(loader.loader) },
      ),
  }))
  let compiler
  try {
    await fs.writeFile(
      path.join(directory, 'index.js'),
      'import "./style.css"; import "./style.scss"; globalThis.noteBase = import.meta.url;',
    )
    await fs.writeFile(
      path.join(directory, 'style.css'),
      '@font-face{font-family:test;src:url("./font.woff2")} .css{background:url("./image.svg")}',
    )
    await fs.writeFile(
      path.join(directory, 'style.scss'),
      '$color: red; .scss{color:$color;background:url("./image.svg")} .external{background:url("https://example.com/image.svg")}',
    )
    await fs.writeFile(path.join(directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await fs.writeFile(path.join(directory, 'font.woff2'), 'fixture-font')
    compiler = webpack({
      mode: 'production',
      context: directory,
      entry: './index.js',
      cache: false,
      output: {
        path: path.join(directory, 'dist'),
        filename: 'app.js',
        publicPath: '/',
        importMetaName: configuration.output.importMetaName,
        assetModuleFilename: 'assets/[name][ext]',
      },
      module: {
        parser: configuration.module.parser,
        rules: [...fixtureRules, { test: /\.(svg|woff2)$/, type: 'asset/resource' }],
      },
      plugins: [new MiniCssExtractPlugin({ filename: 'app.css' })],
    })
    const stats = await new Promise((resolve, reject) =>
      compiler.run((error, result) => (error ? reject(error) : resolve(result))),
    )
    assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true, errorDetails: true }))
    const css = await fs.readFile(path.join(directory, 'dist/app.css'), 'utf8')
    assert.match(css, /\.\.\/assets\/font\.woff2/)
    assert.equal((css.match(/\.\.\/assets\/image\.svg/g) || []).length, 2)
    assert.match(css, /https:\/\/example\.com\/image\.svg/)
    assert.doesNotMatch(css, /file:\/\/|webpack:\/\/|mini-css-extract-plugin/)
    const bundle = await fs.readFile(path.join(directory, 'dist/app.js'), 'utf8')
    const browser = { document: { baseURI: 'https://notes.example/nested/' } }
    vm.runInNewContext(bundle, browser)
    assert.equal(browser.noteBase, browser.document.baseURI)
    assert.doesNotMatch(bundle, /file:\/\//)
  } finally {
    if (compiler) await new Promise((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())))
    await fs.rm(directory, { recursive: true, force: true })
  }
})
