const { merge } = require('webpack-merge')
const mergeWithEnvDefaults = require('./web.webpack-defaults.js')
const config = require('./web.webpack.config.js')
const MinimizerPlugin = require('minimizer-webpack-plugin')
const buildLimits = require('./webpack-build-limits.cjs')

module.exports = (env, argv) => {
  mergeWithEnvDefaults(env)
  const limits = buildLimits()
  return merge(config(env, argv), {
    mode: 'production',
    parallelism: limits.parallelism,
    optimization: {
      // Match webpack's default Terser settings, but do not spawn one large
      // minifier heap per available CPU. Zero runs in the compiler process.
      minimizer: [
        new MinimizerPlugin({
          parallel: limits.minifyWorkers === 0 ? false : limits.minifyWorkers,
          terserOptions: { compress: { passes: 2 } },
        }),
      ],
    },
    // Standard Red Notes: do NOT emit source maps in the production build.
    // `devtool: 'source-map'` emitted `app.js.map` AND appended a
    // `//# sourceMappingURL=app.js.map` comment to app.js. The served nginx
    // image (docker/nginx.conf) has no special handling for .map files and they
    // are not intentionally published, so every page load ended with the browser
    // trying to fetch a map that isn't served — a dangling reference / console
    // NetworkError. Setting `devtool: false` disables map emission entirely, so
    // no .map file is produced and no sourceMappingURL comment is appended (the
    // production-mode Terser minifier derives its sourceMap option from devtool,
    // so it won't re-add one either). Shipping full source of an end-to-end
    // encrypted app to every visitor is also undesirable.
    devtool: false,
  })
}
