#!/bin/bash

# usage: file_env VAR [DEFAULT]
#    ie: file_env 'XYZ_DB_PASSWORD' 'example'
# (will allow for "$XYZ_DB_PASSWORD_FILE" to fill in the value of
#  "$XYZ_DB_PASSWORD" from a file, especially for Docker's secrets feature)
file_env() {
	local var="$1"
	local fileVar="${var}_FILE"
	local def="${2:-}"
	if [ "${!var:-}" ] && [ "${!fileVar:-}" ]; then
		echo >&2 "error: both $var and $fileVar are set (but are exclusive)"
		exit 1
	fi
	local val="$def"
	if [ "${!var:-}" ]; then
		val="${!var}"
	elif [ "${!fileVar:-}" ]; then
		val="$(< "${!fileVar}")"
	fi
	export "$var"="$val"
	unset "$fileVar"
}

# Setup environment variables

export MODE="self-hosted"

#########
# PORTS #
#########

export API_GATEWAY_PORT=3000

if [ -z "$SYNCING_SERVER_PORT" ]; then
  export SYNCING_SERVER_PORT=3101
fi

if [ -z "$SYNCING_SERVER_GRPC_PORT" ]; then
  export SYNCING_SERVER_GRPC_PORT=50052
fi

if [ -z "$AUTH_SERVER_PORT" ]; then
  export AUTH_SERVER_PORT=3103
fi

if [ -z "$AUTH_SERVER_GRPC_PORT" ]; then
  export AUTH_SERVER_GRPC_PORT=50051
fi

export FILES_SERVER_PORT=3104

if [ -z "$REVISIONS_SERVER_PORT" ]; then
  export REVISIONS_SERVER_PORT=3105
fi

######
# DB #
######

if [ -z "$DB_HOST" ]; then
  echo "DB_HOST is not set. Please set it in your .env file."
  exit 1
fi
if [ -z "$DB_PORT" ]; then
  echo "DB_PORT is not set. Please set it in your .env file."
  exit 1
fi
file_env 'DB_USERNAME'
if [ -z "$DB_USERNAME" ]; then
  echo "DB_USERNAME is not set. Please set it in your .env file."
  exit 1
fi
file_env 'DB_PASSWORD'
if [ -z "$DB_PASSWORD" ]; then
  echo "DB_PASSWORD is not set. Please set it in your .env file."
  exit 1
fi
if [ -z "$DB_DATABASE" ]; then
  echo "DB_DATABASE is not set. Please set it in your .env file."
  exit 1
fi
if [ -z "$DB_DEBUG_LEVEL" ]; then
  export DB_DEBUG_LEVEL="all"
fi
if [ -z "$DB_TYPE" ]; then
  export DB_TYPE="mysql"
fi
if [ -z "$CACHE_TYPE" ]; then
  export CACHE_TYPE="redis"
fi
export DB_MIGRATIONS_PATH="dist/migrations/*.js"

#########
# CACHE #
#########

if [ -z "$REDIS_PORT" ]; then
  echo "REDIS_PORT is not set. Please set it in your .env file."
  exit 1
fi

if [ -z "$REDIS_HOST" ]; then
  echo "REDIS_HOST is not set. Please set it in your .env file."
  exit 1
fi

if [ -z "$REDIS_URL" ]; then
  export REDIS_URL="redis://$REDIS_HOST"
fi

##########
# SHARED #
##########

file_env 'AUTH_JWT_SECRET'
if [ -z "$AUTH_JWT_SECRET" ]; then
  echo "AUTH_JWT_SECRET is not set. Please set it in your .env file. You can run 'openssl rand -hex 32' to generate a random string."
  exit 1
fi

file_env 'VALET_TOKEN_SECRET'
if [ -z "$VALET_TOKEN_SECRET" ]; then
  echo "VALET_TOKEN_SECRET is not set. Please set it in your .env file. You can run 'openssl rand -hex 32' to generate a random string."
  exit 1
fi

# Standard Red Notes: runtime-configurable server settings (admin pane).
# The api-gateway persists admin-set overrides (AI provider config, update-check
# URL, security policy, and runtime log level) to this JSON file; PRECEDENCE:
# persisted wins over env. Every supervisord server/worker process reads the
# SAME file, so every generated per-package .env must carry the exact path.
# Mount/point a custom path at a volume if it should survive recreation.
if [ -z "$SERVER_SETTINGS_PATH" ]; then
  export SERVER_SETTINGS_PATH=/opt/server/packages/api-gateway/data/server-settings.json
fi
export API_GATEWAY_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"
export AUTH_SERVER_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"
export SYNCING_SERVER_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"
export FILES_SERVER_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"
export REVISIONS_SERVER_SERVER_SETTINGS_PATH="$SERVER_SETTINGS_PATH"

########
# AUTH #
########

if [ -z "$AUTH_SERVER_LOG_LEVEL" ]; then
  export AUTH_SERVER_LOG_LEVEL="${LOG_LEVEL:-info}"
fi
export AUTH_SERVER_NODE_ENV="production"
export AUTH_SERVER_VERSION="local"

if [ -z "$AUTH_SERVER_AUTH_JWT_TTL" ]; then
  export AUTH_SERVER_AUTH_JWT_TTL=60000
fi

export AUTH_SERVER_JWT_SECRET=$AUTH_JWT_SECRET
export AUTH_SERVER_LEGACY_JWT_SECRET=$(openssl rand -hex 32)

if [ -z "$AUTH_SERVER_DISABLE_USER_REGISTRATION" ]; then
  export AUTH_SERVER_DISABLE_USER_REGISTRATION=false
fi

file_env 'AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY'
if [ -z "$AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY" ]; then
  export AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY=$(openssl rand -hex 32)
fi

if [ -z "$AUTH_SERVER_ACCESS_TOKEN_AGE" ]; then
  export AUTH_SERVER_ACCESS_TOKEN_AGE=5184000
fi
if [ -z "$AUTH_SERVER_REFRESH_TOKEN_AGE" ]; then
  export AUTH_SERVER_REFRESH_TOKEN_AGE=31556926
fi

if [ -z "$AUTH_SERVER_MAX_LOGIN_ATTEMPTS" ]; then
  export AUTH_SERVER_MAX_LOGIN_ATTEMPTS=6
fi
if [ -z "$AUTH_SERVER_FAILED_LOGIN_LOCKOUT" ]; then
  export AUTH_SERVER_FAILED_LOGIN_LOCKOUT=3600
fi

if [ -z "$AUTH_SERVER_EPHEMERAL_SESSION_AGE" ]; then
  export AUTH_SERVER_EPHEMERAL_SESSION_AGE=259200
fi

file_env 'AUTH_SERVER_ENCRYPTION_SERVER_KEY'
if [ -z "$AUTH_SERVER_ENCRYPTION_SERVER_KEY" ]; then
  echo "AUTH_SERVER_ENCRYPTION_SERVER_KEY is not set. Please set it in your .env file. You can run 'openssl rand -hex 32' to generate a random string."
  exit 1
fi

# Outbound-email relay credentials and queued message bodies use independent
# HKDF contexts derived from the already-required server encryption key. Give
# the gateway only the narrowly named input it needs; this avoids another
# operator-managed secret while keeping the auth service's dotenv contract
# unchanged. The value is written to api-gateway/.env below and never logged.
export API_GATEWAY_EMAIL_DELIVERY_ENCRYPTION_KEY="$AUTH_SERVER_ENCRYPTION_SERVER_KEY"

########################
# INSECURE-DEFAULT GUARD #
########################
#
# Hardening: refuse to start if a PUBLISHED default secret is still in use.
# These values ship in docker-compose.yml / docs as placeholders so the stack
# boots on localhost out of the box, but they are PUBLIC: anyone can read this
# repo. A self-hoster who exposes the stack without overriding them would be
# signing JWTs / valet tokens and encrypting MFA secrets with keys the whole
# internet knows. We hard-fail here so that can't happen silently.
#
# Local dev that intentionally wants the defaults can opt out by setting
# ALLOW_INSECURE_DEFAULTS=true (e.g. on localhost behind no public exposure).
INSECURE_ENCRYPTION_DEFAULT="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
INSECURE_JWT_DEFAULT="dev-auth-jwt-secret-change-me"
INSECURE_VALET_DEFAULT="dev-valet-token-secret-change-me"
# Same published defaults for the realtime-gateway signing keys and the DB
# password (all shipped in docker-compose.yml). WEB_SOCKET_CONNECTION_TOKEN_SECRET
# signs the short-lived tokens the browser presents to open the realtime socket,
# so a known value lets anyone forge realtime access; WEBSOCKET_GATEWAY_INTERNAL_
# SECRET authenticates the in-process gateway bridge; MYSQL_PASSWORD is the
# database account password. They are just as public as the three above.
INSECURE_WS_CONN_TOKEN_DEFAULT="dev-ws-conn-token-secret-change-me"
INSECURE_WS_INTERNAL_DEFAULT="dev-ws-internal-secret-change-me"
INSECURE_MYSQL_PASSWORD_DEFAULT="changeme123"

case "$(printf '%s' "${ALLOW_INSECURE_DEFAULTS:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ALLOW_INSECURE_DEFAULTS_NORM="true" ;;
  *) ALLOW_INSECURE_DEFAULTS_NORM="false" ;;
esac

if [ "$ALLOW_INSECURE_DEFAULTS_NORM" != "true" ]; then
  insecure_found=""
  if [ "$AUTH_SERVER_ENCRYPTION_SERVER_KEY" = "$INSECURE_ENCRYPTION_DEFAULT" ]; then
    insecure_found="${insecure_found} AUTH_SERVER_ENCRYPTION_SERVER_KEY"
  fi
  if [ "$AUTH_JWT_SECRET" = "$INSECURE_JWT_DEFAULT" ]; then
    insecure_found="${insecure_found} AUTH_JWT_SECRET"
  fi
  if [ "$VALET_TOKEN_SECRET" = "$INSECURE_VALET_DEFAULT" ]; then
    insecure_found="${insecure_found} VALET_TOKEN_SECRET"
  fi
  if [ "${WEB_SOCKET_CONNECTION_TOKEN_SECRET:-}" = "$INSECURE_WS_CONN_TOKEN_DEFAULT" ]; then
    insecure_found="${insecure_found} WEB_SOCKET_CONNECTION_TOKEN_SECRET"
  fi
  if [ "${WEBSOCKET_GATEWAY_INTERNAL_SECRET:-}" = "$INSECURE_WS_INTERNAL_DEFAULT" ]; then
    insecure_found="${insecure_found} WEBSOCKET_GATEWAY_INTERNAL_SECRET"
  fi
  # In the server container the DB password arrives as DB_PASSWORD (compose maps
  # MYSQL_PASSWORD -> DB_PASSWORD). Report it under the MYSQL_PASSWORD name the
  # operator actually sets.
  if [ "${DB_PASSWORD:-}" = "$INSECURE_MYSQL_PASSWORD_DEFAULT" ]; then
    insecure_found="${insecure_found} MYSQL_PASSWORD"
  fi
  if [ -n "$insecure_found" ]; then
    echo >&2 "==============================================================================="
    echo >&2 "FATAL: refusing to start with PUBLISHED default secret(s) still in use:"
    echo >&2 "      ${insecure_found}"
    echo >&2 ""
    echo >&2 "These placeholder values are public (they live in this repo's docker-compose.yml"
    echo >&2 "and docs). Running with them means your signing/encryption keys are known to"
    echo >&2 "anyone. Generate real secrets and set them in your .env, e.g.:"
    echo >&2 "      openssl rand -hex 32"
    echo >&2 ""
    echo >&2 "For a throwaway LOCAL/dev instance that is not publicly exposed, you can bypass"
    echo >&2 "this check by setting ALLOW_INSECURE_DEFAULTS=true."
    echo >&2 "==============================================================================="
    exit 1
  fi
fi

export AUTH_SERVER_SYNCING_SERVER_URL=http://localhost:$SYNCING_SERVER_PORT

# File Uploads
if [ -z "$AUTH_SERVER_VALET_TOKEN_TTL" ]; then
  export AUTH_SERVER_VALET_TOKEN_TTL=7200
fi
if [ -z "$AUTH_SERVER_FILE_UPLOAD_PATH" ]; then
  export AUTH_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"
fi
if [ -z "$AUTH_SERVER_EMAIL_ATTACHMENT_MAX_BYTE_SIZE" ]; then
  export AUTH_SERVER_EMAIL_ATTACHMENT_MAX_BYTE_SIZE=10485760
fi

# Outbound email and optional S3 backup credentials support Docker secrets.
file_env 'AUTH_SERVER_SMTP_PASS'
# Keep both outbound-email consumers on one baseline, including deployments
# upgraded from Compose revisions that only injected AUTH_SERVER_SMTP_*.
if [ -z "${API_GATEWAY_SMTP_HOST:-}" ]; then export API_GATEWAY_SMTP_HOST="${AUTH_SERVER_SMTP_HOST:-}"; fi
if [ -z "${API_GATEWAY_SMTP_PORT:-}" ]; then export API_GATEWAY_SMTP_PORT="${AUTH_SERVER_SMTP_PORT:-}"; fi
if [ -z "${API_GATEWAY_SMTP_USER:-}" ]; then export API_GATEWAY_SMTP_USER="${AUTH_SERVER_SMTP_USER:-}"; fi
if [ -z "${API_GATEWAY_SMTP_PASS:-}" ]; then export API_GATEWAY_SMTP_PASS="${AUTH_SERVER_SMTP_PASS:-}"; fi
if [ -z "${API_GATEWAY_SMTP_FROM:-}" ]; then export API_GATEWAY_SMTP_FROM="${AUTH_SERVER_SMTP_FROM:-}"; fi
if [ -z "${API_GATEWAY_SMTP_SECURE:-}" ]; then export API_GATEWAY_SMTP_SECURE="${AUTH_SERVER_SMTP_SECURE:-}"; fi
if [ -z "${API_GATEWAY_SMTP_ALLOW_INSECURE:-}" ]; then
  export API_GATEWAY_SMTP_ALLOW_INSECURE="${AUTH_SERVER_SMTP_ALLOW_INSECURE:-false}"
fi
file_env 'AUTH_SERVER_S3_ACCESS_KEY_ID'
file_env 'AUTH_SERVER_S3_SECRET_ACCESS_KEY'

# SNS/SQS emulator setup (floci — the compose stack's LocalStack replacement)
if [ -z "$AUTH_SERVER_SNS_TOPIC_ARN" ]; then
  export AUTH_SERVER_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:auth-local-topic"
fi
if [ -z "$AUTH_SERVER_NEXTCLOUD_BACKUP_SNS_TOPIC_ARN" ]; then
  export AUTH_SERVER_NEXTCLOUD_BACKUP_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:nextcloud-backup-local-topic"
fi
if [ -z "$AUTH_SERVER_SNS_ENDPOINT" ]; then
  export AUTH_SERVER_SNS_ENDPOINT="http://floci:4566"
fi
file_env 'AUTH_SERVER_SNS_SECRET_ACCESS_KEY'
if [ -z "$AUTH_SERVER_SNS_SECRET_ACCESS_KEY" ]; then
  export AUTH_SERVER_SNS_SECRET_ACCESS_KEY="x"
fi
file_env 'AUTH_SERVER_SNS_ACCESS_KEY_ID'
if [ -z "$AUTH_SERVER_SNS_ACCESS_KEY_ID" ]; then
  export AUTH_SERVER_SNS_ACCESS_KEY_ID="x"
fi
if [ -z "$AUTH_SERVER_SNS_AWS_REGION" ]; then
  export AUTH_SERVER_SNS_AWS_REGION="us-east-1"
fi
if [ -z "$AUTH_SERVER_SQS_QUEUE_URL" ]; then
  export AUTH_SERVER_SQS_QUEUE_URL="http://floci:4566/000000000000/auth-local-queue"
fi
if [ -z "$AUTH_SERVER_SQS_AWS_REGION" ]; then
  export AUTH_SERVER_SQS_AWS_REGION="us-east-1"
fi
file_env 'AUTH_SERVER_SQS_ACCESS_KEY_ID'
if [ -z "$AUTH_SERVER_SQS_ACCESS_KEY_ID" ]; then
  export AUTH_SERVER_SQS_ACCESS_KEY_ID="x"
fi
file_env 'AUTH_SERVER_SQS_SECRET_ACCESS_KEY'
if [ -z "$AUTH_SERVER_SQS_SECRET_ACCESS_KEY" ]; then
  export AUTH_SERVER_SQS_SECRET_ACCESS_KEY="x"
fi
if [ -z "$AUTH_SERVER_SQS_ENDPOINT" ]; then
  export AUTH_SERVER_SQS_ENDPOINT="http://floci:4566"
fi

# U2F Setup
if [ -z "$AUTH_SERVER_U2F_RELYING_PARTY_ID" ]; then
  export AUTH_SERVER_U2F_RELYING_PARTY_ID="localhost"
fi
if [ -z "$AUTH_SERVER_U2F_RELYING_PARTY_NAME" ]; then
  export AUTH_SERVER_U2F_RELYING_PARTY_NAME="Standard Red Notes"
fi
if [ -z "$AUTH_SERVER_U2F_EXPECTED_ORIGIN" ]; then
  # Self-hosted default: local origins only. Set AUTH_SERVER_U2F_EXPECTED_ORIGIN
  # (and AUTH_SERVER_U2F_RELYING_PARTY_ID) to your own domain in production — do
  # NOT trust security-key assertions for app.standardnotes.com.
  export AUTH_SERVER_U2F_EXPECTED_ORIGIN="http://localhost,http://localhost:3001"
fi
if [ -z "$AUTH_SERVER_U2F_REQUIRE_USER_VERIFICATION" ]; then
  export AUTH_SERVER_U2F_REQUIRE_USER_VERIFICATION=false
fi

printenv | grep AUTH_SERVER_ | sed 's/AUTH_SERVER_//g' > /opt/server/packages/auth/.env

##################
# SYNCING SERVER #
##################

if [ -z "$SYNCING_SERVER_LOG_LEVEL" ]; then
  export SYNCING_SERVER_LOG_LEVEL="${LOG_LEVEL:-info}"
fi
export SYNCING_SERVER_NODE_ENV=production
export SYNCING_SERVER_VERSION=local

if [ -z "$SYNCING_SERVER_SNS_TOPIC_ARN" ]; then
  export SYNCING_SERVER_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:syncing-server-local-topic"
fi
if [ -z "$SYNCING_SERVER_SNS_ENDPOINT" ]; then
  export SYNCING_SERVER_SNS_ENDPOINT="http://floci:4566"
fi
file_env 'SYNCING_SERVER_SNS_SECRET_ACCESS_KEY'
if [ -z "$SYNCING_SERVER_SNS_SECRET_ACCESS_KEY" ]; then
  export SYNCING_SERVER_SNS_SECRET_ACCESS_KEY="x"
fi
file_env 'SYNCING_SERVER_SNS_ACCESS_KEY_ID'
if [ -z "$SYNCING_SERVER_SNS_ACCESS_KEY_ID" ]; then
  export SYNCING_SERVER_SNS_ACCESS_KEY_ID="x"
fi
if [ -z "$SYNCING_SERVER_SNS_AWS_REGION" ]; then
  export SYNCING_SERVER_SNS_AWS_REGION="us-east-1"
fi
if [ -z "$SYNCING_SERVER_SQS_QUEUE_URL" ]; then
  export SYNCING_SERVER_SQS_QUEUE_URL="http://floci:4566/000000000000/syncing-server-local-queue"
fi
if [ -z "$SYNCING_SERVER_SQS_AWS_REGION" ]; then
  export SYNCING_SERVER_SQS_AWS_REGION="us-east-1"
fi
file_env 'SYNCING_SERVER_SQS_ACCESS_KEY_ID'
if [ -z "$SYNCING_SERVER_SQS_ACCESS_KEY_ID" ]; then
  export SYNCING_SERVER_SQS_ACCESS_KEY_ID="x"
fi
file_env 'SYNCING_SERVER_SQS_SECRET_ACCESS_KEY'
if [ -z "$SYNCING_SERVER_SQS_SECRET_ACCESS_KEY" ]; then
  export SYNCING_SERVER_SQS_SECRET_ACCESS_KEY="x"
fi
if [ -z "$SYNCING_SERVER_SQS_ENDPOINT" ]; then
  export SYNCING_SERVER_SQS_ENDPOINT="http://floci:4566"
fi

export SYNCING_SERVER_AUTH_SERVER_URL=http://localhost:$AUTH_SERVER_PORT

if [ -z "$SYNCING_SERVER_EMAIL_ATTACHMENT_MAX_BYTE_SIZE" ]; then
  export SYNCING_SERVER_EMAIL_ATTACHMENT_MAX_BYTE_SIZE=10485760
fi

if [ -z "$SYNCING_SERVER_REVISIONS_FREQUENCY" ]; then
  export SYNCING_SERVER_REVISIONS_FREQUENCY=300
fi

if [ -z "$SYNCING_SERVER_FILE_UPLOAD_PATH" ]; then
  export SYNCING_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"
fi
file_env 'SYNCING_SERVER_S3_ACCESS_KEY_ID'
file_env 'SYNCING_SERVER_S3_SECRET_ACCESS_KEY'

printenv | grep SYNCING_SERVER_ | sed 's/SYNCING_SERVER_//g' > /opt/server/packages/syncing-server/.env


################
# FILES SERVER #
################

if [ -z "$FILES_SERVER_LOG_LEVEL" ]; then
  export FILES_SERVER_LOG_LEVEL="${LOG_LEVEL:-info}"
fi
export FILES_SERVER_NODE_ENV="production"
export FILES_SERVER_VERSION="local"

# The TypeScript fallback resolves relative to dist/src/Bootstrap at runtime,
# which points inside the compiled tree rather than at the shared uploads
# volume. Keep the files service on the same durable, writable path used by
# auth and syncing, while preserving an operator-supplied override.
if [ -z "$FILES_SERVER_FILE_UPLOAD_PATH" ]; then
  export FILES_SERVER_FILE_UPLOAD_PATH="/opt/shared/uploads"
fi

if [ -z "$FILES_SERVER_MAX_CHUNK_BYTES" ]; then
  export FILES_SERVER_MAX_CHUNK_BYTES=100000000
fi

if [ -z "$FILES_SERVER_SNS_TOPIC_ARN" ]; then
  export FILES_SERVER_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:files-local-topic"
fi
if [ -z "$FILES_SERVER_SNS_ENDPOINT" ]; then
  export FILES_SERVER_SNS_ENDPOINT="http://floci:4566"
fi
file_env 'FILES_SERVER_SNS_SECRET_ACCESS_KEY'
if [ -z "$FILES_SERVER_SNS_SECRET_ACCESS_KEY" ]; then
  export FILES_SERVER_SNS_SECRET_ACCESS_KEY="x"
fi
file_env 'FILES_SERVER_SNS_ACCESS_KEY_ID'
if [ -z "$FILES_SERVER_SNS_ACCESS_KEY_ID" ]; then
  export FILES_SERVER_SNS_ACCESS_KEY_ID="x"
fi
if [ -z "$FILES_SERVER_SNS_AWS_REGION" ]; then
  export FILES_SERVER_SNS_AWS_REGION="us-east-1"
fi
if [ -z "$FILES_SERVER_SQS_QUEUE_URL" ]; then
  export FILES_SERVER_SQS_QUEUE_URL="http://floci:4566/000000000000/files-local-queue"
fi
if [ -z "$FILES_SERVER_SQS_AWS_REGION" ]; then
  export FILES_SERVER_SQS_AWS_REGION="us-east-1"
fi
file_env 'FILES_SERVER_SQS_ACCESS_KEY_ID'
if [ -z "$FILES_SERVER_SQS_ACCESS_KEY_ID" ]; then
  export FILES_SERVER_SQS_ACCESS_KEY_ID="x"
fi
file_env 'FILES_SERVER_SQS_SECRET_ACCESS_KEY'
if [ -z "$FILES_SERVER_SQS_SECRET_ACCESS_KEY" ]; then
  export FILES_SERVER_SQS_SECRET_ACCESS_KEY="x"
fi
if [ -z "$FILES_SERVER_SQS_ENDPOINT" ]; then
  export FILES_SERVER_SQS_ENDPOINT="http://floci:4566"
fi

printenv | grep FILES_SERVER_ | sed 's/FILES_SERVER_//g' > /opt/server/packages/files/.env

#############
# REVISIONS #
#############

if [ -z "$REVISIONS_SERVER_LOG_LEVEL" ]; then
  export REVISIONS_SERVER_LOG_LEVEL="${LOG_LEVEL:-info}"
fi

export REVISIONS_SERVER_NODE_ENV="production"
export REVISIONS_SERVER_VERSION="local"

if [ -z "$REVISIONS_SERVER_SNS_TOPIC_ARN" ]; then
  export REVISIONS_SERVER_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:revisions-server-local-topic"
fi
if [ -z "$REVISIONS_SERVER_SNS_ENDPOINT" ]; then
  export REVISIONS_SERVER_SNS_ENDPOINT="http://floci:4566"
fi
file_env 'REVISIONS_SERVER_SNS_SECRET_ACCESS_KEY'
if [ -z "$REVISIONS_SERVER_SNS_SECRET_ACCESS_KEY" ]; then
  export REVISIONS_SERVER_SNS_SECRET_ACCESS_KEY="x"
fi
file_env 'REVISIONS_SERVER_SNS_ACCESS_KEY_ID'
if [ -z "$REVISIONS_SERVER_SNS_ACCESS_KEY_ID" ]; then
  export REVISIONS_SERVER_SNS_ACCESS_KEY_ID="x"
fi
if [ -z "$REVISIONS_SERVER_SNS_AWS_REGION" ]; then
  export REVISIONS_SERVER_SNS_AWS_REGION="us-east-1"
fi
if [ -z "$REVISIONS_SERVER_SQS_QUEUE_URL" ]; then
  export REVISIONS_SERVER_SQS_QUEUE_URL="http://floci:4566/000000000000/revisions-server-local-queue"
fi
if [ -z "$REVISIONS_SERVER_SQS_AWS_REGION" ]; then
  export REVISIONS_SERVER_SQS_AWS_REGION="us-east-1"
fi
file_env 'REVISIONS_SERVER_SQS_ACCESS_KEY_ID'
if [ -z "$REVISIONS_SERVER_SQS_ACCESS_KEY_ID" ]; then
  export REVISIONS_SERVER_SQS_ACCESS_KEY_ID="x"
fi
file_env 'REVISIONS_SERVER_SQS_SECRET_ACCESS_KEY'
if [ -z "$REVISIONS_SERVER_SQS_SECRET_ACCESS_KEY" ]; then
  export REVISIONS_SERVER_SQS_SECRET_ACCESS_KEY="x"
fi
if [ -z "$REVISIONS_SERVER_SQS_ENDPOINT" ]; then
  export REVISIONS_SERVER_SQS_ENDPOINT="http://floci:4566"
fi

printenv | grep REVISIONS_SERVER_ | sed 's/REVISIONS_SERVER_//g' > /opt/server/packages/revisions/.env

###############
# API GATEWAY #
###############

if [ -z "$API_GATEWAY_LOG_LEVEL" ]; then
  export API_GATEWAY_LOG_LEVEL="${LOG_LEVEL:-info}"
fi
export API_GATEWAY_NODE_ENV=production
export API_GATEWAY_VERSION=local

# Optional public deployment identity. The sourced helper first removes direct
# API_GATEWAY_* injection, then validates the unprefixed Compose expectation.
# shellcheck disable=SC1091
. /usr/local/bin/deployment-identity-env.sh

export API_GATEWAY_SYNCING_SERVER_JS_URL=http://localhost:$SYNCING_SERVER_PORT
export API_GATEWAY_SYNCING_SERVER_GRPC_URL=0.0.0.0:$SYNCING_SERVER_GRPC_PORT
export API_GATEWAY_AUTH_SERVER_URL=http://localhost:$AUTH_SERVER_PORT
export API_GATEWAY_AUTH_SERVER_GRPC_URL=0.0.0.0:$AUTH_SERVER_GRPC_PORT
export API_GATEWAY_REVISIONS_SERVER_URL=http://localhost:$REVISIONS_SERVER_PORT
# Public files URL the gateway advertises to clients (meta.server.filesServerUrl).
# docker-compose.yml always sets this (default http://localhost:3001/files — the
# app front door's /files/ prefix-strip proxy; the files service publishes no
# host port there). The fallback below only applies when this image is run BARE
# (no compose / no app nginx), where publishing 3125:3104 yourself is the
# simplest way to reach the files service directly.
if [ -z "$PUBLIC_FILES_SERVER_URL" ]; then
  export PUBLIC_FILES_SERVER_URL=http://localhost:3125
fi
export API_GATEWAY_FILES_SERVER_URL=$PUBLIC_FILES_SERVER_URL

printenv | grep API_GATEWAY_ | sed 's/API_GATEWAY_//g' > /opt/server/packages/api-gateway/.env

# Run supervisor

supervisord -c /etc/supervisord.conf

exec "$@"
