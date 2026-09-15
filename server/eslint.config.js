const tseslint = require('typescript-eslint')
const prettierConfig = require('eslint-config-prettier/flat')

module.exports = [
  // JavaScript files (including jest configs)
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Basic ESLint rules from original configuration
      'block-scoped-var': 'error',
      'comma-dangle': ['error', 'always-multiline'],
      curly: ['error', 'all'],
      'no-confusing-arrow': 'error',
      'no-inline-comments': 'warn',
      'no-invalid-this': 'error',
      'no-return-assign': 'warn',
      'no-constructor-return': 'error',
      'no-duplicate-imports': 'error',
      'no-self-compare': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-unmodified-loop-condition': 'error',
      'no-unused-private-class-members': 'error',
      'object-curly-spacing': ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],
    },
  },
  // TypeScript files
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    rules: {
      // Override TypeScript rules to match original configuration
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: false,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
      // Basic ESLint rules
      'block-scoped-var': 'error',
      'comma-dangle': ['error', 'always-multiline'],
      curly: ['error', 'all'],
      'no-confusing-arrow': 'error',
      'no-inline-comments': 'warn',
      'no-invalid-this': 'error',
      'no-return-assign': 'warn',
      'no-constructor-return': 'error',
      'no-duplicate-imports': 'error',
      'no-self-compare': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-unmodified-loop-condition': 'error',
      'no-unused-private-class-members': 'error',
      'object-curly-spacing': ['error', 'always'],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],
    },
  },
  // Prettier is the authority on layout. `eslint-config-prettier` has been in
  // devDependencies all along but was never applied, so eslint kept opinions of
  // its own about the same characters: `no-confusing-arrow` demands parentheses
  // that prettier then removes, which leaves the two tools with no shared fixed
  // point on an arrow-bodied ternary. That is not hypothetical — five sites in
  // the gateway's tests had to carry `eslint-disable-next-line no-confusing-arrow`
  // naming the conflict, and an eslint autofix pass over the package left nine
  // files prettier-invalid and the root `check` red.
  //
  // This entry comes after the rule blocks above so it wins, and it turns off
  // the layout rules prettier already enforces: comma-dangle, object-curly-
  // spacing, quotes and semi are made redundant by it, no-confusing-arrow
  // conflicts with it outright.
  prettierConfig,
  {
    // ...with one deliberate exception. `eslint-config-prettier` disables
    // `curly` because the `multi-line` and `multi-or-nest` variants fight
    // prettier; the `all` variant does not, since prettier never adds or
    // removes braces. Keeping it is a real rule kept, not a conflict revived:
    // the 42 `curly` errors under the gateway's `e2e/` are genuine
    // brace-less-if violations in the probe scripts, not prettier drift.
    rules: {
      curly: ['error', 'all'],
    },
  },
  {
    // Global ignores for all packages
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/uploads/**',
      '**/data/**',
      '**/test-setup.ts',
      '**/*.db',
      '**/migrations/**',
      '**/lib/**',
      '**/docker/**',
      '**/supervisor/**',
      '**/scripts/**',
      '**/jest.config.js',
      'bundle.sh',
      'docker-compose*.yml',
      'Dockerfile*',
      '.pnp.*',
      '.yarn/**',
      'logs/**',
    ],
  },
]
