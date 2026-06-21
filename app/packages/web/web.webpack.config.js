/* eslint-disable */
const path = require('path')
const webpack = require('webpack')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')
const CircularDependencyPlugin = require('circular-dependency-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const mergeWithEnvDefaults = require('./web.webpack-defaults')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const clipperHtmlTemplate = require('./clipper.htmlTemplate')
require('dotenv').config()

module.exports = (env) => {
  mergeWithEnvDefaults(env)

  const copyPluginPatterns = [
    { from: 'src/favicon', to: 'favicon' },
    { from: 'src/vendor', to: 'dist' },
    { from: 'src/fonts', to: 'assets/fonts' },
    // Excalidraw loads its fonts from window.EXCALIDRAW_ASSET_PATH ('/excalidraw/')
    // -> serve them locally so the drawing block works fully offline (no CDN).
    {
      // require.resolve('@excalidraw/excalidraw') -> .../dist/prod/index.js
      from: path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts'),
      to: 'excalidraw/fonts',
    },
    { from: 'src/404.html' },
    { from: 'src/422.html' },
    { from: 'src/500.html' },
    { from: 'src/index.html' },
    { from: 'src/manifest.webmanifest' },
    {
      // App-shell service worker, served from the server root (scope `/`).
      // It's copied verbatim (not part of the webpack graph), so we inline the
      // current web version here to produce a fresh cache name per deploy.
      from: 'src/service-worker.js',
      transform(content) {
        const version = require('./package.json').version
        // Standard Red Notes: append a per-build fingerprint so the SW cache
        // name changes on EVERY build. Keying solely on package.json version
        // (which rarely changes) meant successive rebuilds reused the same
        // CACHE_NAME, so the activate-handler purge never ran and the browser
        // served a STALE app.js cache-first indefinitely — bug fixes never
        // reached users. SW_BUILD_ID lets CI pin a deterministic id; otherwise
        // the build time guarantees uniqueness.
        const buildId = process.env.SW_BUILD_ID || String(Date.now())
        return content.toString().replace(/__SW_VERSION__/g, `${version}-${buildId}`)
      },
    },
    { from: 'src/robots.txt' },
    { from: 'src/.well-known', to: '.well-known' },
  ]

  if (process.env.BUILD_TARGET !== 'clipper') {
    copyPluginPatterns.push({ from: 'src/components', to: 'components' })
  }

  return {
    entry: './src/javascripts/index.ts',
    // The SN web app is intentionally large and already code-splits its heavy
    // editors (Excalidraw/Mermaid/etc.), so the 244 KiB asset-size recommendation
    // is noise here.
    performance: { hints: false },
    output: {
      filename: process.env.BUILD_TARGET === 'clipper' ? './[name].bundle.js' : './app.js',
    },
    optimization:
      process.env.BUILD_TARGET === 'clipper'
        ? {
            splitChunks: {
              chunks: 'all',
            },
          }
        : {},
    plugins: [
      new CircularDependencyPlugin({
        // exclude detection of files based on a RegExp
        exclude: /a\.js|node_modules/,
        // include specific files based on a RegExp
        include: /app\/assets\/javascripts/,
        // add errors to webpack instead of warnings
        failOnError: true,
        // allow import cycles that include an asyncronous import,
        // e.g. via import(/* webpackMode: "weak" */ './file.js')
        allowAsyncCycles: false,
        // set the current working directory for displaying module paths
        cwd: process.cwd(),
      }),
      new webpack.DefinePlugin({
        __WEB_VERSION__: JSON.stringify(require('./package.json').version),
      }),
      new MiniCssExtractPlugin({
        // Options similar to the same options in webpackOptions.output
        filename: './app.css',
        ignoreOrder: true, // Enable to remove warnings about conflicting order
      }),
      new CopyWebpackPlugin({
        patterns: copyPluginPatterns,
      }),
    ].concat(
      process.env.BUILD_TARGET === 'clipper'
        ? [
            new HtmlWebpackPlugin({
              filename: 'popup.html',
              inject: false,
              templateContent: clipperHtmlTemplate,
            }),
          ]
        : [],
    ),
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.mjs'],
      fallback: {
        crypto: false,
        path: false,
        url: false,
        fs: false,
      },
      alias: {
        '@': path.resolve(__dirname, 'src/javascripts'),
        '@Controllers': path.resolve(__dirname, 'src/javascripts/controllers'),
        '@Services': path.resolve(__dirname, 'src/javascripts/services'),
        // Excalidraw's prod bundle does `require('roughjs/bin/...')`; point all
        // roughjs subpath imports at the copy that actually ships the bin/ dir.
        roughjs: path.dirname(require.resolve('roughjs/package.json')),
      },
    },
    module: {
      rules: [
        {
          test: /\.worker\.tsx?$/,
          loader: 'worker-loader',
          options: {
            inline: 'fallback',
          },
        },
        {
          // PDF.js worker is shipped as a prebuilt .mjs. Emit it as a resource so
          // it's bundled locally and served from our own origin (fully offline,
          // no CDN). The viewer points GlobalWorkerOptions.workerSrc at this URL.
          test: /pdf\.worker(\.min)?\.mjs$/,
          type: 'asset/resource',
          generator: {
            filename: 'assets/pdf/[name][ext]',
          },
        },
        {
          // PDF.js main library is a prebuilt ES module; let webpack consume it as
          // a normal module without running it through babel/ts-loader.
          test: /pdfjs-dist[\\/].*\.mjs$/,
          resolve: {
            fullySpecified: false,
          },
        },
        {
          // Font files referenced via url() from imported stylesheets (e.g. the
          // KaTeX math fonts in katex/dist/katex.min.css). Emitting them as
          // resources keeps math rendering fully offline (no CDN/remote fonts).
          test: /\.(woff2?|ttf|eot)$/,
          type: 'asset/resource',
          generator: {
            filename: 'assets/fonts/[name][ext]',
          },
        },
        {
          test: /\.(js|tsx?)$/,
          /**
           * Exclude all node_modules, except for those we need to run through our babel rules because
           * they may contain class properties and other ES6+ syntax.
           */
          exclude:
            /node_modules\/(?!(@standardnotes\/common|@standardnotes\/domain-core|webextension-polyfill|yoga-layout))/,
          use: [
            // compact output avoids babel's "deoptimised the styling of
            // <large file>" note when it processes big bundles (e.g. snjs.js).
            { loader: 'babel-loader', options: { compact: true } },
            {
              loader: 'ts-loader',
              options: {
                transpileOnly: true,
              },
            },
          ],
        },
        {
          // Pure CSS files (e.g. the Tailwind 4 entry) — postcss processes
          // them with @tailwindcss/postcss.
          test: /\.css$/,
          use: [
            {
              loader: MiniCssExtractPlugin.loader,
              options: { publicPath: '../' },
            },
            'css-loader',
            'postcss-loader',
          ],
        },
        {
          // SCSS files go through sass-loader. We skip postcss here so the
          // @tailwindcss/postcss plugin doesn't try to interpret scss `@layer`
          // blocks. Tailwind theme references inside scss are pulled in via
          // `@reference 'tailwindcss';` (handled by the sass build).
          test: /\.scss$/,
          use: [
            {
              loader: MiniCssExtractPlugin.loader,
              options: { publicPath: '../' },
            },
            'css-loader',
            {
              loader: 'sass-loader',
              // Use the modern Dart Sass API and silence deprecation notices for
              // syntax the pinned Sass (^1.100) still supports — @import and the
              // legacy globals are slated for removal in Dart Sass 2.0/3.0, but
              // migrating the app's 21-deep @import graph to @use is out of scope
              // for a build-warning cleanup.
              options: {
                api: 'modern',
                sassOptions: {
                  quietDeps: true,
                  silenceDeprecations: ['import', 'legacy-js-api'],
                },
              },
            },
          ],
        },
      ],
    },
  }
}
