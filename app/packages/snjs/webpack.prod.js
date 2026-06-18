const { merge } = require('webpack-merge')
const config = require('./webpack.config.js')
const webpack = require('webpack')

module.exports = merge(config, {
  mode: 'production',
  // snjs is a library bundle, not a web entrypoint, so the 244 KiB asset-size
  // recommendation is noise here — silence it rather than emit two warnings.
  performance: {
    hints: false,
  },
  plugins: [
    new webpack.DefinePlugin({
      __IS_DEV__: false,
    }),
  ],
})
