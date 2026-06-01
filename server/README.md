# Standard Red Notes Server

Server applications monorepo for Standard Red Notes. This fork keeps the upstream service boundaries while the root repository coordinates app, server, and MCP work.

## Included Features

New registrations default to full-feature self-hosted mode without needing subscription rows. Feature and subscription queries synthesize included Pro-level access in the normal Standard Red Notes runtime.

Environment controls:

- `STANDARD_RED_FEATURES_MODE=included|legacy`
- `STANDARD_RED_ENTITLEMENT_MODE=included|provisioned-full|subscription` (deprecated compatibility bridge)
- `STANDARD_RED_FULL_FEATURE_DURATION_DAYS=36500`
- `STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES=-1`

Use included-feature mode for Standard Red Notes deployments. Use legacy/subscription mode only for compatibility testing, and avoid `provisioned-full` unless you intentionally need old subscription-shaped provisioning.
