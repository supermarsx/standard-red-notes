#!/bin/bash

set -euo pipefail

sh supervisor/wait-for.sh localhost $SYNCING_SERVER_PORT
exec yarn node docker/entrypoint-server.js
