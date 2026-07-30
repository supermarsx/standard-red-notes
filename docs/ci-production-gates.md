---
title: CI Production Gates
description: Required, scheduled, and manually dispatched validation for production changes.
---

# CI Production Gates

The root [CI workflow](../.github/workflows/ci.yml) is the non-publishing
production gate for the complete repository. It runs on every pull request and
push to `main`, uses read-only repository permissions, and does not publish
packages, images, tags, releases, or deployment artifacts.

The stable branch-protection check is `production-gate`. It fails unless every
required lane succeeds; a failed, cancelled, or skipped dependency cannot turn
the fan-in green.

## Required Lanes

| Lane               | Contract                                                                                                                                                                                            | Timeout |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: |
| `contracts`        | Immutable root install; CI validator tests; release target and artifact contract; generated docs/search freshness, link/navigation integrity, Mermaid rendering; actionlint over root workflows.    |  12 min |
| `check`            | Immutable installs in the root, app, and server projects, followed by the coordinated type, lint, format, and test gate.                                                                            |  45 min |
| `build`            | A second clean set of immutable installs followed by the coordinated MCP, OpenClaw, app, and server build.                                                                                          |  45 min |
| `desktop-electron` | A production desktop build followed by the seven real Electron suites under Xvfb. The guarded runner requires the built entry point and cannot silently fall back to skipped headless tests.        |  45 min |
| `container-smoke`  | Hadolint, BuildKit image builds, an isolated Compose stack, Chromium app-open checks, bounded parallel sync and Redis operations, MariaDB backup/restore, and image/container hardening assertions. |  70 min |
| `production-gate`  | Fail-closed fan-in for all five implementation lanes above.                                                                                                                                         |   5 min |

The required browser selection contains three app-open tests and one combined
sync/Redis test. The generated JSON report must contain at least four expected
tests and exactly zero skipped, unexpected, or flaky tests. The stack uses a
run-specific Compose project and generated credentials, then removes its
containers and volumes even after a failure.

## Extended Profiles

The Sunday schedule runs both extended lanes after the required container lane
has passed. A manual run accepts one of these profiles:

| Profile      | Additional work                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required`   | Run only the pull-request production gate.                                                                                                                              |
| `load`       | Run 250 encrypted notes through four parallel browser clients while four Redis workers perform 500 verified operation loops each.                                       |
| `exhaustive` | Run every non-load Playwright spec across Chromium, Firefox, and WebKit. Intentional engine-specific skips must include a reason and remain below the asserted ceiling. |
| `all`        | Run both `load` and `exhaustive`.                                                                                                                                       |

The load lane is capped at 75 minutes and the browser matrix at 120 minutes.
Both always upload Playwright JSON, retained traces, Compose status/logs, and a
container resource snapshot. Required artifacts use `if-no-files-found: error`;
missing evidence is a failure rather than a silent pass.

## Docker Assertions

The default production stack is validated at three levels:

1. Every tracked Dockerfile passes a digest-pinned Hadolint image.
2. Compose configuration must drop all capabilities, enable
   `no-new-privileges`, set memory and PID ceilings, keep infrastructure ports
   internal, and keep the raw Docker socket out of the server container.
3. Built app/server images must declare a non-root runtime user and healthcheck.
   Live stack containers must be healthy, unprivileged, capability-dropped, and
   constrained by memory and PID limits.

BuildKit's GitHub Actions cache is shared by the required and extended lanes.
No image step has push enabled.

## Local Validation

Run the workflow policy and its failure-case tests without starting Docker:

```bash
yarn ci:contracts
actionlint .github/workflows/ci.yml
```

Run the same desktop artifact and live Electron suite locally on a machine with
a display:

```bash
cd app
yarn build:desktop
yarn workspace @standardnotes/desktop ava:electron
```

On headless Linux, prefix the final command with `xvfb-run --auto-servernum`.
The runner sets its own test gate and fails when the desktop entry point is
missing, so this command cannot report success by substituting skipped tests.

Validate the current Compose model:

```bash
yarn ci:docker-hardening
```

After starting a disposable stack, run the same required operations commands:

```bash
APP_URL=http://127.0.0.1:3001 \
OPS_LOAD_NOTES=25 \
OPS_LOAD_CLIENTS=2 \
OPS_REDIS_WORKERS=2 \
OPS_REDIS_OPS_PER_WORKER=50 \
npm --prefix e2e run test:ops-load

yarn ops:backup-restore
```

The root, app, and server dependency graphs are lockfile-backed and installed
with `--immutable`. The E2E package does not currently commit an npm lockfile,
so CI names the exact Playwright package version instead of resolving its
declared range. Changing that version requires updating the workflow contract
and rerunning all browser lanes.

## Runtime Tradeoffs

On a cold runner, dependency installation, native app packages, and two Docker
image builds dominate elapsed time. The required lanes are separated so checks,
builds, contracts, and container integration run concurrently; warm Yarn and
BuildKit caches reduce later runs without allowing a cache miss to skip work.

The normal pull-request path intentionally keeps the live test corpus small but
still crosses the browser, encryption/sync, MariaDB, Redis, SNS/SQS emulator,
backup, restore, and hardened-container boundaries. Larger note counts and the
three-engine suite run on schedule or explicit dispatch because placing them on
every commit would consume substantially more runner time and make feedback less
useful without increasing the breadth of the required boundary checks.
