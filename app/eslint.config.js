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
      // Three rules ESLint 10 added to `eslint:configs.recommended`. The bump
      // carried 41 findings in pre-existing code as warnings rather than
      // mass-editing during a dependency change; that backlog has since been
      // triaged to zero and these rules now report NOTHING across `app/`.
      //
      // They earned their keep: all three `no-unassigned-vars` findings were real
      // bugs. `debounceTimeout` in Hooks/useDocumentRect.ts and
      // `windowResizeDebounceTimeout` in BOTH hooks of Hooks/useElementRect.ts
      // never captured `window.setTimeout(...)`'s handle, so the paired
      // `window.clearTimeout(...)` cleared nothing: every resize event of a window
      // drag queued its own layout read and re-render instead of one per burst,
      // and a pending timer outlived unmount. Fixed, with the debounce and the
      // unmount clear each covered by a test that fails without them.
      //
      // The other 38 were triaged one by one: the dead initializers and dead
      // pre-exit assignments were removed, the rethrows now carry `cause`, and the
      // two deliberate exceptions carry a per-line disable with its reason
      // (models/.../Predicate/Generators.ts, services/.../MoveItemsToVault.ts).
      // Kept at `warn` rather than promoted to `error` only so a peer's in-flight
      // work cannot be turned red by a rule it never saw; there is no backlog left
      // behind them.
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
