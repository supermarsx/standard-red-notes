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
    { from: 'src/sandbox.html' },
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
    // Standard Red Notes: persistent on-disk build cache. Subsequent builds only
    // recompile changed modules, turning the cold ~minutes-long compile into a
    // fraction of that. Invalidated automatically when this config changes. In
    // Docker, mount node_modules/.cache to persist it across image builds.
    cache: {
      type: 'filesystem',
      // Pin the cache dir to the workspace-root node_modules/.cache so a Docker
      // build can persist it across image builds via a BuildKit cache mount
      // (`--mount=type=cache,target=/opt/standard-red-notes/app/node_modules/.cache`
      // in app/Dockerfile). Without an explicit path webpack resolves the nearest
      // node_modules from the compiler context, which may land in
      // packages/web/node_modules and silently miss the mounted directory —
      // making the persistent cache a no-op inside Docker. __dirname is
      // .../app/packages/web, so ../../node_modules is the hoisted app root.
      cacheDirectory: path.resolve(__dirname, '../../node_modules/.cache/webpack'),
      buildDependencies: {
        config: [__filename],
      },
    },
    entry: './src/javascripts/index.ts',
    // The SN web app is intentionally large and already code-splits its heavy
    // editors (Excalidraw/Mermaid/etc.), so the 244 KiB asset-size recommendation
    // is noise here.
    performance: { hints: false },
    output: {
      filename: process.env.BUILD_TARGET === 'clipper' ? './[name].bundle.js' : './app.js',
      // Evaluate dependency import.meta.url references against the browser at
      // runtime. Webpack's default folds them to file:/// paths on the build
      // machine, leaking host paths and triggering Firefox local-file loads.
      importMetaName: "({ url: typeof document === 'undefined' ? globalThis.location.href : document.baseURI })",
    },
    optimization:
      process.env.BUILD_TARGET === 'clipper'
        ? {
            splitChunks: {
              chunks: 'all',
            },
          }
        : // Standard Red Notes: the main web build's index.html loads a single
          // `<script src="./app.js">` (no HtmlWebpackPlugin to inject extra
          // tags), so we must NOT split SYNCHRONOUS entry code into separate
          // chunks — those would never be loaded and the app would break. We
          // deliberately leave optimization empty here: webpack already emits a
          // separate async chunk for every dynamic import() (the lazy editors,
          // Excalidraw, mermaid, katex, PDF viewer, etc.) without any
          // splitChunks config, and those are fetched on demand by the runtime
          // embedded in app.js. Enabling `splitChunks: { chunks: 'all' }` here
          // would require also injecting the resulting initial chunks into the
          // HTML, which is out of scope for a conservative startup tune-up.
          {},
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
      // libsodium's dual Node/browser CJS file contains a guarded
      // require('node:fs'). Normalize the scheme so resolve.fallback can replace
      // it with the existing empty browser fs module.
      new webpack.NormalModuleReplacementPlugin(/^node:fs$/, (resource) => {
        resource.request = 'fs'
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
        // Force the browser-safe CommonJS distributions. The ESM distributions
        // materialize `import.meta.url` as a file:/// build-machine path, which
        // leaks into app.js and makes Firefox attempt to load a local file URL.
        'libsodium-wrappers-sumo$': path.resolve(
          __dirname,
          '../../node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
        ),
        'libsodium-sumo$': path.resolve(
          __dirname,
          '../../node_modules/libsodium-sumo/dist/modules-sumo/libsodium-sumo.js',
        ),
        // Excalidraw's prod bundle does `require('roughjs/bin/...')`; point all
        // roughjs subpath imports at the copy that actually ships the bin/ dir.
        roughjs: path.dirname(require.resolve('roughjs/package.json')),
      },
    },
    module: {
      parser: {
        javascript: {
          importMeta: false,
          url: 'relative',
        },
      },
      rules: [
        {
          test: /\.worker\.tsx?$/,
          loader: 'worker-loader',
          options: {
            inline: 'fallback',
            // Content-hash the emitted (fallback) worker file. The default
            // `[name].worker.js` resolves `[name]` to the single `app` entry, so
            // every worker would emit `app.worker.js`; when one worker module is
            // pulled into more than one chunk webpack emits it twice with
            // differing content → "Multiple assets emit ... app.worker.js".
            // A content hash makes each emission's filename unique (identical
            // content dedupes, different content gets a distinct name). The hashed
            // name is also immutable, so the service worker can cache it safely.
            filename: '[contenthash].worker.js',
            chunkFilename: '[contenthash].worker.js',
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
            {
              // Standard Red Notes: one fast esbuild pass replaces the old
              // babel + ts-loader chain. `target` tracks the project
              // browserslist; the Safari floor is 12 (not 11) because esbuild
              // cannot down-level ES2018 object-rest destructuring — which the
              // workspace packages use heavily — to Safari 11.0/ES2017 (babel's
              // preset-env could). Safari 11.1+ supports it natively, so only
              // the 2017 Safari 11.0 is dropped. `jsx: 'automatic'` matches
              // tsconfig's `react-jsx` runtime. esbuild does not type-check —
              // neither did ts-loader (transpileOnly) — so `yarn tsc` stays the
              // type gate.
              loader: 'esbuild-loader',
              options: {
                target: ['chrome80', 'edge88', 'firefox78', 'safari12'],
                jsx: 'automatic',
                // Pin an empty raw tsconfig so esbuild does NOT auto-read each
                // file's nearest tsconfig `target` (several workspace packages
                // extend a base that compiles to es6). Only the `target` above
                // applies; webpack still resolves path aliases.
                tsconfigRaw: {},
                // All four targets above natively support destructuring, but
                // esbuild still tries (and fails) to down-level certain array
                // destructuring forms used in the workspace packages. Mark it
                // supported so esbuild emits it as-is instead of erroring.
                supported: { destructuring: true },
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
                  // In compressed mode Dart Sass represents the UTF-8 charset
                  // marker as a BOM. Because MiniCssExtractPlugin concatenates
                  // the Sass chunk after the Tailwind chunk, that BOM lands in
                  // the middle of app.css and becomes part of the following
                  // :root selector. The browser then cannot apply the built-in
                  // Standard Red variables. app.css is served as UTF-8, so no
                  // in-band charset marker is needed.
                  charset: false,
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
