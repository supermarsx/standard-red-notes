const eslint = require('@eslint/js')
const prettierConfig = require('eslint-config-prettier')
const prettierPlugin = require('eslint-plugin-prettier')
const reactHooks = require('eslint-plugin-react-hooks')
const globals = require('globals')
const tseslint = require('typescript-eslint')

const codeFiles = ['packages/**/*.{js,jsx,cjs,mjs,ts,tsx}']
const tsFiles = ['packages/**/*.{ts,tsx}']
const browserFiles = ['packages/clipper/**/*.{js,jsx,ts,tsx}', 'packages/web/**/*.{js,jsx,ts,tsx}']
const reactHookFiles = ['packages/mobile/src/**/*.{ts,tsx}', 'packages/web/src/javascripts/**/*.{ts,tsx}']

module.exports = tseslint.config(
  {
    ignores: [
      '**/.git/**',
      '**/.github/**',
      '**/.husky/**',
      '**/.sass-cache/**',
      '**/.vscode/**',
      '**/.yarn/**',
      '**/actions/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/scripts/**',
      '**/*.d.ts',
      '**/*.spec.ts',
      'packages/clipper/**/__mocks__/**',
      'packages/desktop/@types/**',
      'packages/mobile/**/__mocks__/**',
      'packages/mobile/android/**',
      'packages/mobile/html/**',
      'packages/mobile/ios/**',
      'packages/snjs/mocha/**',
      'packages/web/**/__mocks__/**',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: codeFiles,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: tsFiles,
  })),
  {
    ...prettierConfig,
    files: codeFiles,
  },
  {
    files: codeFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': [
        'error',
        {
          singleQuote: true,
          trailingComma: 'all',
          printWidth: 120,
          semi: false,
        },
        {
          usePrettierrc: false,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/no-array-constructor': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: false,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-floating-promises': 'off',
      'block-scoped-var': 'error',
      'comma-dangle': ['error', 'always-multiline'],
      'eol-last': 'error',
      'no-confusing-arrow': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-constructor-return': 'error',
      'no-duplicate-imports': 'error',
      'no-inline-comments': 'warn',
      'no-invalid-this': 'error',
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'no-return-assign': 'warn',
      'no-self-compare': 'error',
      'no-throw-literal': 'off',
      'no-trailing-spaces': 'error',
      'no-unmodified-loop-condition': 'error',
      // Three rules ESLint 10 added to `eslint:configs.recommended`. They report 39
      // findings in code that predates the ESLint 9 -> 10 bump, so they are carried
      // as warnings here rather than silenced: the bump does not break anything,
      // and fixing the findings is its own change, not a dependency change.
      //
      // Of those 39, 36 are behaviour-neutral (a `let x = <value>` initializer that
      // is provably overwritten before any read, or a rethrow that drops the caught
      // error's `cause`). THREE ARE REAL BUGS and must not be mistaken for noise:
      // `no-unassigned-vars` catches `debounceTimeout` in Hooks/useDocumentRect.ts
      // and `windowResizeDebounceTimeout` twice in Hooks/useElementRect.ts, where
      // `window.setTimeout(...)`'s handle is never captured, so the paired
      // `window.clearTimeout(...)` clears nothing and those resize handlers do not
      // actually debounce. Capturing the handle changes runtime behaviour, so it is
      // deliberately left out of the ESLint 10 bump.
      'no-useless-assignment': 'warn',
      'no-unassigned-vars': 'warn',
      'preserve-caught-error': 'warn',
      'no-unused-private-class-members': 'error',
      'object-curly-spacing': ['error', 'always'],
      'sort-imports': 'off',
      camelcase: 'off',
      curly: ['error', 'all'],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],
    },
  },
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
  {
    files: browserFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        __WEB_VERSION__: 'writable',
      },
    },
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: reactHookFiles,
  },
  {
    files: ['packages/mobile/src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'warn',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/purity': 'off',
    },
  },
  {
    files: ['packages/web/src/javascripts/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['packages/desktop/app/**/*.{js,ts}'],
    languageOptions: {
      globals: {
        zip: 'writable',
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
)
