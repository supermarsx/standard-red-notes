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
