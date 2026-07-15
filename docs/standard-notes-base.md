---
title: Standard Notes Base
description: What Standard Red Notes inherits from Standard Notes.
---

# Standard Notes Base

Standard Red Notes is built from the Standard Notes client/server architecture.
The fork keeps the parts that matter most: end-to-end encryption, offline-first
editing, cross-device sync, tags, protected notes, revisions, files, and a clean
web/desktop/mobile package structure.

## What Is Preserved

- Client-side encryption and decryption.
- Local device state with sync reconciliation.
- Standard Notes item and payload model.
- The web app, desktop/mobile shared packages, editor package layout, and shared
  client service abstractions.
- Auth, sync, files, revisions, and gateway service boundaries.
- AGPL licensing and upstream attribution.

## What Changes In The Fork

The fork does not replace the core notes model. It changes the operating model:
self-hosted is first-class, feature checks resolve to included access, and the
server/operator surfaces are expanded so one person can run the product without
the hosted subscription machinery.

## Compatibility Notes

Because the upstream model and package boundaries remain recognizable, changes
should be made conservatively:

- Keep encryption and sync changes covered by real browser or protocol tests.
- Avoid mixing hosted-service assumptions into self-hosted defaults.
- Preserve upstream attribution in source and docs.
- When widening server settings or API contracts, update the app UI, CLI helpers,
  docs, and e2e checks together.
