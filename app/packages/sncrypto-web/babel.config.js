module.exports = function (api) {
  api.cache.forever()

  return {
    presets: ['@babel/preset-env'],
    /*
     * `@babel/plugin-syntax-dynamic-import` used to be listed here. Dynamic `import()`
     * has been standard syntax that Babel parses on its own since 7.8, so the plugin
     * has been a no-op for this build for years — and it was never published for
     * Babel 8, so under @babel/core 8 it fails the build outright with
     * `Requires Babel "^7.0.0-0", but was loaded with "8.0.7"`. Dropping it is the
     * Babel 8 migration for this package; nothing replaces it.
     */
  }
}
