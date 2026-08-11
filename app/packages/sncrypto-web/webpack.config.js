const path = require('path')
const webpack = require('webpack')
module.exports = {
  entry: {
    'sncrypto-web.js': './src/index',
  },
  // Library bundle — the 244 KiB web-entrypoint size recommendation is noise.
  performance: { hints: false },
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      'libsodium-wrappers-sumo$': path.resolve(
        __dirname,
        '../../node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
      ),
      'libsodium-sumo$': path.resolve(
        __dirname,
        '../../node_modules/libsodium-sumo/dist/modules-sumo/libsodium-sumo.js',
      ),
    },
    fallback: {
      crypto: false,
      fs: false,
      path: false,
    },
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: './[name]',
    chunkFilename: '[name].bundle.js',
    library: 'SNCrypto',
    libraryTarget: 'umd',
    umdNamedDefine: true,
    publicPath: '/dist/',
  },
  optimization: {
    minimize: false,
  },
  module: {
    rules: [
      {
        test: /\.ts(x?)$/,
        exclude: /node_modules/,
        use: [{ loader: 'babel-loader' }, { loader: 'ts-loader' }],
      },
      {
        test: /\.(js)$/,
        loader: 'babel-loader',
      },
    ],
  },
  plugins: [
    new webpack.NormalModuleReplacementPlugin(/^node:fs$/, (resource) => {
      resource.request = 'fs'
    }),
  ],
  stats: {
    colors: true,
  },
  devtool: 'source-map',
}
