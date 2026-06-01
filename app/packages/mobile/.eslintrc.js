module.exports = {
  root: true,
  extends: ['../../common.eslintrc.js', 'plugin:react-hooks/recommended'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['**/*.spec.ts', '__mocks__'],
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'prettier'],
  rules: {
    'no-console': 'warn',
    '@typescript-eslint/no-floating-promises': 'off',
    '@typescript-eslint/restrict-template-expressions': 'off',
    'react-hooks/refs': 'off',
    'react-hooks/purity': 'off',
  },
}
