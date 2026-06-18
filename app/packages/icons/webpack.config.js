module.exports = () => {
  return {
    entry: './src/index.ts',
    mode: 'production',
    devtool: 'source-map',
    // Library bundle — the 244 KiB web-entrypoint size recommendation is noise.
    performance: { hints: false },
    optimization: {
      minimize: false,
    },
    output: {
      filename: 'index.js',
      libraryTarget: 'umd',
      umdNamedDefine: true,
    },
    resolve: {
      fallback: {
        crypto: false,
        path: false,
      },
      extensions: ['.js', '.jsx', '.ts'],
    },
    module: {
      rules: [
        {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', '@babel/preset-react'],
          },
        },
        {
          test: /\.svg$/i,
          use: [{ loader: '@svgr/webpack', options: { babel: false } }],
        },
      ],
    },
  }
}
