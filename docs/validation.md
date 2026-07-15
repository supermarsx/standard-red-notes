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

The script opens the live app with Playwright, seeds local demo notes through the
real in-page application surface when available, and writes
`docs/assets/readme-screenshot.png`.

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
