module.exports = {
  plugins: [
    require('@tailwindcss/postcss')(),
    require('autoprefixer')(),
    require('./scripts/GuardTextSizeAdjust.cjs')(),
  ],
}
