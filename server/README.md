# Standard Red Notes Server

Server applications monorepo for Standard Red Notes. This fork keeps the upstream service boundaries while the root repository coordinates app, server, and MCP work.

## Standard Red Entitlements

New registrations default to self-hosted full-feature mode through server-issued roles and subscription records.

Environment controls:

- `STANDARD_RED_ENTITLEMENT_MODE=full|subscription`
- `STANDARD_RED_FULL_FEATURE_DURATION_DAYS=36500`
- `STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES=-1`

Set `STANDARD_RED_ENTITLEMENT_MODE=subscription` to preserve upstream-style subscription assignment behavior.
