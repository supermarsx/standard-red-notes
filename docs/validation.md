---
title: Validation
description: How to validate Standard Red Notes locally and in CI.
---

# Validation

No single command proves a repo this size is perfect. Use layered validation:
static checks, package tests, a live app smoke test, and deeper e2e flows when
the Docker stack is available.

## Fast Local Checks

```powershell
yarn generate:brand-assets
yarn --cwd app/packages/web tsc
yarn --cwd server workspace @standardnotes/auth-server build
docker compose config
docker compose -f docker-compose.single.yml config
git diff --check
```

## Focused Web Tests

Run changed-area Jest specs directly from the web package:

```powershell
cd app/packages/web
yarn test --runTestsByPath src/javascripts/Components/Preferences/Search/searchPreferences.spec.ts
```

## Normalized Jest-Instrumented JS/TS Source Coverage

The Pages coverage badge at
`https://supermarsx.github.io/standard-red-notes/assets/coverage.svg` reports
**normalized Jest-instrumented JS/TS source coverage**. It is neither unit-test
coverage nor whole-repository coverage. Every Jest spec selected by a package's
normal test command runs, so Jest integration and live specs may contribute
covered counters.

The collector owns an explicit app/server Jest workspace inventory and fails on
inventory drift, duplicate workspace names, locations or slugs, duplicate
report paths, missing reports, malformed reports, and source/report mismatch.
Every shard manifest carries the full scope inventory, the exact selected
workspace subset, and one report/source inventory per selection. A completed
selected manifest may cover only part of a scope. The final merge accepts
multiple manifests for the same scope, independently enumerates eligible source
files from the checkout, and requires the app/server union to contain every
expected workspace and eligible source exactly once. Missing, duplicate, or
unexpected workspaces; scope mismatches; incomplete selected manifests;
overlapping or duplicate report paths; and missing, unexpected, or duplicate
sources are fatal.
For each inventory workspace it enumerates `src` and `lib` files ending in
`.ts`, `.tsx`, `.js`, or `.jsx`. It excludes test/spec files and directories,
declarations, and generated, build, vendor, and fixture directories. Jest's
package-specific coverage exclusions and thresholds are cleared for this
descriptive report. For each workspace, the collector loads its real CJS or
JSON Jest config through a unique temporary config beside the original,
preserves the package settings, and overrides inherited `collectCoverageFrom`
with an empty array. The runner validates a direct Jest package script, removes
package-script coverage, config, and worker options, preserves non-owned options
such as `--no-cache` and positional selectors, then invokes `yarn exec jest`
with one authoritative `--maxWorkers=1` and the temporary config. The temporary
config is removed after success, failure, or timeout; no spawned argument
contains `collectCoverageFrom`. Function, async, and Promise config exports fail
as unsupported instead of being evaluated with changed semantics. Jest
therefore transforms and reports only files executed or imported by the
existing tests, and any `Failed to collect coverage` diagnostic is fatal.
Collection and test failures remain fatal.

Source files missing from Jest's output are materialized as zero-covered maps
directly from their TS, TSX, JS, or JSX text with `istanbul-lib-instrument`
and the required Babel parser plugins. Existing Jest maps are never replaced.
After synthesis, every workspace report must contain exactly its eligible
canonical source paths once. A successful Jest process that does not emit its
raw `coverage-final.json` fails for every normal workspace. The only exceptions
are the explicitly reviewed source-only/no-test inventory entries
`server/packages/domain-events` and `server/packages/predicates`. The collector
verifies that these entries remain in the reviewed inventory and have no package-local test/spec files, then
synthesizes every eligible source as zero-covered if Jest emits no raw report.
Unexpected, missing, or stale source-only flags fail inventory validation, and
each source-only workspace still contributes a non-empty denominator. Parser
failures name the unsupported source and fail collection. An inventory
workspace with no eligible source must carry an explicit `emptySourceReason`;
an undocumented empty workspace fails.

The current app scope is `api`, `encryption`, `features`, `filepicker`, `files`,
`mobile`, `models`, `responses`, `services`, `snjs`, `ui-services`, `utils`, and `web`.
The current server scope is `analytics`, `api-gateway`, `auth`, `common`,
`domain-core`, `domain-events`, `domain-events-infra`, `files`, `home-server`,
`predicates`, `revisions`, `scheduler`, `security`, `settings`, `sncrypto-node`,
`syncing-server`, `time`, and `websockets`.

The source denominator excludes non-Jest app workspaces (`clipper`, `desktop`,
`filepicker/example`, `icons`, `releases`, `sncrypto-common`, `sncrypto-web`,
`styles`, and `toast`), non-Jest server workspaces (`grpc` and
`websocket-gateway`), and the root `mcp` and `openclaw` workspaces.

The excluded non-Jest suites are the Playwright suites under `e2e/`; desktop's
AVA suite; the app and `sncrypto-web` Mocha/Chai browser harnesses; the
`websocket-gateway` and OpenClaw Vitest suites; `websocket-gateway`'s direct Node
and Playwright e2e scripts; MCP's `run-e2e.mjs`; and the coverage tool's own
`node:test` suite. Native code, Docker health/integration behavior, backup and
restore drills, and uninstrumented runtime paths are also outside this metric.

Install the three independent Yarn projects, test the coverage infrastructure,
and reproduce the CI report with:

```powershell
npm install --global corepack@0.35.0
corepack enable
yarn install --immutable
Push-Location app
yarn install --immutable
Pop-Location
Push-Location server
yarn install --immutable
Pop-Location
yarn test:coverage-tools
yarn coverage
```

`collect` enforces a hard timeout for each workspace and terminates its full
process tree on Windows and Linux. The default is 900000 ms (15 minutes), which
the `app-core` shard uses; the server shard also passes 900000 ms explicitly.
The isolated `app-web` shard passes 1800000 ms (30 minutes) explicitly. With the
enforced one-worker command line, the verified Web run passed in 1607.488 seconds
(26m47.488s) with about 3.4 GB observed Jest working set. This current bounded
result supersedes the earlier 17m44s and roughly 7.5 GB observation from the old
worker configuration, so the runner must retain its 30-minute timeout. Override
the default with `--timeout-ms <milliseconds>` or
`COVERAGE_WORKSPACE_TIMEOUT_MS`; the CLI option takes precedence. Parallel
failures are printed as an ordered workspace ledger. Every collector explicitly
limits the pool to two active Jest processes and each Jest process to
`--maxWorkers=1`, with no more than one worker child per process.

`yarn coverage` writes ignored reports and the JSON summary to `coverage/`. The
tracked `docs/assets/coverage.svg` contains the most recently verified numeric
baseline, currently **40.7%** from the preceding inventory. A local full run
recalculates and overwrites it, and CI regenerates it before building and
publishing the Pages site.

Aggregation uses `istanbul-lib-coverage`. Every source path is canonicalized to
one repository-relative path, and any source overlap is rejected before file
coverage is added. For each metric, the reported percentage is
`100 * sum(covered counters) / sum(total counters)` over the validated union,
rounded to one decimal place. Percentages are never averaged across reports,
workspaces, shards, or scopes. A `0/0` metric is reported as `n/a`. The badge
displays the **lines** result; the generated JSON summary retains statements,
branches, functions, and lines.

In CI, three isolated matrix entries run in parallel after installing the root
instrumentation tooling and the selected scope's own lockfile. `app-core`
collects the 12 expected app workspaces other than `packages/web`; `app-web`
collects only `packages/web`; and `server` collects all 18 expected server
workspaces. Each entry uploads its completed manifest and reports as a separate
artifact. The build job downloads all three artifacts and validates their union
before aggregation, badge generation, and the Jekyll build. Pull requests and
manual runs execute those checks. Only a non-PR run on `main` uploads and
deploys the Pages artifact; the deploy job alone receives `pages: write` and
`id-token: write`.
Repository **Settings > Pages > Build and deployment > Source** must be set to
**GitHub Actions**. GitHub Camo may briefly continue showing an older numeric
badge after Pages publishes the replacement image.

The workflow action majors were checked against their official repositories on
2026-07-15: `checkout@v7`, `setup-node@v7`, `upload-artifact@v7`,
`download-artifact@v8`, `configure-pages@v6`, `jekyll-build-pages@v1`,
`upload-pages-artifact@v5`, and `deploy-pages@v5`. All JavaScript actions in
that set use Node 24; `jekyll-build-pages` is a Docker action, so there is no
unavoidable legacy Node runner warning to document.

## Live App Smoke

Start the app stack:

```powershell
docker compose -f docker-compose.single.yml up -d --build
```

Then run the e2e app-open smoke:

```powershell
cd e2e
npm install
npm run install-browser
$env:APP_URL = "http://localhost:3001"
npm test -- app-opens.spec.ts --project=chromium
```

## README Screenshot

The README screenshot is generated from the actual running app:

```powershell
$env:APP_URL = "http://localhost:3001"
npm --prefix e2e run screenshot:readme
```

The capture entry point opens the live app, seeds local demo notes through the
real in-page application surface, and writes a deterministic 1440 × 900
`docs/assets/readme-screenshot.png`. Before replacing the file, it resolves
every target in `docs/_data/feature_screenshots.json`, requires that exact
control to be visible, and checks that the numbered marker points near the
control's live bounds. It fails instead of publishing a login screen,
incomplete shell, stale selector, or decorative marker with no matching UI.

Every additional feature state gets its own capture entry and unique PNG in the
manifest. Multiple annotated crops may intentionally share one capture only
when all controls are simultaneously visible in that exact state; separate
capture entries are forbidden from silently reusing the same asset.

The manifest also binds the committed PNG to its SHA-256, the historical source
commit and commit timestamp, a machine-readable list of states the image does
not prove, and bounded claims for each crop. The current historical capture
records `liveLocatorRevalidated: false`: its controls are visually present, but
the expanded locator manifest has not been rerun against a connected live app.
Only a new successful live capture may upgrade that status.

Validate the committed image and every documentation crop without launching a
browser:

```powershell
yarn docs:screenshots
```

That gate checks the versioned manifest, unique capture assets, reproducible
capture entry points, PNG and viewport dimensions, source references, SVG
dimensions, accessible text, crop bounds, exact CSS/text/role locators, marker
coordinates and descriptions, unique feature IDs, and contextual coverage in
onboarding, client-platform, and in-app guidance. It always checks the current
asset digest. With complete Git history it also checks that the recorded source
commit contains the exact same PNG and timestamp; shallow source archives skip
only that historical lookup. This offline gate does not claim it reran live
locators. The onboarding evidence gate additionally binds each reviewed crop to
its exact section, pixel-boundary disclaimer, caption, view box, bounded claims,
and numbered target text so a closed or empty UI state cannot be moved beside a
claim about an open or populated state.

## Deeper End-to-End Gates

Use the heavier tests when changing sync, IndexedDB materialization, search, tag
references, or editor persistence:

```powershell
cd e2e
npm test -- encryption-data-safety.spec.ts --project=chromium
npm test -- correctness.spec.ts --project=chromium
npm test -- stress-notes.spec.ts --project=chromium
npm test -- stress-sync.spec.ts --project=chromium
```

`encryption-data-safety.spec.ts` is the focused safety gate: it registers real
accounts, creates and syncs a note, verifies the HTTP API and MariaDB `items`,
`users`, and any matching revision rows do not contain note plaintext, confirms
a fresh client can decrypt the item, checks cross-account isolation, and
verifies delete tombstones clear encrypted payload fields.

These require a healthy local app/server and take materially longer than the
smoke tests.

## Operations Drills

Use these after database, Redis, Docker, signup-safety, rate-limit, or
production-config changes:

```powershell
$env:APP_URL = "http://localhost:3001"
npm --prefix e2e run test:ops-load
node scripts/verify-backup-restore.mjs
```

`test:ops-load` drives real browser clients against the running Docker stack,
pushes encrypted notes, pulls them from parallel clients, churns Redis with
parallel SET/GET/INCR workers, and checks MariaDB persistence. Scale it with
`OPS_LOAD_NOTES`, `OPS_LOAD_CLIENTS`, `OPS_REDIS_WORKERS`, and
`OPS_REDIS_OPS_PER_WORKER`.

`verify-backup-restore.mjs` proves the MariaDB logical backup path by restoring
the dump into a temporary database and comparing table lists, row counts, and
checksums before dropping the temporary database.
