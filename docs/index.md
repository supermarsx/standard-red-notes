---
title: Documentation
description: Standard Red Notes documentation home.
---

# Standard Red Notes Documentation

Standard Red Notes is a self-hosted-first fork of Standard Notes. It keeps the
end-to-end encrypted notes model and adds operational controls, included
features, local-first CLI tooling, an MCP bridge, richer settings, and
deployment documentation for people running their own instance.

![Standard Red Notes app screenshot](assets/readme-screenshot.png)

## Start Here

- [Onboarding](onboarding.md) explains the app from a user point of view.
- [Self-hosting](self-hosting.md) covers the Docker stack, environment, reverse
  proxy setup, updates, and backups.
- [Operations hardening](operations-hardening.md) covers database resilience,
  safety limits, and Docker runtime hardening.
- [Architecture](architecture.md) explains how the app, gateway, services, files,
  realtime, CLIs, and MCP bridge fit together.
- [Improvements](improvements.md) lists what this fork changes beyond the
  upstream base.
- [Comparison](comparison.md) positions Standard Red Notes against adjacent note
  and knowledge-base tools.

## Operating Principles

- Encryption remains a client-side boundary: notes and files are encrypted before
  they sync.
- Self-hosting is the product target, not an afterthought.
- All included features are available to every account on your instance.
- Operational controls are surfaced in the app where possible and backed by CLI
  or environment configuration where necessary.
- Documentation should explain the system plainly enough to deploy, audit, and
  maintain it without reading every package first.
