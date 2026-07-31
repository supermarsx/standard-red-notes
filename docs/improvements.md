---
title: Improvements
description: Improvements and fork-owned functionality in Standard Red Notes.
---

# Improvements

Standard Red Notes turns the upstream codebase into a self-hosted-first product.
The largest changes are operational defaults, admin controls, documentation,
automation, and included access.

## Product And Feature Access

- Full included feature mode for self-hosted deployments.
- No subscription provisioning required for the included app experience.
- User-facing settings for assistant, backups, sync, sharing, invites, storage,
  admin controls, and diagnostics.
- Extended note types and editor blocks documented in the README and onboarding
  guide.

## Operator Experience

- Docker Compose profiles for the production-style multi-service stack and a
  simpler all-in-one container.
- Setup scripts that generate strong secrets and write a usable `.env`.
- Server settings overlay editable from the Admin preferences tab.
- Registration controls for invite-only signup, approval queue, global caps,
  signup windows, and self-serve invite quotas.
- In-container `srn-admin` registration commands for operators who need CLI
  access.

## Privacy And Security Controls

- Same-origin web defaults for API, files, and websocket paths.
- App passwords and revocable MCP tokens with read-only/write modes.
- Trusted devices and passkey-oriented flows in the client surface.
- Optional, off-by-default account recovery with client-encrypted escrow,
  logged-out recovery, atomic password rotation, and one-time replacement
  codes.
- Clear docs for optional features that can cross the local encryption boundary,
  especially AI providers.

## Developer And QA Tooling

- Root coordinator scripts for build, lint, test, formatting, Docker config, and
  release support.
- Playwright e2e package for app-open, correctness, stress, and sync checks.
- Automated README screenshot capture from a running app.
- Deterministic brand asset generation for favicon/PWA icons.
- GitHub Pages documentation workflow with a sidebar docs site.

## Documentation Additions

- User onboarding.
- Self-hosting and deployment guides.
- API reference.
- Architecture and validation guides.
- Comparison with adjacent note-taking and knowledge-base tools.
