const fs = require('node:fs')
const path = require('node:path')
const tseslint = require('typescript-eslint')
const prettierConfig = require('eslint-config-prettier/flat')

const packagesDirectory = path.join(__dirname, 'packages')

// A type-aware rule such as `@typescript-eslint/no-floating-promises` can only
// run when the parser has been handed a TypeScript program for the file it is
// looking at. Without `parserOptions.project` the rule does not merely find
// nothing — typescript-eslint refuses to construct it at all, so the rule has
// to be wired here or it is not a rule. `server/.eslintrc` declared
// `no-floating-promises` and pointed `parserOptions.project` at these same
// `linter.tsconfig.json` files, but eslint 10 uses flat config and never reads
// an `.eslintrc`, so that declaration had no effect for as long as it existed.
//
// Three mechanisms can supply the program and only one survives this repo:
//
//   * `projectService: true` asks TypeScript for the nearest `tsconfig.json`.
//     That file excludes `**/*.spec.ts` (inherited from the solution-style root
//     config) while eslint does lint specs here, so every spec fails to parse:
//     "was not found by the project service". Measured, not assumed.
//   * one catch-all `project` glob listing every package makes typescript-eslint
//     build programs in turn until one claims the file, so linting `time` — all
//     seven files of it — built the `auth` and `syncing-server` programs on the
//     way and took 33s. `yarn lint` runs every package at once; that does not
//     scale.
//   * one `project` per package, selected by the file's path, builds exactly one
//     program per package run. That is what this does.
//
// `linter.tsconfig.json` is the per-package file that already existed for this
// purpose: it extends the package's build tsconfig and replaces `exclude` with
// `["dist", "test-setup.ts"]`, which lifts the `**/*.spec.ts` exclusion for the
// linter alone and leaves the build untouched. websocket-gateway has no such
// file, but its `tsconfig.test.json` covers the same ground (`src`, `test` and
// `vitest.config.ts`) and its lint script is `eslint src test`, so that is the
// second candidate.
//
// `tsconfig.json` is deliberately NOT a candidate. It would type the ordinary
// sources and reject every spec, which is worse than failing loudly. A package
// offering neither candidate throws below rather than lint untyped, because a
// package linted untyped is a package where these rules are quietly off again.
const TYPED_PROJECT_CANDIDATES = ['linter.tsconfig.json', 'tsconfig.test.json']

// Throws rather than returning a fallback: a package whose files are linted with
// no project behind them is a package where the type-aware rules below are off
// again, and that is precisely the failure this file exists to end. The throw is
// a loud one — eslint reports the config as unloadable for every package — which
// is the point.
const typedProjectFor = (packageName) => {
  for (const candidate of TYPED_PROJECT_CANDIDATES) {
    if (fs.existsSync(path.join(packagesDirectory, packageName, candidate))) {
      return candidate
    }
  }

  throw new Error(
    `packages/${packageName} has a \`lint\` script but none of ` +
      TYPED_PROJECT_CANDIDATES.join(' or ') +
      '. Add one covering its sources and its specs, or the type-aware rules stop running there silently.',
  )
}

const hasLintScript = (packageName) => {
  const manifestPath = path.join(packagesDirectory, packageName, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    return false
  }

  const { scripts } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  return Boolean(scripts && scripts.lint)
}

// `files` is relative to the directory holding this file, and `tsconfigRootDir`
// makes `project` relative to the same place, so both sides agree however eslint
// was started: `yarn lint` is `yarn workspaces foreach -ptA run lint` and every
// package runs `eslint .` from its own directory.
//
// `tsconfigRootDir` is not strictly required today, and a mutation that deletes
// it is not caught by anything — typescript-eslint falls back to a root it
// infers from the call stack of the `tseslint.configs` getter accessed below,
// which happens to be this very directory. That is a side effect of where this
// file lives, it throws outright once two such candidates exist, and nothing
// about it is visible at the point of use. Its value is load-bearing (point it
// at the wrong directory and every package fails to find its project), so it is
// stated here rather than inferred.
const typeAwareConfigs = fs
  .readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter(hasLintScript)
  .map((name) => ({
    files: [`packages/${name}/**/*.ts`],
    languageOptions: {
      parserOptions: {
        project: [`packages/${name}/${typedProjectFor(name)}`],
        tsconfigRootDir: __dirname,
      },
    },
  }))

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
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  // One TypeScript program per package, so the type-aware rules below can run.
  ...typeAwareConfigs,
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
      // Type-aware, and the reason the wiring above exists. An unawaited
      // promise is not a style question here: an unawaited `server.build()` in
      // the vendored `inversify-express-utils` booted a server whose every
      // request hung silently, with no error and nothing in the logs.
      '@typescript-eslint/no-floating-promises': 'error',
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
      // `packages/auth/migrations-optional` holds documented, never-auto-run
      // TypeORM migrations — the same kind of file as `migrations/` above, which
      // has never been linted. The glob above misses it only because of the
      // suffix, and no package's TypeScript project includes it, so with type
      // information wired up its two files became the only thing in the tree
      // eslint could parse but not type: "the file was not found in any of the
      // provided project(s)". Ignored for the same reason its sibling is.
      '**/migrations-optional/**',
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
