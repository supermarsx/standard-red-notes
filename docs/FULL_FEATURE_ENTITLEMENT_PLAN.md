# Full Feature Entitlement Plan

## Goal

Make Standard Red Notes fully featured for self-hosted deployments without adding client-side subscription bypasses or pointing modified clients at third-party hosted subscription systems.

## Current Behavior

- The server maps subscription plans to roles through `RoleToSubscriptionMap`.
- `ActivatePremiumFeatures` creates a user subscription, assigns the subscription role, and applies default subscription settings.
- The web app checks feature status through SNJS feature services and server-provided roles.
- Offline subscription codes can activate offline entitlements and can activate the desktop home server through the existing `activatePremiumFeatures` bridge.

## Target Behavior

Self-hosted Standard Red Notes should be able to run in one of three modes:

- `full` - every registered local user receives the configured full-feature role and settings.
- `subscription` - preserve upstream subscription behavior for deployments that want paid or manually assigned plans.
- `core` - only core/free roles are assigned by default.

The default for this fork should become `full` for local/self-hosted deployments and `subscription` for any compatibility mode that intentionally talks to an upstream compatible subscription service.

## Server Changes

- Registration now reads `STANDARD_RED_ENTITLEMENT_MODE` from environment and defaults to `full` in this fork.
- During registration, call `ActivatePremiumFeatures` after the core user is created:
  - create a subscription row when mode is `full`;
  - assign `RoleName.NAMES.ProUser` by default;
  - apply default subscription settings;
  - set file upload limit from `STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES`.
- Add an idempotent reconciliation command for existing users.
- Add tests for registration, existing user reconciliation, role assignment, subscription expiry, and file limits.

## Client Changes

- Add a host capability endpoint or metadata field that tells the client whether the active self-hosted server is in full-feature mode.
- Replace purchase modals with "included by this server" messaging when the active server reports full-feature mode.
- Keep ordinary feature status logic based on roles and subscriptions.
- Remove hosted purchase links from fork defaults.

## Guardrails

- Do not make the client report fake subscriptions when connected to third-party hosted services.
- Do not remove server-side role checks.
- Do not weaken encryption, authentication, MFA, session, or sync checks.
- Keep copyright and AGPL notices intact.
