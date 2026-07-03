#!/bin/sh
set -eu

# Standard Red Notes — launch the single-process home-server under supervisord.
#
# Runs from the home-server package directory so:
#   - dotenv (config() in bin/server.ts) reads /opt/server/packages/home-server/.env,
#     which the container entrypoint generates from the environment on start; and
#   - `yarn node` resolves the Yarn PnP runtime for the workspace.
#
# The home-server binds 0.0.0.0:3000 (PORT is set in the generated .env). Only
# nginx (:8080) is published; :3000 stays container-internal.
cd /opt/server/packages/home-server
exec yarn node dist/bin/server.js
