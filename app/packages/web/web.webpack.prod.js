const { merge } = require('webpack-merge')
const mergeWithEnvDefaults = require('./web.webpack-defaults.js')
const config = require('./web.webpack.config.js')

module.exports = (env, argv) => {
  mergeWithEnvDefaults(env)
  return merge(config(env, argv), {
    mode: 'production',
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
