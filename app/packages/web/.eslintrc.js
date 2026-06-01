module.exports = {
  root: true,
  extends: ['../../common.eslintrc.js', 'plugin:react-hooks/recommended'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['**/*.spec.ts', '__mocks__'],
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'prettier'],
  env: {
    browser: true,
  },
  globals: {
    __WEB_VERSION__: true,
  },
  rules: {
    // React Compiler rules added in react-hooks v6: opt out for now (require code refactors).
    'react-hooks/set-state-in-effect': 'off',
    'react-hooks/refs': 'off',
    'react-hooks/immutability': 'off',
    'react-hooks/rules-of-hooks': 'off',
    'react-hooks/static-components': 'off',
    'react-hooks/purity': 'off',
    'react-hooks/preserve-manual-memoization': 'off',
    'react-hooks/exhaustive-deps': 'warn',
  },
}
