# Dependency upgrade

This document records the dependency and toolchain reconstruction for the `app`
workspace. All commands are run from this directory unless another working
directory is shown.

## Toolchain baseline

- Node.js is pinned to 26.5.0 in `.nvmrc`, package engines, containers, and CI.
- Yarn is pinned to 4.17.1 through `packageManager` and the vendored
  `.yarn/releases/yarn-4.17.1.cjs` release.
- The root and `packages/filepicker/example` lockfiles use the Yarn 4 lockfile
  format and are generated with Node.js 26.5.0.
- TypeScript is pinned to 6.0.3. The lint stack is based on ESLint 9.39.5 and
  typescript-eslint 8.64.0, and formatting uses Prettier 3.9.5.
- Webpack is upgraded to 5.108.4, with current loaders and Webpack CLI/server
  releases.

## Application platforms

- Desktop uses Electron 43.1.1 and the current Electron build, rebuild,
  notarization, and updater packages.
- Web and shared packages use React 19.2.7 and current React type definitions.
- Mobile uses React Native 0.86.0, React 19.2.7, Android API 36, Gradle 9.3.1,
  Kotlin 2.1.20, and Ruby 3.4.7.
- Android application entry points are Kotlin. The iOS application delegate is
  Swift and the minimum iOS deployment target is 15.1.
- GitHub Actions and Docker images are aligned with the Node.js 26 toolchain.

## Package manager and supply chain

- Immutable installs are the default, checksums fail closed, and the project
  cache is local to the repository.
- Cross-platform optional dependencies are resolved for Windows, Linux, and
  macOS on x64 and arm64 so desktop packaging can inspect foreign targets.
- Git dependencies are approved by exact normalized repository URL. The only
  approvals are the four pinned Standard Notes React Native forks declared by
  the mobile workspace; no organization-wide or global wildcard is used.
- `decrypt` remains pinned to the upstream archive at commit
  `83e11f45c1461a7a1bde5a8bbc1ada4c4c712797`. Yarn installs and links it without
  granting a broad Git repository exception.
- The filepicker example uses published packages rather than parent-workspace
  references. `@standardnotes/snjs` is set to `^2.211.6`, the latest published
  npm release; `2.211.7` has no published candidate.

Mutable lockfile regeneration:

```powershell
node .yarn/releases/yarn-4.17.1.cjs install --no-immutable
Push-Location packages/filepicker/example
node ../../../.yarn/releases/yarn-4.17.1.cjs install --no-immutable
Pop-Location
```

## Peer dependency policy

Peer warnings are reviewed with `yarn explain peer-requirements`; they are not
silenced globally. Workspace-owned missing peers are added where the package
uses the requesting tool at runtime or during its own scripts. Upstream peers
with mutually exclusive React or React Native ranges remain documented
compatibility debt when replacing them would remove required functionality.

## Validation matrix

The completed upgrade must pass:

- immutable root and filepicker example installs;
- Yarn constraints and peer-requirement explanations;
- formatting, ESLint, TypeScript, all workspace builds, and all unit tests;
- explicit desktop typecheck, test, and production build gates;
- filepicker example lint and build gates;
- dependency currentness and recursive production/development security audits;
- Android toolchain/project checks and host availability checks for Android and
  iOS native builds;
- actionlint across every workflow under `.github/workflows`;
- Docker build and runtime smoke checks for the app, web, and SNJS images; and
- `git diff --check` plus a final app-only diff review.

Platform-specific builds that cannot execute on the current host must be run by
their corresponding CI jobs. Host unavailability is recorded separately from a
failed build.
