const path = require('path')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

module.exports = (_, { mode }) => ({
  entry: {
    styles: path.resolve(__dirname, 'src/Styles/main.scss'),
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
  },
  optimization: {
    minimize: false,
    splitChunks: {
      cacheGroups: {
        styles: {
          name: 'styles',
          type: 'css/mini-extract',
          chunks: 'all',
          enforce: true,
        },
      },
    },
  },
  module: {
    rules: [
      {
        test: /\.(scss|css)$/,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader',
          {
            loader: 'sass-loader',
            options: {
              api: 'modern',
              sassOptions: {
                outputStyle: 'expanded',
                quietDeps: true,
                // @import + the legacy JS API are deprecated in Dart Sass but
                // still supported by the pinned ^1.100; migrating off them is out
                // of scope for a build-warning cleanup.
                silenceDeprecations: ['import', 'legacy-js-api'],
              },
            },
          },
        ],
      },
    ],
  },

  plugins: [
    new MiniCssExtractPlugin({
      filename: 'stylekit.css',
    }),
  ],
})
