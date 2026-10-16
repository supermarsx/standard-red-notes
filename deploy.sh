#!/usr/bin/env bash
#
# Standard Red Notes - self-hosting deploy script (macOS / Linux)
#
# Pulls the latest Git revision, backs up the database, rebuilds the images
# stamped with the exact commit, brings the Docker Compose stack up, and then
# PROVES the stack actually booted. A green build is not a running server.
#
# Two modes, detected automatically and announced before anything happens:
#
#   SETUP   not configured yet. Generates .env by running scripts/setup.sh,
#           then builds, starts and verifies. Nothing to back up on a first
#           install.
#   UPDATE  configured. Pulls, backs up the database, rebuilds, restarts and
#           verifies. Safe to run twice; it reseeds nothing and never edits .env.
#
# "Configured" is not "an .env file exists". It means .env exists AND every
# variable the chosen Compose file declares as required is present and
# non-empty. A stub .env that cannot render the Compose file is reported as
# such, with the missing variables named, instead of being taken for a working
# deployment.
#
# Usage:
#   ./deploy.sh                      # detect the mode and do the right thing
#   ./deploy.sh --dry-run            # print every command, change nothing
#   ./deploy.sh --yes                # non-interactive (no confirmation prompt)
#   ./deploy.sh --single             # the all-in-one docker-compose.single.yml
#   ./deploy.sh --web-only           # health-gated web update; leave backend running
#   ./deploy.sh --rolling-web        # keep web serving while updating the backend too
#   ./deploy.sh --web-rollback       # restore the previous healthy web release
#   ./deploy.sh --no-pull            # deploy the checked-out revision as-is
#   ./deploy.sh --no-backup          # skip the pre-deploy database backup
#   ./deploy.sh --proxy-network=npm_default   # behind a containerised proxy
#   ./deploy.sh --proxy-network=npm_default --create-network
#   ./deploy.sh --no-proxy           # leave the proxy network again
#
# REMEMBERED BETWEEN RUNS. The choices that decide WHICH stack this is and HOW
# it is reached are written to .deploy-state beside this script, and read back
# at the top of every later run:
#
#   --single / --file       which Compose file
#   -p / --project          the Compose project name
#   --proxy-network         the reverse-proxy network, together with
#                           --proxy-alias and --publish-ports
#
# So after `./deploy.sh --proxy-network=npm_default`, a plain `./deploy.sh`
# redeploys onto npm_default again. Every run prints which file it read and
# what it took from it before it does anything else.
#
#   - The proxy settings change only by an explicit flag (a different
#     --proxy-network=NAME, --no-proxy, --no-publish-ports, --proxy-alias).
#     The change is announced before anything happens and is then remembered
#     in turn.
#   - A remembered proxy network that no longer exists STOPS the deploy. The
#     script never falls back to publishing a host port: that would detach the
#     site from its proxy and open an unproxied front door in one step.
#   - --single, --file and -p say WHICH deployment this is, so they are never
#     changed in place. A command line naming a different one from the one
#     remembered is refused, with the ways out; settings are never carried
#     from one deployment to another.
#   - On a first install with a terminal attached and no proxy flag, the
#     script asks whether the stack sits behind a containerised reverse proxy
#     and lists the Docker networks to choose from. It never asks under --yes
#     or without a terminal.
#   - A deployment made before settings were remembered, whose app container
#     was started with the proxy overlay, is carried forward as it is rather
#     than taken off the network.
#
# .deploy-state holds no secrets, is parsed and never executed, and is ignored
# by Git, so it survives `git pull`. Nothing is written to it under --dry-run.
# Deleting it forgets what it holds, but that is not the way off a proxy
# network: use --no-proxy.
#
# Flags:
#   -h, --help              Show this help and exit.
#       --setup             Force the first-install path. Refuses if .env exists.
#       --update            Force the update path. Refuses if .env is missing.
#       --single            Deploy docker-compose.single.yml (all-in-one, SQLite).
#                           Remembered.
#   -f, --file PATH         Deploy an explicit Compose file instead. Remembered.
#   -p, --project NAME      Compose project name (COMPOSE_PROJECT_NAME).
#                           Remembered, as is a COMPOSE_PROJECT_NAME inherited
#                           from the environment.
#       --no-pull           Do not run `git pull`.
#       --no-backup         Do not back up the database first. NOT RECOMMENDED:
#                           migrations run on container boot and a rebuild
#                           cannot undo them.
#       --backup-dir DIR    Where backups land (default: ./backups).
#       --proxy-network[=NAME]
#                           Put the stack behind an externally managed reverse
#                           proxy by applying docker-compose.proxy.yml (or
#                           docker-compose.single.proxy.yml with --single):
#                           `app` joins the named external network and stops
#                           publishing a host port. Nothing else joins it.
#                           NAME may also be given as the next argument.
#                           Without a NAME it means the remembered network, or
#                           `proxy` when none is remembered. Remembered.
#       --no-proxy          Leave the proxy network: `app` publishes APP_PORT
#                           on the host again. Remembered. This is the only
#                           way out of proxy mode; it is never left implicitly.
#       --proxy-alias NAME  The name `app` answers to on the proxy network
#                           (default: standard-red-notes-app, or
#                           SRN_PROXY_ALIAS). Remembered.
#       --create-network    Create the proxy network if it does not exist.
#                           Without this, a missing network is an error that
#                           prints the exact `docker network create` to run -
#                           your proxy usually brings its own network, and
#                           silently making a second one with the same purpose
#                           leaves the proxy unable to see the app. Applies to
#                           this run only; it is never remembered.
#       --publish-ports     In proxy mode, ALSO publish APP_PORT on 127.0.0.1
#                           for local debugging. Remembered.
#       --no-publish-ports  Stop doing that. Remembered.
#       --state-file PATH   Read and write the remembered settings there
#                           instead of ./.deploy-state. For a second
#                           deployment from the same checkout: a state file
#                           remembers exactly one.
#       --allow-dirty       Deploy a checkout with uncommitted content changes.
#                           The images are then built UNSTAMPED, because a
#                           commit stamp on modified sources is a lie, and the
#                           deployment-identity check is skipped.
#       --timeout SECONDS   How long to wait for containers to become healthy
#                           (default: 600). Each web-handover readiness phase
#                           gets this budget separately; builds do not spend it.
#       --log-lines N       Log lines to print from a failing container
#                           (default: 200).
#       --url BASE          Base URL for the post-deploy HTTP check. Default:
#                           the host port Compose reports for the app service
#                           (`compose port app 8080`), falling back to
#                           APP_PORT / APP_BIND_ADDRESS from .env only when no
#                           port is published. Use this to probe through the
#                           proxy itself.
#   -y, --yes               Assume yes; never prompt.
#   -n, --dry-run           Print every command that would run; change nothing.
#
# This script NEVER creates or modifies .env, never stashes, never prunes, and
# never removes a volume. It reads .env without sourcing it. Besides the
# backups, the only files it writes are .deploy-state and, for the
# multi-container stack, docker-compose.override.yml: a copy of the remembered
# settings in the one file Compose loads by itself, so that a hand-typed
# `docker compose up -d` in this directory deploys the same way too. It never
# touches an override file it did not generate.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths (run from anywhere; everything is relative to the repo root)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
ENV_FILE="${REPO_ROOT}/.env"

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
ASSUME_YES=0
DRY_RUN=0
FORCE_MODE=""
DO_PULL=1
DO_BACKUP=1
ALLOW_DIRTY=0
BACKUP_DIR="${REPO_ROOT}/backups"
CREATE_NETWORK=0
HEALTH_TIMEOUT=600
WEB_ONLY=0
WEB_ROLLBACK=0
ROLLING_WEB=0
LOG_LINES=200
HEALTH_URL=""

# The remembered choices. ARG_* records only what THIS command line said, so
# that "not mentioned" can resolve to the saved value rather than to a default
# that silently undoes it. They are resolved against .deploy-state in section 0.
ARG_SINGLE=0
ARG_COMPOSE_FILE=""
ARG_PROJECT=""
ARG_PROXY_ON=0
ARG_PROXY_OFF=0
ARG_PROXY_NETWORK=""
ARG_PROXY_NETWORK_GIVEN=0
ARG_PROXY_ALIAS=""
ARG_PROXY_ALIAS_GIVEN=0
ARG_PUBLISH_ON=0
ARG_PUBLISH_OFF=0
DEFAULT_STATE_FILE="${REPO_ROOT}/.deploy-state"
STATE_FILE="$DEFAULT_STATE_FILE"

show_help() {
  # Print only the contiguous comment block under the shebang. `grep '^#'` over
  # the whole file (as scripts/setup.sh does) also prints every section divider
  # further down, which buries the flag list it is supposed to show.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

need_value() {
  # need_value FLAG VALUE -- a flag that silently consumed the next flag as its
  # value is how `--timeout --yes` becomes a 0-second timeout.
  case "${2:-}" in
    ""|-*)
      echo "Missing value for $1" >&2
      exit 2
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) show_help; exit 0 ;;
    --setup) FORCE_MODE="setup" ;;
    --update) FORCE_MODE="update" ;;
    --single) ARG_SINGLE=1 ;;
    --web-only) WEB_ONLY=1; DO_BACKUP=0 ;;
    --rolling-web) ROLLING_WEB=1 ;;
    --web-rollback) WEB_ONLY=1; WEB_ROLLBACK=1; DO_BACKUP=0; DO_PULL=0 ;;
    -f|--file) need_value "$1" "${2:-}"; ARG_COMPOSE_FILE="$2"; shift ;;
    -p|--project) need_value "$1" "${2:-}"; ARG_PROJECT="$2"; shift ;;
    --no-pull) DO_PULL=0 ;;
    --no-backup) DO_BACKUP=0 ;;
    --backup-dir) need_value "$1" "${2:-}"; BACKUP_DIR="$2"; shift ;;
    --proxy-network) # bare: the remembered network, else `proxy`; `--proxy-network NAME` also accepted
      ARG_PROXY_ON=1
      case "${2:-}" in
        ""|-*) ;;
        *) ARG_PROXY_NETWORK="$2"; ARG_PROXY_NETWORK_GIVEN=1; shift ;;
      esac
      ;;
    --proxy-network=*) ARG_PROXY_ON=1; ARG_PROXY_NETWORK="${1#*=}"; ARG_PROXY_NETWORK_GIVEN=1 ;;
    --no-proxy) ARG_PROXY_OFF=1 ;;
    --proxy-alias) need_value "$1" "${2:-}"; ARG_PROXY_ALIAS="$2"; ARG_PROXY_ALIAS_GIVEN=1; shift ;;
    --proxy-alias=*) ARG_PROXY_ALIAS="${1#*=}"; ARG_PROXY_ALIAS_GIVEN=1 ;;
    --create-network) CREATE_NETWORK=1 ;;
    --publish-ports) ARG_PUBLISH_ON=1 ;;
    --no-publish-ports) ARG_PUBLISH_OFF=1 ;;
    --state-file) need_value "$1" "${2:-}"; STATE_FILE="$2"; shift ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --timeout) need_value "$1" "${2:-}"; HEALTH_TIMEOUT="$2"; shift ;;
    --log-lines) need_value "$1" "${2:-}"; LOG_LINES="$2"; shift ;;
    --url) need_value "$1" "${2:-}"; HEALTH_URL="$2"; shift ;;
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    *) echo "Unknown argument: $1" >&2; echo "Try: $0 --help" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Pretty output helpers (same shape as scripts/setup.sh)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"; CYAN="$(printf '\033[36m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
info()  { printf '%s\n' "${CYAN}$*${RESET}"; }
ok()    { printf '%s\n' "${GREEN}$*${RESET}"; }
warn()  { printf '%s\n' "${YELLOW}$*${RESET}"; }
err()   { printf '%s\n' "${RED}$*${RESET}" >&2; }
title() { printf '\n%s\n' "${BOLD}$*${RESET}"; }

for numeric in HEALTH_TIMEOUT LOG_LINES; do
  if ! [[ "${!numeric}" =~ ^[0-9]+$ ]] || [ "${!numeric}" -eq 0 ]; then
    err "${numeric} must be a positive integer (got: ${!numeric})."
    exit 2
  fi
done

# Contradictions that need nothing but the command line. Whatever also depends
# on what is remembered is decided in section 0, once that has been read.
if [ "$ROLLING_WEB" -eq 1 ] && [ "$WEB_ONLY" -eq 1 ]; then
  err "--rolling-web updates the backend; --web-only/--web-rollback leave it running. Choose one."
  exit 2
fi
if [ "$ARG_SINGLE" -eq 1 ] && [ -n "$ARG_COMPOSE_FILE" ]; then
  err "--single and --file are mutually exclusive; --single already selects docker-compose.single.yml."
  exit 2
fi
if [ "$ARG_PROXY_ON" -eq 1 ] && [ "$ARG_PROXY_OFF" -eq 1 ]; then
  err "--proxy-network and --no-proxy contradict each other."
  exit 2
fi
if [ "$ARG_PUBLISH_ON" -eq 1 ] && [ "$ARG_PUBLISH_OFF" -eq 1 ]; then
  err "--publish-ports and --no-publish-ports contradict each other."
  exit 2
fi
if [ "$ARG_PROXY_OFF" -eq 1 ]; then
  if [ "$CREATE_NETWORK" -eq 1 ] || [ "$ARG_PUBLISH_ON" -eq 1 ] || [ "$ARG_PROXY_ALIAS_GIVEN" -eq 1 ]; then
    err "--create-network, --publish-ports and --proxy-alias configure the proxy"
    err "  network, and --no-proxy leaves it. Pass one or the other."
    exit 2
  fi
fi

# A name that reaches a docker command line is checked first, whether it was
# typed just now or read back from .deploy-state. A leading dash would be taken
# for an option, and anything outside this alphabet is not a name Docker or
# Compose would have accepted in the first place.
NETWORK_NAME_PATTERN='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
PROJECT_NAME_PATTERN='^[a-z0-9][a-z0-9_-]*$'
valid_network_name() { [ "${#1}" -le 128 ] && [[ "$1" =~ $NETWORK_NAME_PATTERN ]]; }
valid_project_name() { [ "${#1}" -le 128 ] && [[ "$1" =~ $PROJECT_NAME_PATTERN ]]; }

if [ "$ARG_PROXY_NETWORK_GIVEN" -eq 1 ]; then
  if [ -z "$ARG_PROXY_NETWORK" ]; then
    err "--proxy-network was given an empty network name."
    exit 2
  fi
  if ! valid_network_name "$ARG_PROXY_NETWORK"; then
    err "--proxy-network: '${ARG_PROXY_NETWORK}' is not a Docker network name."
    err "  A name starts with a letter or digit and continues with letters, digits,"
    err "  '_', '.' or '-'. List the real ones with: docker network ls"
    exit 2
  fi
fi
if [ "$ARG_PROXY_ALIAS_GIVEN" -eq 1 ] && ! valid_network_name "$ARG_PROXY_ALIAS"; then
  err "--proxy-alias: '${ARG_PROXY_ALIAS}' cannot be used as a network alias."
  err "  An alias starts with a letter or digit and continues with letters, digits,"
  err "  '_', '.' or '-'."
  exit 2
fi

# ---------------------------------------------------------------------------
# Command execution. Every mutating command goes through run(), so --dry-run
# prints exactly what would have happened and executes nothing.
# ---------------------------------------------------------------------------
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s %s\n' "${DIM}would run:${RESET}" "$*"
    return 0
  fi
  printf '%s %s\n' "${DIM}+${RESET}" "$*"
  "$@"
}

# Read-only queries. These change nothing, so they run even under --dry-run;
# a dry run that cannot see the live stack cannot tell you what it would do.
compose_query() { "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}" "$@"; }
compose_display() { printf '%s %s' "${COMPOSE[*]}" "${COMPOSE_FILE_ARGS[*]}"; }

confirm() {
  local question="$1" answer
  if [ "$ASSUME_YES" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then
    err "${question} -- no terminal to ask on. Re-run with --yes to proceed non-interactively."
    exit 1
  fi
  read -r -p "${question} ${DIM}[y/N]${RESET} " answer || answer=""
  case "$answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# Read one value from .env WITHOUT sourcing it. .env holds secrets and arbitrary
# text; sourcing it would execute whatever it contains.
env_value() {
  local name="$1" line value=""
  [ -f "$ENV_FILE" ] || { printf '%s' ""; return 0; }
  while IFS= read -r line; do
    value="${line#*=}"
  done < <(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$ENV_FILE" || true)
  value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  case "$value" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

compose_file_default_project() {
  # The project name Compose itself gives FILE when nobody passes -p: a
  # COMPOSE_PROJECT_NAME in .env, else the file's own top-level `name:`, else
  # the directory name lowercased with everything outside [a-z0-9_-] dropped.
  local file="$1" name
  name="$(env_value COMPOSE_PROJECT_NAME)"
  if [ -z "$name" ] && [ -f "$file" ]; then
    name="$(sed -n -E 's/^name:[[:space:]]*["'\'']?([A-Za-z0-9_.-]+).*$/\1/p' "$file")"
    name="${name%%$'\n'*}"
  fi
  if [ -z "$name" ]; then
    name="$(basename -- "$(dirname -- "$file")" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]//g')"
  fi
  printf '%s' "$name"
}

human_size() {
  local bytes="$1"
  if [ "$bytes" -ge 1073741824 ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.2f GiB", b / 1073741824 }'
  elif [ "$bytes" -ge 1048576 ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.2f MiB", b / 1048576 }'
  elif [ "$bytes" -ge 1024 ]; then
    awk -v b="$bytes" 'BEGIN { printf "%.2f KiB", b / 1024 }'
  else
    printf '%s B' "$bytes"
  fi
}

file_size() {
  # stat's flags differ between GNU and BSD; wc -c is the portable answer and is
  # exact for a regular file.
  wc -c < "$1" | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------
# 0. Remembered settings.
#
# A deploy is a statement about one host: this stack, under this project name,
# reached through this reverse-proxy network. Until this section existed that
# statement had to be retyped in full on every run, and whatever was left off
# fell back to a default. For the proxy network the default is the worst
# outcome available. A plain `./deploy.sh` after
# `./deploy.sh --proxy-network=npm_default` recreated the app container OFF the
# proxy network, so the site went dark behind the proxy, and WITH a host port
# published on APP_BIND_ADDRESS, which defaults to every interface. Measured on
# a real stack before this was written: the proxy answered 502 and the port
# answered 200. A forgotten -p or --single starts a second stack beside the
# first one instead.
#
# So the settings are written to a small file next to this script and read
# back here, before anything else is decided.
#
# Why its own file and not .env: .env holds the encryption key. Rewriting the
# one file whose corruption orphans every encrypted row, in order to store a
# network name, is the wrong trade, so the promise at the top of this script --
# .env is never created or modified -- still holds. The file is ignored by Git,
# so `git pull` leaves it alone and the content-based checkout guard in
# section 2 never sees it.
#
# It is PARSED, never sourced, and parsed strictly: an unknown key, a repeated
# key, a value outside its alphabet or a missing version all stop the deploy.
# A file that can only be half understood must not be half applied, because the
# half that went missing may be the proxy network.
# ---------------------------------------------------------------------------
title "Standard Red Notes - deploy"
if [ "$DRY_RUN" -eq 1 ]; then
  warn "DRY RUN: no command that changes anything will be executed."
fi

DEFAULT_PROXY_ALIAS="standard-red-notes-app"
GUARD_FILE="${REPO_ROOT}/docker-compose.override.yml"
GUARD_MARKER="# GENERATED by deploy.sh from .deploy-state. Do not edit: it is rewritten on every deploy."

# What the caller's own shell would hand a hand-typed `docker compose`. Kept
# apart from what this script exports further down, so that the bare-Compose
# check in sync_guard_file can reproduce that shell exactly.
INHERITED_PROJECT="${COMPOSE_PROJECT_NAME:-}"
INHERITED_PROXY_ALIAS="${SRN_PROXY_ALIAS:-}"
INHERITED_ENVIRONMENT=()
if [ -n "${COMPOSE_PROJECT_NAME+set}" ]; then
  INHERITED_ENVIRONMENT+=("COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}")
fi
if [ -n "${SRN_PROXY_NETWORK+set}" ]; then
  INHERITED_ENVIRONMENT+=("SRN_PROXY_NETWORK=${SRN_PROXY_NETWORK}")
fi
if [ -n "${SRN_PROXY_ALIAS+set}" ]; then
  INHERITED_ENVIRONMENT+=("SRN_PROXY_ALIAS=${SRN_PROXY_ALIAS}")
fi

absolute_path() {
  # absolute_path PATH -- without realpath, which stock macOS does not have.
  # A file whose directory does not exist is returned as given; the caller's
  # own existence check then reports it.
  local target="$1" directory
  case "$target" in
    /*|[A-Za-z]:[\\/]*) ;;
    *) target="${PWD}/${target}" ;;
  esac
  if directory="$(cd "$(dirname -- "$target")" 2>/dev/null && pwd)"; then
    printf '%s/%s' "${directory%/}" "$(basename -- "$target")"
  else
    printf '%s' "$target"
  fi
}

STATE_IS_DEFAULT=0
if [ "$(absolute_path "$STATE_FILE")" = "$(absolute_path "$DEFAULT_STATE_FILE")" ]; then
  STATE_IS_DEFAULT=1
fi

describe_stack() {
  # describe_stack TOPOLOGY COMPOSE_FILE PROJECT
  local text
  case "$1" in
    single) text="the all-in-one stack (docker-compose.single.yml)" ;;
    file) text="the stack in ${2}" ;;
    *) text="the multi-container stack (docker-compose.yml)" ;;
  esac
  if [ -n "$3" ]; then
    printf "%s, Compose project '%s'" "$text" "$3"
  else
    printf "%s, Compose's default project name" "$text"
  fi
}

describe_proxy() {
  # describe_proxy on|off NETWORK ALIAS yes|no
  if [ "$1" != "on" ]; then
    printf '%s' "no reverse-proxy network: the app publishes APP_PORT on the host"
  elif [ "$4" = "yes" ]; then
    printf "behind reverse-proxy network '%s' as '%s', plus a 127.0.0.1 host port" "$2" "$3"
  else
    printf "behind reverse-proxy network '%s' as '%s', no host port" "$2" "$3"
  fi
}

STATE_PRESENT=0
ST_VERSION=""
ST_TOPOLOGY=""
ST_COMPOSE_FILE=""
ST_PROJECT=""
ST_PROXY=""
ST_PROXY_NETWORK=""
ST_PROXY_ALIAS=""
ST_PUBLISH=""
ST_SAVED_AT=""

state_refuse() {
  # The saved settings cannot be trusted. Stop rather than deploy with part of
  # them: the part that is unreadable may be the proxy network, and a deploy
  # without it detaches the site and publishes a port.
  local line
  err "REFUSING to deploy: the remembered settings in ${STATE_FILE} cannot be used."
  for line in "$@"; do
    err "  ${line}"
  done
  err ""
  err "  Nothing has been changed. Either correct the file (it is plain key=value"
  err "  text), or delete it and re-run with the flags that describe this"
  err "  deployment, for example:"
  err "    ./deploy.sh --proxy-network=<your-proxy-network>"
  exit 1
}

load_state() {
  local line key value number=0 seen=" "
  [ -f "$STATE_FILE" ] || return 0
  STATE_PRESENT=1
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    # Tolerate a file saved by a Windows editor, and trailing blanks.
    line="${line%$'\r'}"
    while [ "${line% }" != "$line" ] || [ "${line%$'\t'}" != "$line" ]; do
      line="${line% }"
      line="${line%$'\t'}"
    done
    case "$line" in
      ""|"#"*) continue ;;
    esac
    if ! [[ "$line" =~ ^([a-z_]+)=(.*)$ ]]; then
      state_refuse "Line ${number} is not of the form key=value:" "  ${line}"
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case "$seen" in
      *" ${key} "*) state_refuse "Line ${number} sets '${key}' a second time. Which one is meant?" ;;
    esac
    seen="${seen}${key} "
    case "$key" in
      version) ST_VERSION="$value" ;;
      topology) ST_TOPOLOGY="$value" ;;
      compose_file) ST_COMPOSE_FILE="$value" ;;
      project) ST_PROJECT="$value" ;;
      proxy) ST_PROXY="$value" ;;
      proxy_network) ST_PROXY_NETWORK="$value" ;;
      proxy_alias) ST_PROXY_ALIAS="$value" ;;
      proxy_publish_ports) ST_PUBLISH="$value" ;;
      saved_at) ST_SAVED_AT="$value" ;;
      saved_revision) ;;
      *)
        state_refuse "Line ${number} sets '${key}', which this deploy.sh does not know." \
          "A newer deploy.sh may have written it; this one will not guess what it means."
        ;;
    esac
  done < "$STATE_FILE"

  if [ "$ST_VERSION" != "1" ]; then
    state_refuse "version is '${ST_VERSION:-missing}'; this deploy.sh reads version 1."
  fi
  case "$ST_TOPOLOGY" in
    multi|single)
      if [ -n "$ST_COMPOSE_FILE" ]; then
        state_refuse "topology=${ST_TOPOLOGY} but compose_file is set. compose_file belongs to topology=file."
      fi
      ;;
    file)
      case "$ST_COMPOSE_FILE" in
        "") state_refuse "topology=file needs compose_file to name the Compose file." ;;
        -*) state_refuse "compose_file='${ST_COMPOSE_FILE}' starts with a dash and would be read as an option." ;;
      esac
      ;;
    *) state_refuse "topology is '${ST_TOPOLOGY:-missing}'; it must be multi, single or file." ;;
  esac
  if [ -n "$ST_PROJECT" ] && ! valid_project_name "$ST_PROJECT"; then
    state_refuse "project='${ST_PROJECT}' is not a Compose project name."
  fi
  if ! [[ "$ST_SAVED_AT" =~ ^[0-9TZ:-]*$ ]]; then
    state_refuse "saved_at='${ST_SAVED_AT}' is not a timestamp."
  fi
  case "$ST_PROXY" in
    on)
      if ! valid_network_name "$ST_PROXY_NETWORK"; then
        state_refuse "proxy=on but proxy_network='${ST_PROXY_NETWORK}' is not a Docker network name."
      fi
      if ! valid_network_name "$ST_PROXY_ALIAS"; then
        state_refuse "proxy=on but proxy_alias='${ST_PROXY_ALIAS}' cannot be used as a network alias."
      fi
      case "$ST_PUBLISH" in
        yes|no) ;;
        *) state_refuse "proxy_publish_ports is '${ST_PUBLISH:-missing}'; it must be yes or no." ;;
      esac
      ;;
    off)
      # proxy=off beside a network name is what a hand edit that set the
      # network and forgot the switch looks like. Reading it as "no proxy"
      # would publish a port on the say-so of a file that names a proxy.
      if [ -n "$ST_PROXY_NETWORK" ]; then
        state_refuse "proxy=off but proxy_network='${ST_PROXY_NETWORK}' is set. Which one is meant?"
      fi
      ;;
    *) state_refuse "proxy is '${ST_PROXY:-missing}'; it must be on or off." ;;
  esac
}

load_state

title "Remembered settings"
if [ "$STATE_PRESENT" -eq 1 ]; then
  info "File:   ${STATE_FILE}${ST_SAVED_AT:+ (saved ${ST_SAVED_AT})}"
  ok "Loaded: $(describe_stack "$ST_TOPOLOGY" "$ST_COMPOSE_FILE" "$ST_PROJECT")"
  ok "        $(describe_proxy "$ST_PROXY" "$ST_PROXY_NETWORK" "$ST_PROXY_ALIAS" "$ST_PUBLISH")"
else
  info "File:   ${STATE_FILE} (does not exist: nothing is remembered yet)"
  info "  This run is decided by its command line alone."
fi

# --- Which deployment -------------------------------------------------------
# An inherited COMPOSE_PROJECT_NAME is an instruction too: Compose obeys it, so
# it names the deployment exactly as -p does, and is remembered the same way.
REQUESTED_PROJECT="$ARG_PROJECT"
REQUESTED_PROJECT_SAID="-p ${ARG_PROJECT}"
if [ -z "$REQUESTED_PROJECT" ] && [ -n "$INHERITED_PROJECT" ]; then
  REQUESTED_PROJECT="$INHERITED_PROJECT"
  REQUESTED_PROJECT_SAID="COMPOSE_PROJECT_NAME=${INHERITED_PROJECT} in the environment"
fi
if [ -n "$REQUESTED_PROJECT" ] && ! valid_project_name "$REQUESTED_PROJECT"; then
  err "${REQUESTED_PROJECT_SAID}: not a Compose project name."
  err "  Lowercase letters, digits, '-' and '_', starting with a letter or digit."
  exit 2
fi

saved_compose_file() {
  # The Compose file the remembered settings name. A relative compose_file is
  # relative to this script, so the checkout can be moved.
  case "$ST_TOPOLOGY" in
    single) printf '%s' "${REPO_ROOT}/docker-compose.single.yml" ;;
    file)
      case "$ST_COMPOSE_FILE" in
        /*|[A-Za-z]:[\\/]*) printf '%s' "$ST_COMPOSE_FILE" ;;
        *) printf '%s' "${REPO_ROOT}/${ST_COMPOSE_FILE}" ;;
      esac
      ;;
    *) printf '%s' "${REPO_ROOT}/docker-compose.yml" ;;
  esac
}

identity_refuse() {
  # identity_refuse WHAT-WAS-SAID -- --single, --file and -p do not configure a
  # deployment, they say which one. The remembered settings belong to exactly
  # one, and are never applied to another.
  err "REFUSING to deploy: $1 names a different deployment from the one"
  err "remembered in ${STATE_FILE}."
  err ""
  err "  Remembered: $(describe_stack "$ST_TOPOLOGY" "$ST_COMPOSE_FILE" "$ST_PROJECT")"
  err "              $(describe_proxy "$ST_PROXY" "$ST_PROXY_NETWORK" "$ST_PROXY_ALIAS" "$ST_PUBLISH")"
  err ""
  err "  Settings are remembered for ONE deployment and never carried over to"
  err "  another. Behind a proxy that would put a second app container on the"
  err "  same network under the same name, and the proxy would then split"
  err "  requests between two databases."
  err ""
  err "  Nothing has been changed. Pick one:"
  err "    Redeploy the remembered deployment:"
  err "      ./deploy.sh                 (leave that out)"
  err "    Deploy this one as well, remembered separately:"
  err "      ./deploy.sh <the same flags> --state-file ${STATE_FILE}.<name>"
  err "    Make this one the remembered deployment instead:"
  err "      delete ${STATE_FILE}, then run this command again"
  exit 2
}

TOPOLOGY="multi"
if [ "$STATE_PRESENT" -eq 1 ]; then
  TOPOLOGY="$ST_TOPOLOGY"
fi
if [ "$ARG_SINGLE" -eq 1 ]; then
  if [ "$STATE_PRESENT" -eq 1 ] && [ "$ST_TOPOLOGY" != "single" ]; then
    identity_refuse "--single"
  fi
  TOPOLOGY="single"
elif [ -n "$ARG_COMPOSE_FILE" ]; then
  if [ "$STATE_PRESENT" -eq 1 ]; then
    if [ "$ST_TOPOLOGY" != "file" ] || [ "$(absolute_path "$ARG_COMPOSE_FILE")" != "$(absolute_path "$(saved_compose_file)")" ]; then
      identity_refuse "--file ${ARG_COMPOSE_FILE}"
    fi
  fi
  TOPOLOGY="file"
fi

SINGLE=0
case "$TOPOLOGY" in
  single)
    SINGLE=1
    COMPOSE_FILE="${REPO_ROOT}/docker-compose.single.yml"
    ;;
  file)
    if [ -n "$ARG_COMPOSE_FILE" ]; then
      COMPOSE_FILE="$ARG_COMPOSE_FILE"
    else
      COMPOSE_FILE="$(saved_compose_file)"
    fi
    ;;
  *) COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml" ;;
esac

PROJECT_NAME="$REQUESTED_PROJECT"
if [ "$STATE_PRESENT" -eq 1 ]; then
  if [ -z "$REQUESTED_PROJECT" ]; then
    PROJECT_NAME="$ST_PROJECT"
  elif [ -n "$ST_PROJECT" ]; then
    if [ "$REQUESTED_PROJECT" != "$ST_PROJECT" ]; then
      identity_refuse "$REQUESTED_PROJECT_SAID"
    fi
  elif [ "$REQUESTED_PROJECT" != "$(compose_file_default_project "$COMPOSE_FILE")" ]; then
    # Nothing was remembered for the project, i.e. Compose's own default. Naming
    # that default out loud is the same deployment; naming anything else is not.
    identity_refuse "$REQUESTED_PROJECT_SAID"
  fi
fi

# --- How it is reached ------------------------------------------------------
# PROXY_ORIGIN records where the proxy decision came from: flag, saved, adopted
# (read off the running stack, section 1c), asked (the first-install question)
# or default (nobody has said anything, anywhere).
PROXY_MODE=0
PROXY_NETWORK=""
PROXY_NETWORK_REMEMBERED=0
PROXY_ALIAS="$DEFAULT_PROXY_ALIAS"
PUBLISH_PORTS=0
PROXY_ORIGIN="default"
if [ "$ARG_PROXY_OFF" -eq 1 ]; then
  PROXY_ORIGIN="flag"
elif [ "$ARG_PROXY_ON" -eq 1 ]; then
  PROXY_ORIGIN="flag"
  PROXY_MODE=1
  if [ -n "$ARG_PROXY_NETWORK" ]; then
    PROXY_NETWORK="$ARG_PROXY_NETWORK"
  elif [ "$ST_PROXY" = "on" ]; then
    PROXY_NETWORK="$ST_PROXY_NETWORK"
    PROXY_NETWORK_REMEMBERED=1
  else
    PROXY_NETWORK="proxy"
  fi
elif [ "$STATE_PRESENT" -eq 1 ]; then
  PROXY_ORIGIN="saved"
  if [ "$ST_PROXY" = "on" ]; then
    PROXY_MODE=1
    PROXY_NETWORK="$ST_PROXY_NETWORK"
    PROXY_NETWORK_REMEMBERED=1
  fi
fi

resolve_proxy_alias() {
  # resolve_proxy_alias REMEMBERED -- the first of: --proxy-alias, an inherited
  # SRN_PROXY_ALIAS, SRN_PROXY_ALIAS in .env (where Compose would read it too),
  # the remembered alias, the default. Everything above "remembered" is the
  # operator saying so now, and is announced as a change when it differs.
  local remembered="$1" from_env_file
  from_env_file="$(env_value SRN_PROXY_ALIAS)"
  if [ "$ARG_PROXY_ALIAS_GIVEN" -eq 1 ]; then
    PROXY_ALIAS="$ARG_PROXY_ALIAS"
  elif [ -n "$INHERITED_PROXY_ALIAS" ]; then
    PROXY_ALIAS="$INHERITED_PROXY_ALIAS"
  elif [ -n "$from_env_file" ]; then
    PROXY_ALIAS="$from_env_file"
  elif [ -n "$remembered" ]; then
    PROXY_ALIAS="$remembered"
  else
    PROXY_ALIAS="$DEFAULT_PROXY_ALIAS"
  fi
  if ! valid_network_name "$PROXY_ALIAS"; then
    err "The proxy alias '${PROXY_ALIAS}' (SRN_PROXY_ALIAS) cannot be used as a network alias."
    err "  An alias starts with a letter or digit and continues with letters, digits,"
    err "  '_', '.' or '-'."
    exit 2
  fi
}

resolve_publish_ports() {
  # resolve_publish_ports REMEMBERED(yes|no) -- a flag on this command line
  # wins; otherwise what was remembered.
  if [ "$ARG_PUBLISH_ON" -eq 1 ]; then
    PUBLISH_PORTS=1
  elif [ "$ARG_PUBLISH_OFF" -eq 1 ]; then
    PUBLISH_PORTS=0
  elif [ "$1" = "yes" ]; then
    PUBLISH_PORTS=1
  else
    PUBLISH_PORTS=0
  fi
}

if [ "$PROXY_MODE" -eq 1 ]; then
  resolve_proxy_alias "$ST_PROXY_ALIAS"
  resolve_publish_ports "$ST_PUBLISH"
else
  if [ "$CREATE_NETWORK" -eq 1 ]; then
    err "--create-network only means something with --proxy-network."
    exit 2
  fi
  if [ "$ARG_PUBLISH_ON" -eq 1 ]; then
    err "--publish-ports only means something with --proxy-network; without it the"
    err "  base Compose file already publishes APP_PORT."
    exit 2
  fi
  if [ "$ARG_PUBLISH_OFF" -eq 1 ] || [ "$ARG_PROXY_ALIAS_GIVEN" -eq 1 ]; then
    err "--no-publish-ports and --proxy-alias only mean something with --proxy-network."
    exit 2
  fi
fi

# Say what is about to change BEFORE anything is checked, pulled or built. Only
# a remembered deployment can change; with nothing remembered there is nothing
# to compare against.
CHANGE_COUNT=0
note_change() {
  local line
  CHANGE_COUNT=$((CHANGE_COUNT + 1))
  warn "CHANGE: $1"
  shift
  for line in "$@"; do
    warn "  ${line}"
  done
}
if [ "$STATE_PRESENT" -eq 1 ]; then
  if [ "$ST_PROXY" = "on" ] && [ "$PROXY_MODE" -eq 0 ]; then
    bind_address="$(env_value APP_BIND_ADDRESS)"
    note_change "leaving the reverse-proxy network '${ST_PROXY_NETWORK}' (--no-proxy)." \
      "The app container will be detached from it and will publish APP_PORT on" \
      "the host again, on APP_BIND_ADDRESS (${bind_address:-unset, which means 0.0.0.0: every interface})." \
      "Your proxy can no longer reach it by name."
  elif [ "$ST_PROXY" = "off" ] && [ "$PROXY_MODE" -eq 1 ]; then
    note_change "going behind the reverse-proxy network '${PROXY_NETWORK}'." \
      "The app container will join it as '${PROXY_ALIAS}' and stop publishing a host port."
  elif [ "$PROXY_MODE" -eq 1 ]; then
    if [ "$PROXY_NETWORK" != "$ST_PROXY_NETWORK" ]; then
      note_change "reverse-proxy network '${ST_PROXY_NETWORK}' -> '${PROXY_NETWORK}'." \
        "The app container will be MOVED: detached from '${ST_PROXY_NETWORK}' and attached" \
        "to '${PROXY_NETWORK}'. Your proxy has to be on '${PROXY_NETWORK}' to reach it."
    fi
    if [ "$PROXY_ALIAS" != "$ST_PROXY_ALIAS" ]; then
      note_change "proxy alias '${ST_PROXY_ALIAS}' -> '${PROXY_ALIAS}'." \
        "Your proxy's upstream has to become http://${PROXY_ALIAS}:8080."
    fi
    if [ "$PUBLISH_PORTS" -eq 1 ] && [ "$ST_PUBLISH" != "yes" ]; then
      note_change "also publishing APP_PORT on 127.0.0.1 (--publish-ports)."
    elif [ "$PUBLISH_PORTS" -eq 0 ] && [ "$ST_PUBLISH" = "yes" ]; then
      note_change "no longer publishing APP_PORT on 127.0.0.1 (--no-publish-ports)."
    fi
  fi
  if [ "$CHANGE_COUNT" -gt 0 ]; then
    info "Nothing has happened yet. The change is saved to ${STATE_FILE}"
    info "  when the deploy is confirmed, and is what a plain ./deploy.sh does from then on."
  else
    info "This run: as remembered."
  fi
fi

PROXY_PUBLISH_OVERLAY="${REPO_ROOT}/docker-compose.proxy-publish.yml"
if [ "$SINGLE" -eq 1 ]; then
  # docker-compose.single.yml is one `app` service on the project's default
  # network, with no `standard-red-notes` network to keep, so it has its own
  # overlay. The publish overlay only replaces `app`'s ports and fits both.
  PROXY_OVERLAY="${REPO_ROOT}/docker-compose.single.proxy.yml"
else
  PROXY_OVERLAY="${REPO_ROOT}/docker-compose.proxy.yml"
fi

apply_proxy_settings() {
  # Called again from section 1c when the proxy decision is only made there.
  COMPOSE_FILE_ARGS=(-f "$COMPOSE_FILE")
  if [ "$PROXY_MODE" -eq 1 ]; then
    COMPOSE_FILE_ARGS+=(-f "$PROXY_OVERLAY")
    if [ "$PUBLISH_PORTS" -eq 1 ]; then
      COMPOSE_FILE_ARGS+=(-f "$PROXY_PUBLISH_OVERLAY")
    fi
    # Exported, not passed: every compose invocation below, including the
    # read-only ones, must interpolate the overlay with the same two names.
    export SRN_PROXY_NETWORK="$PROXY_NETWORK"
    export SRN_PROXY_ALIAS="$PROXY_ALIAS"
  fi
}
apply_proxy_settings

# --- Writing it down --------------------------------------------------------
render_state() {
  local proxy="off" network="" alias="" publish="no" stored_file="" absolute
  if [ "$PROXY_MODE" -eq 1 ]; then
    proxy="on"
    network="$PROXY_NETWORK"
    alias="$PROXY_ALIAS"
    if [ "$PUBLISH_PORTS" -eq 1 ]; then
      publish="yes"
    fi
  fi
  if [ "$TOPOLOGY" = "file" ]; then
    absolute="$(absolute_path "$COMPOSE_FILE")"
    case "$absolute" in
      "${REPO_ROOT}/"*) stored_file="${absolute#"${REPO_ROOT}/"}" ;;
      *) stored_file="$absolute" ;;
    esac
  fi
  cat <<EOF
# Standard Red Notes - what ./deploy.sh remembers about this deployment.
#
# Written by ./deploy.sh just before it starts the stack, and read back at the
# top of every later run, so that a plain ./deploy.sh redeploys the same way.
# There are no secrets in here; those live in .env, which deploy.sh never
# writes. Git ignores this file, so it survives git pull.
#
# Plain key=value, parsed strictly and never executed: a line deploy.sh does
# not understand stops the deploy instead of being guessed at. Prefer the flags
# (./deploy.sh --help) to editing by hand. Deleting this file forgets what is
# in it; it is not how to leave a proxy network (that is --no-proxy).
version=1

# Which stack: multi (docker-compose.yml), single (docker-compose.single.yml)
# or file (compose_file, given with --file; relative to deploy.sh).
topology=${TOPOLOGY}
compose_file=${stored_file}

# Compose project name from -p / COMPOSE_PROJECT_NAME. Empty = Compose's default.
project=${PROJECT_NAME}

# Reverse proxy. on = the app container joins proxy_network, an existing
# external Docker network, answers there as proxy_alias, and publishes no host
# port. Leave it with ./deploy.sh --no-proxy, never by deleting these lines.
proxy=${proxy}
proxy_network=${network}
proxy_alias=${alias}
# yes = also publish APP_PORT on 127.0.0.1 (--publish-ports).
proxy_publish_ports=${publish}

saved_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
saved_revision=${REVISION:-}
EOF
}

guard_is_ours() {
  local first=""
  [ -f "$GUARD_FILE" ] || return 1
  IFS= read -r first < "$GUARD_FILE" || true
  [ "${first%$'\r'}" = "$GUARD_MARKER" ]
}

render_guard() {
  printf '%s\n' "$GUARD_MARKER"
  cat <<'EOF'
#
# Compose loads docker-compose.override.yml by itself whenever it is run in
# this directory without -f. This copy of what .deploy-state remembers is what
# makes a hand-typed `docker compose up -d` act on the same deployment as
# ./deploy.sh does - the same Compose project, on the same reverse-proxy
# network - instead of quietly starting a second stack, or recreating the app
# container off that network with a host port published.
#
# Change these settings with ./deploy.sh (see --help), never here. Git ignores
# this file. deploy.sh removes it again when nothing remembered needs it.
EOF
  if [ -n "$PROJECT_NAME" ]; then
    printf 'name: "%s"\n' "$PROJECT_NAME"
  fi
  if [ "$PROXY_MODE" -eq 1 ]; then
    printf 'services:\n  app:\n    networks:\n      standard-red-notes: {}\n      proxy:\n        aliases:\n          - "%s"\n' "$PROXY_ALIAS"
    if [ "$PUBLISH_PORTS" -eq 1 ]; then
      # shellcheck disable=SC2016  # Deliberate: Compose interpolates APP_PORT,
      # exactly as it does in docker-compose.proxy-publish.yml.
      printf '    ports: !override\n      - "127.0.0.1:${APP_PORT:-3001}:8080"\n'
    else
      printf '    ports: !reset []\n'
    fi
    printf 'networks:\n  proxy:\n    name: "%s"\n    external: true\n' "$PROXY_NETWORK"
  fi
}

guard_matches_deploy() {
  # The generated file repeats what the tracked overlays say, and two copies
  # drift. So it is not trusted: ask Compose to render what this script deploys
  # and what a bare `docker compose` in this directory would deploy, in the
  # caller's own environment, and compare the two. Checksums, not files, since
  # a rendered configuration contains every secret in .env.
  local deployed bare
  deployed="$(compose_query config 2>/dev/null | cksum)" || return 1
  bare="$(cd "$REPO_ROOT" && env -u COMPOSE_PROJECT_NAME -u SRN_PROXY_NETWORK -u SRN_PROXY_ALIAS \
    ${INHERITED_ENVIRONMENT[@]+"${INHERITED_ENVIRONMENT[@]}"} "${COMPOSE[@]}" config 2>/dev/null | cksum)" || return 1
  [ "$deployed" = "$bare" ]
}

# What a hand-typed `docker compose up -d` in this directory would do, for the
# closing summary: guarded (it deploys the remembered settings), unguarded (it
# would not), or irrelevant (nothing remembered differs from the defaults).
BARE_COMPOSE="irrelevant"
sync_guard_file() {
  local wanted=0 temporary
  if [ "$STATE_IS_DEFAULT" -eq 0 ]; then
    # A second deployment kept in its own state file. A bare `docker compose`
    # in this directory can only ever mean one deployment, and it is the one in
    # .deploy-state.
    if [ "$PROXY_MODE" -eq 1 ] || [ -n "$PROJECT_NAME" ] || [ "$TOPOLOGY" != "multi" ]; then
      BARE_COMPOSE="unguarded"
    fi
    return 0
  fi
  if [ "$TOPOLOGY" = "multi" ]; then
    if [ "$PROXY_MODE" -eq 1 ] || [ -n "$PROJECT_NAME" ]; then
      wanted=1
    fi
  else
    # Compose only auto-loads an override beside docker-compose.yml, so there
    # is nothing to generate for --single or --file. Their settings are safe
    # only through this script, and the summary says so.
    BARE_COMPOSE="unguarded"
  fi

  if [ -f "$GUARD_FILE" ] && ! guard_is_ours; then
    if [ "$wanted" -eq 1 ]; then
      BARE_COMPOSE="unguarded"
      warn "${GUARD_FILE} exists and was not generated by this script, so it is left alone."
      warn "  A hand-typed 'docker compose up -d' here is therefore NOT known to"
      warn "  deploy the remembered settings. Use ./deploy.sh."
    fi
    return 0
  fi

  if [ "$wanted" -eq 0 ]; then
    if guard_is_ours; then
      run rm -f -- "$GUARD_FILE"
      info "  The remembered settings no longer need it: a bare 'docker compose' is right again."
    fi
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s %s\n' "${DIM}would write:${RESET}" "$GUARD_FILE"
    render_guard | sed -e '/^#/d' -e 's/^/    /'
    return 0
  fi

  printf '%s %s\n' "${DIM}+${RESET}" "write ${GUARD_FILE}"
  temporary="${GUARD_FILE}.tmp.$$"
  if ! render_guard >"$temporary" || ! mv -f -- "$temporary" "$GUARD_FILE"; then
    rm -f -- "$temporary"
    BARE_COMPOSE="unguarded"
    warn "Could not write ${GUARD_FILE}; a hand-typed 'docker compose up -d' is not covered."
    return 0
  fi
  if guard_matches_deploy; then
    BARE_COMPOSE="guarded"
    ok "A hand-typed 'docker compose up -d' in ${REPO_ROOT} now deploys this too."
    info "  Checked, not assumed: Compose renders it identically to what this script deploys."
  else
    # Kept only when proven. A guard file that renders something else, or does
    # not render, would be worse than none: it is loaded by every bare command.
    rm -f -- "$GUARD_FILE"
    BARE_COMPOSE="unguarded"
    warn "A bare 'docker compose' here does NOT render what this script deploys, so the"
    warn "  generated ${GUARD_FILE} was removed again."
    warn "  The usual cause is COMPOSE_FILE set in .env or in the shell, which makes"
    warn "  Compose skip the override file. Use ./deploy.sh to start or restart the stack."
  fi
}

SETTINGS_SAVED=0
remember_settings() {
  local temporary
  # Nothing remembered before, and nothing but defaults now: leave no file
  # behind, so a deployment that never used a flag behaves exactly as it did.
  if [ "$STATE_PRESENT" -eq 0 ] && [ "$TOPOLOGY" = "multi" ] && [ -z "$PROJECT_NAME" ] \
      && [ "$PROXY_MODE" -eq 0 ] && [ "$PROXY_ORIGIN" = "default" ]; then
    if [ "$STATE_IS_DEFAULT" -eq 1 ] && guard_is_ours; then
      # An override this script generated from settings that have since been
      # deleted. Left in place it would send a bare `docker compose up -d`
      # somewhere this script no longer deploys to.
      run rm -f -- "$GUARD_FILE"
      info "  It was generated from settings that are no longer remembered."
    fi
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s %s\n' "${DIM}would write:${RESET}" "$STATE_FILE"
    render_state | sed -e '/^#/d' -e '/^$/d' -e 's/^/    /'
  else
    printf '%s %s\n' "${DIM}+${RESET}" "write ${STATE_FILE}"
    temporary="${STATE_FILE}.tmp.$$"
    if ! render_state >"$temporary" || ! mv -f -- "$temporary" "$STATE_FILE"; then
      rm -f -- "$temporary"
      err "Could not write ${STATE_FILE}."
      err "  Stopping before anything is built or restarted: a deploy that cannot be"
      err "  remembered is undone by the next plain ./deploy.sh."
      exit 1
    fi
    SETTINGS_SAVED=1
    ok "Saved: $(describe_stack "$TOPOLOGY" "$COMPOSE_FILE" "$PROJECT_NAME")"
    if [ "$PROXY_MODE" -eq 1 ]; then
      if [ "$PUBLISH_PORTS" -eq 1 ]; then
        ok "       $(describe_proxy on "$PROXY_NETWORK" "$PROXY_ALIAS" yes)"
      else
        ok "       $(describe_proxy on "$PROXY_NETWORK" "$PROXY_ALIAS" no)"
      fi
    else
      ok "       $(describe_proxy off "" "" no)"
    fi
    info "  A plain ./deploy.sh redeploys exactly this from now on."
  fi
  sync_guard_file
}

# ---------------------------------------------------------------------------
# 1. Preflight. Nothing below this point has touched the deployment yet.
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  err "Git is not installed or not on PATH."
  exit 1
fi
if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "${REPO_ROOT} is not a Git working tree."
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  err "Docker is not installed or not on PATH."
  err "Install Docker Desktop (macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/"
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  err "Docker Compose v2 is not available. Update Docker Desktop, or install the compose plugin."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "The Docker daemon is not responding to 'docker info'."
  err "Start Docker (e.g. 'sudo systemctl start docker') and try again."
  exit 1
fi
ok "Found Git, Docker, and Compose (${COMPOSE[*]})."

if [ ! -f "$COMPOSE_FILE" ]; then
  err "Compose file not found: ${COMPOSE_FILE}"
  exit 1
fi
ok "Using Compose file ${COMPOSE_FILE}"
check_overlays_exist() {
  # Called again from section 1c when the proxy decision is only made there.
  local overlay
  [ "$PROXY_MODE" -eq 1 ] || return 0
  for overlay in "$PROXY_OVERLAY" "$PROXY_PUBLISH_OVERLAY"; do
    case " ${COMPOSE_FILE_ARGS[*]} " in
      *" ${overlay} "*)
        if [ ! -f "$overlay" ]; then
          err "Proxy overlay not found: ${overlay}"
          exit 1
        fi
        ok "Overlay ${overlay}"
        ;;
    esac
  done
}
check_overlays_exist

if [ -n "$PROJECT_NAME" ]; then
  export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
  info "Compose project name: ${COMPOSE_PROJECT_NAME}"
fi

CONFIG_LOG="$(mktemp)"
CLEANUP_FILES=("$CONFIG_LOG")
cleanup() {
  local path
  for path in "${CLEANUP_FILES[@]}"; do
    [ -n "$path" ] && [ -f "$path" ] && rm -f -- "$path"
  done
}
trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

# `config --quiet` parses the file and resolves every interpolation. Output goes
# to a file, never a pipe: a pipeline's exit status belongs to the last command,
# so `config | tail` reports tail's success over a parse failure.
#
# This is a function because interpolation needs .env, so on the setup path it
# cannot run until scripts/setup.sh has written one. On the update path it still
# runs before anything is pulled or built.
validate_compose_configuration() {
  if ! compose_query config --quiet >"$CONFIG_LOG" 2>&1; then
    err "'$(compose_display)' configuration failed to parse:"
    cat "$CONFIG_LOG" >&2
    return 1
  fi
  ok "Compose configuration parses."
}

# ---------------------------------------------------------------------------
# Operator settings that silently destroy work rather than failing loudly.
# These are warnings, never blockers: a notes-only deployment is a legitimate
# choice. They are printed BEFORE the build so they are still on screen when
# the deploy finishes.
# ---------------------------------------------------------------------------
WARNING_COUNT=0
note_warning() {
  WARNING_COUNT=$((WARNING_COUNT + 1))
  warn "$1"
  shift
  local line
  for line in "$@"; do
    warn "  ${line}"
  done
}

report_configuration_warnings() {
  local smtp_host smtp_from email_confirmation insecure_defaults mail_configured
  smtp_host="$(env_value SMTP_HOST)"
  smtp_from="$(env_value SMTP_FROM)"
  email_confirmation="$(env_value REGISTRATION_EMAIL_CONFIRMATION)"
  insecure_defaults="$(env_value ALLOW_INSECURE_DEFAULTS)"
  mail_configured=1
  if [ -z "$smtp_host" ] || [ -z "$smtp_from" ]; then
    mail_configured=0
  fi

  title "Configuration warnings"
  if [ "$mail_configured" -eq 0 ]; then
    note_warning "SMTP_HOST and/or SMTP_FROM are unset in .env." \
      "Every email this deployment produces -- collaboration invites, email" \
      "backups, confirmations, password-change notices -- is DESTROYED rather" \
      "than queued for later. There is no retry once mail is configured."
  fi
  if [ "$email_confirmation" = "true" ] && [ "$mail_configured" -eq 0 ]; then
    note_warning "REGISTRATION_EMAIL_CONFIRMATION=true with no mail relay configured." \
      "New accounts can never receive their confirmation mail, so they stay" \
      "unconfirmed and are refused with 403 permanently. Either configure" \
      "SMTP_HOST/SMTP_FROM or set REGISTRATION_EMAIL_CONFIRMATION=false."
  fi
  if [ "$insecure_defaults" = "true" ]; then
    note_warning "ALLOW_INSECURE_DEFAULTS=true in .env." \
      "The stack will boot with PUBLISHED default signing/encryption secrets." \
      "Safe only for a throwaway local instance that is not reachable from" \
      "the internet. Never for a real deployment."
  fi

  if [ "$PROXY_MODE" -eq 1 ]; then
    report_proxy_warnings
  fi

  if [ "$WARNING_COUNT" -eq 0 ]; then
    ok "No known-destructive configuration gaps found in .env."
  else
    warn "${WARNING_COUNT} warning(s). These do not block the deploy."
  fi
}

# Behind a proxy, every one of these is wrong in a way that looks fine: the
# stack boots, the health check passes, and links, logins, file downloads or
# per-IP limits are quietly broken. Warnings only -- .env is never rewritten.
report_proxy_warnings() {
  local public_url files_url enforce_https bind_address trust_proxy cookie_secure

  public_url="$(env_value PUBLIC_URL)"
  files_url="$(env_value PUBLIC_FILES_SERVER_URL)"
  enforce_https="$(env_value ENFORCE_HTTPS_FROM_PROXY)"
  bind_address="$(env_value APP_BIND_ADDRESS)"
  trust_proxy="$(env_value TRUST_PROXY)"
  cookie_secure="$(env_value COOKIE_SECURE)"

  if [ -z "$public_url" ]; then
    note_warning "PUBLIC_URL is unset in .env." \
      "The gateway uses this CONFIGURED origin, never the request Host, to" \
      "build links, the pairing callback and the websocket origin allowlist." \
      "Behind a proxy it must be the externally reachable origin, e.g." \
      "https://notes.example.com."
  else
    case "$public_url" in
      *localhost*|*127.0.0.1*)
        note_warning "PUBLIC_URL is still a loopback address: ${public_url}" \
          "Behind a proxy this is the one value nothing can correct for you." \
          "Links, redirects and the websocket origin allowlist will all point" \
          "at the container instead of your domain."
        ;;
    esac
  fi

  if [ -z "$files_url" ]; then
    note_warning "PUBLIC_FILES_SERVER_URL is unset in .env." \
      "Compose then defaults it to http://localhost:\${APP_PORT}/files, which" \
      "no browser outside this host can reach. Set it to your public origin" \
      "plus /files."
  else
    case "$files_url" in
      *localhost*|*127.0.0.1*)
        note_warning "PUBLIC_FILES_SERVER_URL is still a loopback address: ${files_url}" \
          "Clients are told to fetch and upload attachments there, so every" \
          "file operation from outside this host fails."
        ;;
    esac
  fi

  # ENFORCE_HTTPS_FROM_PROXY is not advisory: app/docker/docker-entrypoint.sh
  # refuses to start without a pathless https PUBLIC_URL and a loopback bind.
  # Warn rather than block, because the verification stage below will catch the
  # container failing to come up -- but say plainly that it is fatal.
  if [ "$enforce_https" = "true" ]; then
    case "$public_url" in
      https://*) ;;
      *)
        note_warning "ENFORCE_HTTPS_FROM_PROXY=true with a non-HTTPS PUBLIC_URL (${public_url:-unset})." \
          "The app entrypoint REFUSES TO START without a pathless https" \
          "PUBLIC_URL. The container will not come up."
        ;;
    esac
    if [ -n "$bind_address" ] && [ "$bind_address" != "127.0.0.1" ]; then
      note_warning "ENFORCE_HTTPS_FROM_PROXY=true with APP_BIND_ADDRESS=${bind_address}." \
        "The app entrypoint requires 127.0.0.1 and will REFUSE TO START." \
        "Keep that declaration even with no ports mapping at all -- it is the" \
        "trusted-mode safety gate, not just a publish address."
    fi
  else
    case "$public_url" in
      https://*)
        note_warning "PUBLIC_URL is HTTPS but ENFORCE_HTTPS_FROM_PROXY is not true." \
          "Forwarded headers are then ignored, so the server treats every" \
          "request as plain HTTP from the proxy: no HSTS, no http->https" \
          "redirect, and req.secure stays false behind your TLS."
        ;;
    esac
  fi

  case "$public_url" in
    https://*)
      if [ "$cookie_secure" != "true" ]; then
        note_warning "PUBLIC_URL is HTTPS but COOKIE_SECURE is not true." \
          "The browser may drop the auth cookie on an HTTPS origin, and then" \
          "every request 401s with nothing in the logs to explain it."
      fi
      ;;
  esac

  # TRUST_PROXY: the risk is req.ip becoming the PROXY for every request, which
  # collapses per-IP rate limits, IP allow/block lists and session IPs onto one
  # address. This project has already shipped a caller-controlled x-origin-ip
  # that made per-IP limits spoofable, so the stakes are known.
  #
  # UNSET IS CORRECT HERE and is deliberately not warned about: docker-compose.yml
  # applies `loopback, linklocal, uniquelocal`, which already trusts a proxy
  # arriving over a private Docker network -- exactly this case. Warning on it
  # would send operators to "fix" a correct configuration.
  #
  # A bare hop count and `true` are documented, deliberate settings. An explicit
  # address list is the one that can silently miss, so it is checked against the
  # proxy network's REAL subnet rather than guessed at.
  if [ -n "$trust_proxy" ]; then
    local trust_covered=0 proxy_subnets subnet subnet_prefix
    case "$trust_proxy" in
      false|0)
        note_warning "TRUST_PROXY=${trust_proxy} disables forwarded-header trust." \
          "Behind a proxy that makes req.ip the PROXY for every request, so" \
          "per-IP rate limits, IP allow/block lists and session IPs all collapse" \
          "onto one address. Leave TRUST_PROXY unset to use the compose default."
        trust_covered=1
        ;;
      true|*uniquelocal*|*loopback*|*linklocal*)
        trust_covered=1
        ;;
    esac
    # ^[0-9]+$ only. A glob like *[0-9] matches anything ENDING in a digit,
    # which silently accepted every IPv4 address as a hop count.
    if [ "$trust_covered" -eq 0 ] && [[ "$trust_proxy" =~ ^[0-9]+$ ]]; then
      trust_covered=1
    fi
    if [ "$trust_covered" -eq 0 ]; then
      proxy_subnets="$(docker network inspect "$PROXY_NETWORK" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
      for subnet in $proxy_subnets; do
        # Compare on the first two octets: enough to tell "names this network"
        # from "names something else entirely", without doing CIDR arithmetic in
        # shell. The message below carries the real subnet either way.
        subnet_prefix="$(printf '%s' "$subnet" | cut -d. -f1-2)."
        case "$trust_proxy" in
          *"$subnet_prefix"*) trust_covered=1 ;;
        esac
      done
      if [ "$trust_covered" -eq 0 ]; then
        note_warning "TRUST_PROXY=${trust_proxy} may not cover the proxy network." \
          "The proxy reaches the app over '${PROXY_NETWORK}' (subnet:${proxy_subnets:- unknown})," \
          "and nothing in that value names it. If the proxy's address is not" \
          "trusted, req.ip is the PROXY for every request. Leave TRUST_PROXY" \
          "unset to use the compose default (loopback, linklocal, uniquelocal)," \
          "which already covers a proxy on a private Docker network."
      fi
    fi
  fi

  warn "Reverse-proxy reminder: ENABLE WEBSOCKET SUPPORT on the proxy host entry."
  warn "  Realtime sync opens wss://<host>/sockets and /sockets/sync. Without the"
  warn "  Upgrade and Connection headers passed through, those fail while every"
  warn "  HTTP check stays green -- the stack looks perfectly healthy and"
  warn "  realtime silently does not work."
}

# ---------------------------------------------------------------------------
# 1b. Which mode is this?
#
# The signal is .env. It is the single artifact scripts/setup.sh produces, the
# one thing the stack cannot start without, and the only piece of state whose
# absence genuinely means "nothing has been installed here yet". Container and
# volume existence is NOT the signal -- a stopped stack, a pruned host and a
# fresh clone of an existing deployment all have no containers while being very
# much installed.
#
# But .env missing while this project still owns containers or volumes is not a
# first install, it is a deployment whose .env was lost. Generating a new one
# there would mint a new AUTH_SERVER_ENCRYPTION_SERVER_KEY and orphan every
# encrypted row behind it, so that combination is refused rather than guessed.
# ---------------------------------------------------------------------------
# Variables the chosen Compose files declare as REQUIRED, i.e. ${NAME:?...}.
# Compose fails to render without them, so their absence is the difference
# between "configured" and "a file called .env exists".
required_compose_variables() {
  local file
  for file in "${COMPOSE_FILE_ARGS[@]}"; do
    [ "$file" = "-f" ] && continue
    [ -f "$file" ] || continue
    grep -oE '[$][{][A-Za-z_][A-Za-z0-9_]*:[?][^}]*[}]' "$file" 2>/dev/null || true
  done | sed -E 's/[$][{]([A-Za-z_][A-Za-z0-9_]*):[?].*/\1/' | sort -u
}

missing_required_variables() {
  local name value
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    value="$(env_value "$name")"
    if [ -z "$value" ]; then
      # Compose honours the process environment too, so an exported value is a
      # legitimate way to supply one of these.
      value="${!name:-}"
    fi
    [ -n "$value" ] || printf '%s\n' "$name"
  done < <(required_compose_variables)
}

derive_project_name() {
  # The project name Compose will use. Containers are checked authoritatively
  # with `compose ps -a -q`, but that cannot render the file while .env is
  # missing, so this derivation is what finds a lost deployment's volumes.
  #
  # It has to follow Compose's own rule, not the directory name alone. Both
  # Compose files in this repository declare a top-level `name:` and Compose
  # prefers that, so a derivation from the directory looked for the volumes
  # under the wrong project in every checkout not itself called
  # standard-red-notes, found none, and let a deployment whose .env was lost
  # through as a first install.
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  compose_file_default_project "$COMPOSE_FILE"
}

existing_project_containers() {
  compose_query ps -a -q 2>/dev/null || true
}

existing_project_volumes() {
  local project
  project="$(derive_project_name)"
  [ -n "$project" ] || return 0
  docker volume ls -q --filter "label=com.docker.compose.project=${project}" 2>/dev/null || true
}

title "Mode"
# Read the evidence once and report THAT, rather than a sentence derived from
# the mode. With --setup or --update the mode is an instruction, not a finding,
# and "detected from: .env exists" printed next to a missing .env is a claim
# nothing checked.
if [ -f "$ENV_FILE" ]; then
  ENV_PRESENT=1
  ENV_EVIDENCE=".env exists at ${ENV_FILE}"
else
  ENV_PRESENT=0
  ENV_EVIDENCE="no .env at ${ENV_FILE}"
fi

# The all-in-one container generates and persists its own secrets to the
# single-data volume on first boot, so there is nothing for scripts/setup.sh to
# generate and docker-compose.single.yml declares no required variables. There
# is no "first install" step to perform on this topology, and running setup
# would write a 400-line multi-container .env that it does not read.
MISSING_REQUIRED=""
if [ "$SINGLE" -eq 1 ]; then
  if [ "$FORCE_MODE" = "setup" ]; then
    err "--setup does not apply to the all-in-one topology."
    err "  The container generates and persists its own secrets to the"
    err "  single-data volume on first boot, so there is nothing to generate."
    err "  Customise it with .env.single.example if you want to, then re-run"
    err "  without --setup."
    exit 2
  fi
  MODE="update"
  ENV_EVIDENCE="all-in-one topology: secrets are generated inside the container, no .env required"
else
  if [ "$ENV_PRESENT" -eq 1 ]; then
    MISSING_REQUIRED="$(missing_required_variables)"
  fi
  if [ -n "$FORCE_MODE" ]; then
    MODE="$FORCE_MODE"
  elif [ "$ENV_PRESENT" -eq 0 ]; then
    MODE="setup"
  elif [ -n "$MISSING_REQUIRED" ]; then
    MODE="unconfigured"
  else
    MODE="update"
  fi
  if [ "$ENV_PRESENT" -eq 1 ]; then
    # Report the denominator. "every required variable is set" is also true of a
    # Compose file that requires none, and a satisfied check over an empty list
    # is not evidence of anything.
    REQUIRED_COUNT="$(required_compose_variables | grep -c . || true)"
    if [ -n "$MISSING_REQUIRED" ]; then
      ENV_EVIDENCE="${ENV_EVIDENCE}, but it is missing required variables"
    elif [ "${REQUIRED_COUNT:-0}" -eq 0 ]; then
      ENV_EVIDENCE="${ENV_EVIDENCE}; this Compose file declares no required variables"
    else
      ENV_EVIDENCE="${ENV_EVIDENCE}, with all ${REQUIRED_COUNT} required variables set"
    fi
  fi
fi

case "$MODE" in
  setup) ok "SETUP (first install): generate .env, then build, start and verify." ;;
  update) ok "UPDATE: pull, back up, rebuild, restart and verify." ;;
  unconfigured) err "NOT CONFIGURED: .env exists but cannot render the Compose file." ;;
esac
if [ -n "$FORCE_MODE" ]; then
  info "  Forced with --${FORCE_MODE}; evidence on disk: ${ENV_EVIDENCE}"
else
  info "  Detected from: ${ENV_EVIDENCE}"
fi

# An .env that is missing required variables is neither a first install nor a
# working deployment, and both of the obvious guesses are wrong:
#
#   - Routing to update fails later at `compose config` with one variable named
#     at a time, which is where this script used to end up on exactly this repo.
#   - Routing to setup cannot help either. scripts/setup.sh on an existing .env
#     backfills only two specific per-install secrets and then runs
#     `compose config`, so on a stub it exits 1 and leaves .env untouched
#     (verified). The only thing that would rewrite it is --force-overwrite,
#     which rotates the encryption server key and orphans every encrypted row.
#
# So: name every missing variable at once, and say which remedy is safe here
# based on whether this project still owns any state.
if [ -n "$MISSING_REQUIRED" ]; then
  err ""
  err "  Missing or empty in ${ENV_FILE}:"
  while IFS= read -r missing_name; do
    [ -n "$missing_name" ] && err "    ${missing_name}"
  done <<< "$MISSING_REQUIRED"
  err ""
  err "  Note that ./scripts/setup.sh will NOT fix this: on an existing .env it"
  err "  only backfills two per-install secrets and then validates, so it exits"
  err "  on the same missing variables. Only --force-overwrite rewrites .env,"
  err "  and that rotates AUTH_SERVER_ENCRYPTION_SERVER_KEY and orphans all"
  err "  existing encrypted data, so this script never suggests it."
  err ""
  UNCONFIGURED_CONTAINERS="$(existing_project_containers)"
  UNCONFIGURED_VOLUMES="$(existing_project_volumes)"
  if [ -n "$UNCONFIGURED_CONTAINERS" ] || [ -n "$UNCONFIGURED_VOLUMES" ]; then
    err "  This project still owns containers or volumes, so there IS data behind"
    err "  this deployment. Add the missing variables to .env with the values"
    err "  that deployment was created with -- taken from your backup of .env,"
    err "  not newly generated. A new MYSQL_PASSWORD will not open the existing"
    err "  database, and a new encryption key will not decrypt existing rows."
  else
    err "  This project owns no containers and no volumes, so there is no data"
    err "  behind this .env. If it is a leftover stub, move it aside and let this"
    err "  script generate a complete one:"
    err "    mv .env .env.stub-backup && ./deploy.sh"
    err "  Keep the copy until you are sure nothing needed it."
  fi
  err ""
  err "  Either way this script will not guess, and has changed nothing."
  exit 1
fi

# Not the all-in-one topology: it has no setup step and reads no .env (see
# above), so a missing one there is the normal case, not a missing
# prerequisite. Without this exception `./deploy.sh --single` on a fresh host
# stopped here, one line after announcing "no .env required".
if [ "$MODE" = "update" ] && [ "$ENV_PRESENT" -eq 0 ] && [ "$SINGLE" -eq 0 ]; then
  err "--update was requested but there is no .env at ${ENV_FILE}."
  err "  Run this script without --update (or with --setup) to generate one."
  exit 1
fi

if [ "$MODE" = "setup" ] && [ "$ENV_PRESENT" -eq 1 ]; then
  # The loud refusal. scripts/setup.sh has a --force-overwrite that rewrites an
  # existing .env, and this script will NEVER reach for it: that flag
  # regenerates AUTH_SERVER_ENCRYPTION_SERVER_KEY unconditionally, and every
  # note, file and setting already encrypted under the old key becomes
  # unreadable with no way back. A deploy script must not be able to do that.
  err "REFUSING to run the setup path: .env already exists at ${ENV_FILE}."
  err ""
  err "  Setup generates fresh secrets. Replacing the existing"
  err "  AUTH_SERVER_ENCRYPTION_SERVER_KEY would ORPHAN every encrypted row"
  err "  already in this deployment -- notes, files and settings become"
  err "  permanently unreadable, and no rebuild or restore of the database"
  err "  brings them back without the original key."
  err ""
  err "  This script never passes --force-overwrite to scripts/setup.sh, and"
  err "  will not overwrite .env itself."
  err ""
  err "  To update this deployment instead:   ./deploy.sh --update"
  err "  To add only a missing assistant key: ./scripts/setup.sh --generate-assistant-subscription-key"
  exit 1
fi

if [ "$MODE" = "setup" ]; then
  LOST_ENV_CONTAINERS="$(existing_project_containers)"
  LOST_ENV_VOLUMES="$(existing_project_volumes)"
  if [ -n "$LOST_ENV_CONTAINERS" ] || [ -n "$LOST_ENV_VOLUMES" ]; then
    err "REFUSING to treat this as a first install."
    err ""
    err "  There is no .env, but this Compose project still owns:"
    if [ -n "$LOST_ENV_CONTAINERS" ]; then
      err "    containers: $(printf '%s' "$LOST_ENV_CONTAINERS" | tr '\n' ' ')"
    fi
    if [ -n "$LOST_ENV_VOLUMES" ]; then
      err "    volumes:    $(printf '%s' "$LOST_ENV_VOLUMES" | tr '\n' ' ')"
    fi
    err ""
    err "  That is a deployment whose .env was lost, not a new one. Generating"
    err "  fresh secrets would orphan the encrypted data in those volumes."
    err "  Restore .env from your backup first; see docs/backups-and-recovery.md."
    err "  Recover a complete prior environment with: npm run recover:database"
    exit 1
  fi
fi

if { [ "$WEB_ONLY" -eq 1 ] || [ "$ROLLING_WEB" -eq 1 ]; } && { [ "$MODE" != "update" ] || [ "$SINGLE" -eq 1 ]; }; then
  err "Web handover requires an existing bundled stack with separate app and server containers."
  exit 2
fi

# ---------------------------------------------------------------------------
# 1c. The reverse proxy, when nobody has said anything about it yet.
#
# With nothing remembered and no proxy flag, "not behind a proxy" is only a
# guess, and it is the expensive guess to get wrong. Two things are looked at
# before settling for it.
#
# First, the running stack. A deployment made before settings were remembered
# has no .deploy-state, but its app container still carries the list of Compose
# files it was created from. If that list includes the proxy overlay, the
# operator already answered this question, and the answer is carried forward
# instead of being silently reversed. That list is the only evidence used: an
# extra network attached by hand does not turn a deployment into a proxy one.
#
# Second, on a first install with a terminal attached, the operator is asked.
# The usual mistake is the network's name -- Nginx Proxy Manager started by
# Compose sits on <its-project>_default, not on anything called "proxy" -- so
# the networks are listed, with the ones a recognisable proxy is attached to
# first. Nothing is ever asked under --yes, under --dry-run, or without a
# terminal: those runs behave exactly as they always did.
# ---------------------------------------------------------------------------
PROXY_LOOKALIKE_PATTERN='nginx-proxy-manager|nginxproxymanager|traefik|caddy|openresty|haproxy|nginx'
CANDIDATE_NETWORKS=()
CANDIDATE_NOTES=()
CANDIDATE_PROXY_COUNT=0

collect_candidate_networks() {
  # collect_candidate_networks [OWN_PROJECT] -- every network the app could
  # join, the ones with a proxy-looking container on them first. Three docker
  # calls in total, however many networks there are: one round trip per network
  # makes this list slower to print than to read.
  local own_project="${1:-}" roster names inspected pass name owner members member
  local count detail image ports lowered described found note
  CANDIDATE_NETWORKS=()
  CANDIDATE_NOTES=()
  CANDIDATE_PROXY_COUNT=0

  roster="$(docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>/dev/null || true)"
  names="$(docker network ls --format '{{.Name}}' 2>/dev/null || true)"
  [ -n "$names" ] || return 0
  # shellcheck disable=SC2086  # Deliberate: one argument per network. Docker
  # network names cannot contain whitespace.
  inspected="$(docker network inspect --format '{{.Name}}|{{index .Labels "com.docker.compose.project"}}|{{range .Containers}}{{.Name}} {{end}}' $names 2>/dev/null || true)"

  for pass in proxies others; do
    while IFS='|' read -r name owner members; do
      [ -n "$name" ] || continue
      case "$name" in
        bridge|host|none) continue ;;
      esac
      if [ -n "$own_project" ] && [ "$owner" = "$own_project" ]; then
        continue
      fi
      valid_network_name "$name" || continue
      count=0
      found=""
      for member in $members; do
        count=$((count + 1))
        detail="$(printf '%s\n' "$roster" | awk -F'|' -v wanted="$member" '$1 == wanted && !seen { print $2 "|" $3; seen = 1 }')"
        image="${detail%%|*}"
        ports="${detail#*|}"
        lowered="$(printf '%s %s' "$member" "$image" | tr '[:upper:]' '[:lower:]')"
        if [[ "$lowered" =~ $PROXY_LOOKALIKE_PATTERN ]]; then
          described="${member} (${image:-image unknown}"
          case "$ports" in
            *":80->"*|*":80-"*|*":443->"*) described="${described}, publishes 80/443" ;;
          esac
          found="${found}${found:+, }${described})"
        fi
      done
      if [ -n "$found" ]; then
        [ "$pass" = "proxies" ] || continue
        CANDIDATE_PROXY_COUNT=$((CANDIDATE_PROXY_COUNT + 1))
        note="<- reverse proxy on it: ${found}"
      else
        [ "$pass" = "others" ] || continue
        case "$count" in
          0) note="no container attached" ;;
          1) note="1 container, not recognisably a reverse proxy" ;;
          *) note="${count} containers, none recognisably a reverse proxy" ;;
        esac
      fi
      CANDIDATE_NETWORKS+=("$name")
      CANDIDATE_NOTES+=("$note")
    done <<< "$inspected"
  done
}

print_candidate_networks() {
  local index=0 width=12
  while [ "$index" -lt "${#CANDIDATE_NETWORKS[@]}" ]; do
    if [ "${#CANDIDATE_NETWORKS[$index]}" -gt "$width" ]; then
      width="${#CANDIDATE_NETWORKS[$index]}"
    fi
    index=$((index + 1))
  done
  index=0
  while [ "$index" -lt "${#CANDIDATE_NETWORKS[@]}" ]; do
    printf '  %2d) %-*s  %s\n' "$((index + 1))" "$width" "${CANDIDATE_NETWORKS[$index]}" "${CANDIDATE_NOTES[$index]}"
    index=$((index + 1))
  done
}

carry_forward_running_proxy() {
  local container files entry overlay_seen=0 own_project networks network owner
  local found="" found_count=0 aliases candidate container_name service remembered_alias="" bindings

  container="$(compose_query ps -a -q app 2>/dev/null || true)"
  container="${container%%$'\n'*}"
  [ -n "$container" ] || return 0

  # Compose records the files as one comma-separated list of absolute paths,
  # with backslashes on Windows. Only the file names matter here.
  files="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container" 2>/dev/null || true)"
  files="${files//\\//}"
  while IFS= read -r entry; do
    case "${entry##*/}" in
      docker-compose.proxy.yml|docker-compose.single.proxy.yml) overlay_seen=1 ;;
      docker-compose.override.yml)
        if guard_is_ours; then
          overlay_seen=1
        fi
        ;;
    esac
  done < <(printf '%s\n' "$files" | tr ',' '\n')
  [ "$overlay_seen" -eq 1 ] || return 0

  own_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)"
  networks="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container" 2>/dev/null || true)"
  for network in $networks; do
    owner="$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$network" 2>/dev/null || true)"
    if [ -z "$own_project" ] || [ "$owner" != "$own_project" ]; then
      found="${found}${network} "
      found_count=$((found_count + 1))
    fi
  done
  found="${found% }"

  if [ "$found_count" -ne 1 ] || ! valid_network_name "$found"; then
    err "The app container of this deployment was started with the reverse-proxy"
    err "overlay, but this script cannot tell which network is the proxy's."
    err "  Networks it is on that do not belong to this stack: ${found:-none}"
    err ""
    err "  Nothing is remembered yet, so say it once and it will be:"
    err "    ./deploy.sh --proxy-network=<name>   stay behind that proxy network"
    err "    ./deploy.sh --no-proxy               publish a host port instead"
    err "  Nothing has been changed."
    exit 1
  fi

  # Compose gives every container its own name and its service name as aliases;
  # whatever is left is the one the overlay added, i.e. the proxy's upstream.
  container_name="$(docker inspect --format '{{.Name}}' "$container" 2>/dev/null || true)"
  container_name="${container_name#/}"
  service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container" 2>/dev/null || true)"
  aliases="$(docker inspect --format "{{with index .NetworkSettings.Networks \"${found}\"}}{{range .Aliases}}{{.}} {{end}}{{end}}" "$container" 2>/dev/null || true)"
  for candidate in $aliases; do
    case "$candidate" in
      "$container_name"|"$service") continue ;;
    esac
    case "$container" in
      "$candidate"*) continue ;;
    esac
    remembered_alias="$candidate"
    break
  done
  bindings="$(docker inspect --format '{{range $port, $_ := .HostConfig.PortBindings}}{{$port}} {{end}}' "$container" 2>/dev/null || true)"

  PROXY_MODE=1
  PROXY_NETWORK="$found"
  PROXY_NETWORK_REMEMBERED=1
  PROXY_ORIGIN="adopted"
  resolve_proxy_alias "$remembered_alias"
  if [ -n "$bindings" ]; then
    resolve_publish_ports yes
  else
    resolve_publish_ports no
  fi

  title "Reverse proxy"
  warn "Nothing is remembered yet, but this deployment's app container was started"
  warn "with the reverse-proxy overlay and is on '${PROXY_NETWORK}' as '${PROXY_ALIAS}'."
  ok "Carrying that forward: this deploy stays on '${PROXY_NETWORK}', and it is remembered from now on."
  info "  To leave the proxy network instead, re-run with --no-proxy."
}

ask_about_reverse_proxy() {
  local answer="" choice="" attempts=0 index default_index="" prompt chosen=""

  title "Reverse proxy"
  info "Does this deployment sit behind a reverse proxy that runs as a CONTAINER on"
  info "this host - Nginx Proxy Manager, Traefik, Caddy, an nginx container? If it"
  info "does, the app container has to join that proxy's Docker network, and it then"
  info "stops publishing a host port. Answer no for a proxy installed on the host"
  info "itself, or for no proxy at all."
  read -r -p "Behind a containerised reverse proxy? ${DIM}[y/N]${RESET} " answer || answer=""
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *)
      PROXY_ORIGIN="asked"
      ok "No reverse-proxy network. The app will publish APP_PORT on the host."
      info "  Changed your mind later? ./deploy.sh --proxy-network=<name>"
      return 0
      ;;
  esac

  collect_candidate_networks "$(derive_project_name)"
  if [ "${#CANDIDATE_NETWORKS[@]}" -eq 0 ]; then
    err "There is no Docker network on this host for the app to join yet."
    err "  Start your reverse proxy first (it creates its own network) and re-run,"
    err "  or have this script create one and attach the proxy to it afterwards:"
    err "    ./deploy.sh --proxy-network=<name> --create-network"
    err "  Nothing has been changed."
    exit 1
  fi

  info "Docker networks on this host:"
  print_candidate_networks
  info "The usual mistake is the name. A proxy started with Docker Compose is on"
  info "<its-project>_default unless its Compose file says otherwise."
  if [ "$CANDIDATE_PROXY_COUNT" -eq 1 ]; then
    default_index=1
  fi
  while [ -z "$chosen" ]; do
    attempts=$((attempts + 1))
    prompt="Which network is your proxy on? Number or name"
    if [ -n "$default_index" ]; then
      prompt="${prompt} ${DIM}[${default_index}]${RESET}"
    fi
    read -r -p "${prompt}: " choice || choice=""
    if [ -z "$choice" ]; then
      choice="$default_index"
    fi
    if [[ "$choice" =~ ^[0-9]+$ ]]; then
      if [ "$choice" -ge 1 ] && [ "$choice" -le "${#CANDIDATE_NETWORKS[@]}" ]; then
        chosen="${CANDIDATE_NETWORKS[$((choice - 1))]}"
      fi
    elif [ -n "$choice" ]; then
      index=0
      while [ "$index" -lt "${#CANDIDATE_NETWORKS[@]}" ]; do
        if [ "${CANDIDATE_NETWORKS[$index]}" = "$choice" ]; then
          chosen="$choice"
        fi
        index=$((index + 1))
      done
    fi
    if [ -z "$chosen" ]; then
      if [ "$attempts" -ge 3 ]; then
        err "No network chosen. Nothing has been changed."
        err "  Re-run and pick one from the list, or say it on the command line:"
        err "    ./deploy.sh --proxy-network=<name>     or     ./deploy.sh --no-proxy"
        exit 1
      fi
      if [ -n "$choice" ]; then
        warn "'${choice}' is not one of the networks above."
      fi
      warn "Enter the number or the exact name of one of the networks above."
    fi
  done

  PROXY_MODE=1
  PROXY_NETWORK="$chosen"
  PROXY_ORIGIN="asked"
  resolve_proxy_alias ""
  resolve_publish_ports no
  ok "Reverse-proxy network: '${PROXY_NETWORK}'. It is remembered for every later ./deploy.sh."
  if [ "$MODE" = "setup" ]; then
    info "  scripts/setup.sh runs next. When it asks for the public domain, give the"
    info "  hostname your proxy serves, so that PUBLIC_URL comes out right."
  fi
}

if [ "$PROXY_ORIGIN" = "default" ]; then
  carry_forward_running_proxy
fi
if [ "$PROXY_ORIGIN" = "default" ]; then
  FIRST_INSTALL=0
  if [ "$MODE" = "setup" ]; then
    FIRST_INSTALL=1
  elif [ "$SINGLE" -eq 1 ] && [ -z "$(existing_project_containers)" ] && [ -z "$(existing_project_volumes)" ]; then
    # The all-in-one topology has no setup mode; a first install is one where
    # this project owns nothing yet.
    FIRST_INSTALL=1
  fi
  if [ "$FIRST_INSTALL" -eq 1 ]; then
    if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
      ask_about_reverse_proxy
    else
      info "First install: not asking about a reverse proxy (--yes, --dry-run or no terminal)."
      info "  To put the stack behind a containerised one: ./deploy.sh --proxy-network=<name>"
    fi
  fi
fi
if [ "$PROXY_ORIGIN" = "adopted" ] || [ "$PROXY_ORIGIN" = "asked" ]; then
  apply_proxy_settings
  check_overlays_exist
fi

# ---------------------------------------------------------------------------
# 1d. The external proxy network.
#
# Not created implicitly. Nginx Proxy Manager, Traefik and friends normally
# bring their own network, and quietly creating a second one with the same name
# in a different scope - or an empty one the proxy is not on - produces a stack
# that looks deployed and is unreachable. So: require it, and print the exact
# command when it is missing.
#
# A REMEMBERED network that has gone missing is its own case, and it never
# falls back to deploying without one. That fallback is the failure this
# script's memory exists to prevent, arrived at by a different road: the app
# container would leave the proxy and publish a host port instead.
# ---------------------------------------------------------------------------
if [ "$PROXY_MODE" -eq 1 ]; then
  title "Proxy network"
  if docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1; then
    ok "External network '${PROXY_NETWORK}' exists."
  elif [ "$CREATE_NETWORK" -eq 1 ]; then
    if ! run docker network create "$PROXY_NETWORK"; then
      err "Could not create the network '${PROXY_NETWORK}'."
      exit 1
    fi
    if [ "$DRY_RUN" -eq 0 ]; then
      ok "Created external network '${PROXY_NETWORK}'."
      warn "Your reverse proxy container must also be attached to it:"
      warn "  docker network connect ${PROXY_NETWORK} <your-proxy-container>"
    fi
  elif [ "$PROXY_NETWORK_REMEMBERED" -eq 1 ]; then
    err "The reverse-proxy network '${PROXY_NETWORK}' does not exist any more."
    err ""
    err "  This deployment is remembered as sitting behind it (${STATE_FILE})."
    err "  Deploying without it would take the site off your proxy and publish"
    err "  APP_PORT on the host instead, so this script will not do that on its"
    err "  own. Nothing has been changed, and the running stack is untouched."
    err ""
    err "  Two ways out:"
    err "    1. The proxy is on a different network now (renamed, or its stack was"
    err "       recreated). Move this deployment onto that one:"
    err "         ./deploy.sh --proxy-network=<its-network>"
    err "    2. This deployment is no longer behind a containerised proxy:"
    err "         ./deploy.sh --no-proxy"
    err "       That publishes APP_PORT on the host again, on APP_BIND_ADDRESS."
    err ""
    err "  If the proxy stack is merely stopped, start it - that brings its network"
    err "  back - and re-run ./deploy.sh unchanged."
    collect_candidate_networks "$(derive_project_name)"
    if [ "${#CANDIDATE_NETWORKS[@]}" -gt 0 ]; then
      err ""
      err "  Docker networks on this host now:"
      print_candidate_networks >&2
    fi
    exit 1
  else
    err "The external network '${PROXY_NETWORK}' does not exist."
    err ""
    err "  Your reverse proxy normally creates its own network - find it with:"
    err "    docker network ls"
    err "  then re-run with that name:"
    err "    ./deploy.sh --proxy-network=<its-network>"
    err ""
    err "  Or create a new one and attach your proxy to it yourself:"
    err "    docker network create ${PROXY_NETWORK}"
    err "    docker network connect ${PROXY_NETWORK} <your-proxy-container>"
    err ""
    err "  Or let this script create it: --proxy-network --create-network"
    collect_candidate_networks "$(derive_project_name)"
    if [ "${#CANDIDATE_NETWORKS[@]}" -gt 0 ]; then
      err ""
      err "  Docker networks on this host now:"
      print_candidate_networks >&2
    fi
    exit 1
  fi
  ok "App reachable on it as: http://${PROXY_ALIAS}:8080 (alias 'app' too)"
fi

# On the update path everything needed to parse the configuration is already
# present, so fail fast before pulling or building.
if [ "$MODE" = "update" ]; then
  validate_compose_configuration || exit 1
  report_configuration_warnings
fi

# ---------------------------------------------------------------------------
# 2. Guard: the checkout must match its commit by CONTENT.
#
# `git status --porcelain` is NOT usable as a dirty check in this repository.
# It permanently reports ~160 files under server/**/migrations/** plus
# server/commitlint.config.js as modified with ZERO content difference -- stale
# cached stat sizes left behind by a CRLF-to-LF renormalisation. A status-based
# guard would refuse every deploy forever. `git diff` compares content, so it
# sees through that, and it ignores untracked files, which must never block a
# deploy either.
#
# Exit codes are read from the commands directly: 0 = identical, 1 = differs,
# anything else = git itself failed and must not be mistaken for "clean".
# ---------------------------------------------------------------------------
title "Checkout state"
# -c core.safecrlf=false silences git's "CRLF will be replaced by LF" notices.
# They are advisory, they are emitted once per file on every diff, and in a tree
# with a renormalised history they bury the file list this guard exists to show.
# Nothing is hidden by it: the exit codes below are read from git directly.
GIT_QUIET=(git -c core.safecrlf=false -C "$REPO_ROOT")
unstaged_status=0
"${GIT_QUIET[@]}" diff --quiet || unstaged_status=$?
staged_status=0
"${GIT_QUIET[@]}" diff --cached --quiet || staged_status=$?
for pair in "unstaged:${unstaged_status}" "staged:${staged_status}"; do
  if [ "${pair#*:}" -gt 1 ]; then
    err "git diff (${pair%%:*}) failed with exit ${pair#*:}; refusing to guess whether this checkout is clean."
    exit 1
  fi
done

STAMP_REVISION=1
if [ "$unstaged_status" -eq 1 ] || [ "$staged_status" -eq 1 ]; then
  err "This checkout has uncommitted CONTENT changes:"
  "${GIT_QUIET[@]}" --no-pager diff --name-only >&2
  "${GIT_QUIET[@]}" --no-pager diff --cached --name-only >&2
  if [ "$ALLOW_DIRTY" -eq 0 ]; then
    err "Commit them, or re-run with --allow-dirty to deploy them UNSTAMPED."
    exit 1
  fi
  warn "--allow-dirty: deploying modified sources."
  warn "  The images will be built WITHOUT a commit stamp, because a commit"
  warn "  stamp on modified sources would name a revision that is not what is"
  warn "  running. The deployment-identity check is skipped as a result."
  STAMP_REVISION=0
else
  ok "Checkout content matches HEAD (untracked files ignored, as they should be)."
fi

# ---------------------------------------------------------------------------
# 3. Pull. Fast-forward only: a diverged local branch must fail loudly rather
# than produce a merge commit nobody asked for. No stash, no clean, no reset --
# uncommitted work belonging to someone else, and the untracked files beside
# it, are not ours to move.
# ---------------------------------------------------------------------------
title "Git"
REVISION_BEFORE="$(git -C "$REPO_ROOT" rev-parse HEAD)"
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
info "Branch:   ${BRANCH}"
info "Revision: ${REVISION_BEFORE}"

if [ "$DO_PULL" -eq 0 ]; then
  info "--no-pull: deploying the checked-out revision as-is."
elif ! git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  warn "Branch ${BRANCH} has no upstream, so there is nothing to pull from."
  warn "  Deploying the checked-out revision. Set an upstream with:"
  warn "    git branch --set-upstream-to=origin/${BRANCH} ${BRANCH}"
else
  UPSTREAM="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
  info "Upstream: ${UPSTREAM}"
  if ! run git -C "$REPO_ROOT" pull --ff-only; then
    err "git pull --ff-only failed."
    err "  If the branches have diverged, this is the guard working: reconcile"
    err "  them yourself (rebase or merge) so the deploy cannot invent a merge"
    err "  commit. Nothing has been built or restarted."
    exit 1
  fi
fi

REVISION_AFTER="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [ "$REVISION_AFTER" = "$REVISION_BEFORE" ]; then
  info "Already at ${REVISION_AFTER} -- nothing arrived. Continuing with a rebuild."
else
  ok "Updated ${REVISION_BEFORE} -> ${REVISION_AFTER}"
  info "What arrived:"
  git -C "$REPO_ROOT" --no-pager log --oneline --no-decorate "${REVISION_BEFORE}..${REVISION_AFTER}"
fi
REVISION="$REVISION_AFTER"

if ! [[ "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  err "HEAD did not resolve to a 40-character lowercase commit: ${REVISION}"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3b. First install: generate .env by running the repository's own setup script.
#
# Reused, not reimplemented -- scripts/setup.sh already generates every secret
# at the right length (AUTH_SERVER_ENCRYPTION_SERVER_KEY must be exactly 32
# bytes of hex or auth refuses to boot), validates an existing environment and
# supports --yes. Duplicating that here would be a second copy of the same
# rules, drifting.
#
# Deliberately NOT passed:
#   --force-overwrite  destroys the encryption key; see the refusal above.
#   --up               this script does the build, start and verification, with
#                      a content-based dirty check. setup.sh --up refuses on
#                      `git status --porcelain`, which reports ~157 files
#                      modified in this tree forever with zero content
#                      difference, so inheriting it would make the setup path
#                      impossible to run here.
# ---------------------------------------------------------------------------
if [ "$MODE" = "setup" ]; then
  title "First install"
  SETUP_SCRIPT="${REPO_ROOT}/scripts/setup.sh"
  if [ ! -f "$SETUP_SCRIPT" ]; then
    err "Cannot run the setup path: ${SETUP_SCRIPT} is missing."
    exit 1
  fi

  SETUP_ARGS=()
  if [ "$ASSUME_YES" -eq 1 ]; then
    SETUP_ARGS+=(--yes)
  else
    info "scripts/setup.sh runs interactively now. When it asks whether to start"
    info "the stack, answer NO -- this script builds, starts and verifies it"
    info "immediately afterwards, and would otherwise do it twice."
  fi

  # ${arr[@]+...}: under `set -u`, bash 3.2 (still the system bash on macOS,
  # which scripts/setup.sh explicitly supports) treats an empty array expansion
  # as an unbound variable and aborts. This is the portable form.
  if ! run bash "$SETUP_SCRIPT" ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}; then
    err "scripts/setup.sh failed; nothing has been built or started."
    err "  If it failed while starting the stack, .env may still have been"
    err "  written. Re-run this script: it will then take the update path."
    exit 1
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    if [ ! -f "$ENV_FILE" ]; then
      err "scripts/setup.sh reported success but wrote no .env at ${ENV_FILE}."
      exit 1
    fi
    ok "Generated ${ENV_FILE}"
    validate_compose_configuration || exit 1
    report_configuration_warnings
  fi
fi

# ---------------------------------------------------------------------------
# 4. Back up before the build.
#
# Database migrations run when the container boots. That is the one part of a
# deploy a rebuild cannot undo: re-pointing the images at the previous commit
# does not un-migrate the schema. So the backup is ON by default, and a failed
# or suspiciously small backup ABORTS the deploy.
#
# The dump command is the one this repository already documents and tests:
# docs/self-hosting.md, docs/operations-hardening.md and
# scripts/verify-backup-restore.mjs all use exactly this invocation. The
# credentials are expanded INSIDE the container by the single-quoted sh -c, so
# MYSQL_ROOT_PASSWORD never reaches the host process list.
# ---------------------------------------------------------------------------
title "Pre-deploy backup"
BACKUP_FILE=""
if [ "$MODE" = "setup" ]; then
  info "First install: there is no existing data to back up. Skipping."
elif [ "$DO_BACKUP" -eq 0 ]; then
  warn "--no-backup: skipping the pre-deploy backup."
  warn "  Migrations run on container boot and a rebuild does not undo them."
else
  if [ "$SINGLE" -eq 1 ]; then
    BACKUP_SERVICE="app"
  else
    BACKUP_SERVICE="db"
  fi

  SERVICES_LOG="$(mktemp)"
  CLEANUP_FILES+=("$SERVICES_LOG")
  if ! compose_query config --services >"$SERVICES_LOG" 2>&1; then
    err "Could not list the services in ${COMPOSE_FILE}:"
    cat "$SERVICES_LOG" >&2
    exit 1
  fi
  if ! grep -qx "$BACKUP_SERVICE" "$SERVICES_LOG"; then
    err "No ${BACKUP_SERVICE} service in ${COMPOSE_FILE}, so this script does not know how to back it up."
    err "  Back the data up yourself, then re-run with --no-backup."
    exit 1
  fi

  BACKUP_CONTAINER="$(compose_query ps -q "$BACKUP_SERVICE" 2>/dev/null || true)"
  BACKUP_RUNNING=0
  if [ -n "$BACKUP_CONTAINER" ]; then
    if [ "$(docker inspect --format '{{.State.Running}}' "$BACKUP_CONTAINER" 2>/dev/null || echo false)" = "true" ]; then
      BACKUP_RUNNING=1
    fi
  fi

  if [ "$BACKUP_RUNNING" -eq 0 ]; then
    info "The ${BACKUP_SERVICE} service is not running, so there is no live data to dump."
    info "  This is the normal first-deploy case. Nothing to back up; continuing."
  else
    run mkdir -p "$BACKUP_DIR"
    TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    if [ "$SINGLE" -eq 1 ]; then
      BACKUP_FILE="${BACKUP_DIR}/srn-single-data-${TIMESTAMP}.tar"
      warn "The all-in-one topology keeps everything in the single-data volume"
      warn "  (SQLite database, uploads, generated secrets). Archiving /data while"
      warn "  the container runs can catch SQLite mid-write. For a copy that is"
      warn "  guaranteed consistent, stop the container first and archive the"
      warn "  volume, as docs/backups-and-recovery.md describes."
      # The path lives INSIDE the sh -c string on purpose. Git Bash on Windows
      # rewrites any argument that starts with a slash, so a bare `-C /data`
      # argument reaches tar as `C:/Program Files/Git/data` and the archive
      # fails. Observed, not theoretical. Inside the string it is untouched, and
      # this matches the shape of the dump command below.
      TAR_COMMAND='cd /data && exec tar -cf - .'
      BACKUP_DESCRIPTION="$(compose_display) exec -T app sh -c ${TAR_COMMAND}"
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s %s > %s\n' "${DIM}would run:${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
      else
        printf '%s %s > %s\n' "${DIM}+${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
        if ! "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}" exec -T app \
            sh -c "$TAR_COMMAND" >"$BACKUP_FILE"; then
          err "Archiving /data failed. The deploy is aborted; nothing has been rebuilt."
          err "  Partial archive left at ${BACKUP_FILE} for inspection."
          exit 1
        fi
      fi
    else
      BACKUP_FILE="${BACKUP_DIR}/srn-db-${TIMESTAMP}.sql"
      # shellcheck disable=SC2016  # Deliberate: MYSQL_ROOT_PASSWORD and
      # MYSQL_DATABASE must expand inside the container, from the environment
      # Compose already gave the db service. Expanding them here would put the
      # root password in this host process list.
      DUMP_COMMAND='exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --events "$MYSQL_DATABASE"'
      BACKUP_DESCRIPTION="$(compose_display) exec -T db sh -c ${DUMP_COMMAND}"
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s %s > %s\n' "${DIM}would run:${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
      else
        printf '%s %s > %s\n' "${DIM}+${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
        if ! "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}" exec -T db \
            sh -c "$DUMP_COMMAND" >"$BACKUP_FILE"; then
          err "mariadb-dump failed. The deploy is aborted; nothing has been rebuilt."
          err "  Partial dump left at ${BACKUP_FILE} for inspection."
          exit 1
        fi
      fi
    fi

    if [ "$DRY_RUN" -eq 0 ]; then
      if [ ! -f "$BACKUP_FILE" ]; then
        err "The backup command reported success but wrote no file at ${BACKUP_FILE}."
        exit 1
      fi
      BACKUP_BYTES="$(file_size "$BACKUP_FILE")"
      # Exit code 0 is not proof of a complete backup: a dump truncated by a
      # dropped connection still exits 0 on the host side. mariadb-dump writes
      # its "Dump completed" trailer as its very last action, so its presence is
      # the only cheap evidence that the dump ran to the end. A tar archive has
      # no trailer we can read as cheaply, so it gets a size floor only.
      if [ "$SINGLE" -eq 1 ]; then
        if [ "$BACKUP_BYTES" -lt 10240 ]; then
          err "The /data archive is only $(human_size "$BACKUP_BYTES") -- far too small to be a real instance."
          err "  Aborting the deploy. Investigate, then re-run."
          exit 1
        fi
      else
        if [ "$BACKUP_BYTES" -lt 1024 ]; then
          err "The database dump is only $(human_size "$BACKUP_BYTES") -- too small to be a real database."
          err "  Aborting the deploy. Investigate, then re-run."
          exit 1
        fi
        if ! tail -c 4096 "$BACKUP_FILE" | grep -q "Dump completed"; then
          err "The dump at ${BACKUP_FILE} has no Dump-completed trailer, so it is truncated."
          err "  Aborting the deploy rather than trusting an incomplete backup."
          exit 1
        fi
      fi
      ok "Backup: ${BACKUP_FILE} ($(human_size "$BACKUP_BYTES"))"
      info "  Restore procedure: docs/self-hosting.md and docs/operations-hardening.md."
      info "  Verify the restore path without touching live data: node scripts/verify-backup-restore.mjs"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. Build and deploy.
#
# SRN_DEPLOY_REVISION is a build arg in every Dockerfile this stack builds, so
# the running container can be traced back to a commit:
# /.well-known/srn-deployment.json on the app and the "deployment" field of
# /healthcheck/readiness on the server both report it. SRN_DEPLOY_VERSION is
# left unset deliberately -- the deployment-identity build stage then derives
# src-<first 12 of the revision>, which is the documented single-argument form.
# ---------------------------------------------------------------------------
if { [ "$WEB_ONLY" -eq 1 ] || [ "$ROLLING_WEB" -eq 1 ]; } && [ "$CHANGE_COUNT" -gt 0 ]; then
  err "Web handovers keep the public container and its networks in place. Apply deployment/network changes with a full deploy first."
  exit 2
fi
title "Build and deploy"
if [ "$STAMP_REVISION" -eq 1 ]; then
  BUILD_ENV=(env "SRN_DEPLOY_REVISION=${REVISION}")
  info "Stamping images with SRN_DEPLOY_REVISION=${REVISION}"
else
  # -u, not an empty value: the build treats an absent revision as the anonymous
  # local build this is, and an inherited one would be a stale lie.
  BUILD_ENV=(env -u SRN_DEPLOY_REVISION)
  warn "Building UNSTAMPED (--allow-dirty)."
fi

DEPLOY_PROMPT="Rebuild the images and restart the stack now?"
if [ "$WEB_ONLY" -eq 1 ]; then
  DEPLOY_PROMPT="Hand over the web app after health checks, leaving the backend running?"
elif [ "$ROLLING_WEB" -eq 1 ]; then
  DEPLOY_PROMPT="Update backend services while keeping the web frontend available, then hand over to the healthy web release?"
fi
if ! confirm "$DEPLOY_PROMPT"; then
  info "Aborted at the operator prompt. Nothing has been built or restarted."
  if [ -n "$BACKUP_FILE" ]; then
    info "The backup taken above is kept at ${BACKUP_FILE}"
  fi
  exit 0
fi

# The settings are written here: after the operator has confirmed, and BEFORE
# the stack is touched. Any later, and a deploy that moved the app container
# onto the proxy network and then failed its health wait would be forgotten --
# the next plain ./deploy.sh would take the container off the network again.
remember_settings

BUILD_START_SECONDS=$SECONDS
if [ "$WEB_ONLY" -eq 1 ] || [ "$ROLLING_WEB" -eq 1 ]; then
  WEB_ARGS=(--timeout "$HEALTH_TIMEOUT")
  if [ "$WEB_ROLLBACK" -eq 1 ]; then WEB_ARGS+=(--rollback); fi
  if [ "$ROLLING_WEB" -eq 1 ] && [ "$WEB_ONLY" -eq 0 ]; then WEB_ARGS+=(--full-update); fi
  if command -v node >/dev/null 2>&1; then
    run "${BUILD_ENV[@]}" node "${REPO_ROOT}/scripts/deploy-web.mjs" "${WEB_ARGS[@]}" -- "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}"
  else
    # The normal self-hosting installation needs Docker, not host Node/Yarn.
    # Run the small deployment controller in Docker when Node is absent.
    WEB_DOCKER_ENDPOINT="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
    case "$WEB_DOCKER_ENDPOINT" in
      unix://*) WEB_SOCKET="${WEB_DOCKER_ENDPOINT#unix://}" ;;
      *) err "Web handover on a remote Docker context needs Node.js on the deploy host."; exit 2 ;;
    esac
    [ -S "$WEB_SOCKET" ] || { err "The local Docker socket is unavailable."; exit 2; }
    WEB_SOCKET_GID="$(ls -nd "$WEB_SOCKET" | awk '{print $4}')"
    run docker build -t standard-red-notes/web-deployer:local -f "${REPO_ROOT}/scripts/WebDeployer.Dockerfile" "${REPO_ROOT}/scripts"
    run "${BUILD_ENV[@]}" docker run --rm --user "$(id -u):$(id -g)" --group-add "$WEB_SOCKET_GID" \
      -v "${WEB_SOCKET}:/var/run/docker.sock" -v "${REPO_ROOT}:${REPO_ROOT}" -w "$REPO_ROOT" \
      -e COMPOSE_PROJECT_NAME -e COMPOSE_PROFILES -e SRN_PROXY_NETWORK -e SRN_PROXY_ALIAS \
      -e SRN_DEPLOY_REVISION -e SRN_DEPLOY_VERSION standard-red-notes/web-deployer:local \
      "${WEB_ARGS[@]}" -- docker compose "${COMPOSE_FILE_ARGS[@]}"
  fi
  if [ "$WEB_ONLY" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 0 ]; then
      info "Web build and handover completed in $((SECONDS - BUILD_START_SECONDS))s."
    fi
    exit 0
  fi
elif ! run "${BUILD_ENV[@]}" "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}" up -d --build; then
  err "'$(compose_display) up -d --build' failed."
  if [ -n "$BACKUP_FILE" ]; then
    err "  Your pre-deploy backup is at ${BACKUP_FILE}"
  fi
  exit 1
fi
if [ "$DRY_RUN" -eq 0 ]; then
  info "Build/start phase completed in $((SECONDS - BUILD_START_SECONDS))s. Health verification gets a fresh ${HEALTH_TIMEOUT}s budget."
  ok "Compose reports the stack is up."
fi

# ---------------------------------------------------------------------------
# 6. Prove it booted.
#
# A successful build is not a running server. This stack has shipped a route
# pattern that crashed the gateway on startup with every test green, so the
# deploy is not finished until something answers an HTTP request.
#
# Three separate pieces of evidence, weakest first:
#   a. every container that declares a healthcheck reports healthy;
#   b. the readiness endpoint answers over the published port; and
#   c. the live deployment identity equals the commit we just built.
# ---------------------------------------------------------------------------
title "Verify"
if [ "$DRY_RUN" -eq 1 ]; then
  info "would wait for container healthchecks, then probe the readiness endpoint"
  info "would run node scripts/verify-deployment-identity.mjs against the live stack"
  ok "Dry run complete. Nothing was pulled, backed up, built, or restarted."
  exit 0
fi

report_failure_logs() {
  local service="$1"
  err "Last ${LOG_LINES} log lines from ${service}:"
  "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}" logs --no-color --tail "$LOG_LINES" "$service" >&2 || true
}

# Containers of THIS project only, INCLUDING the ones that are no longer
# running. `compose ps -q` without -a lists only the RUNNING ones, and an app
# container that crashed on boot is by then not running -- so a health gate
# built on it reports every surviving container healthy and calls that success.
# That is a green light sourced from the absence of the failure. Measured here
# with the app container dead of a startup error: `ps -q` returned 1 container,
# `ps -a -q` returned 2.
#
# A container that is `exited` with code 0 is a completed one-shot, which is
# what db-credential-preflight and db-volume-preflight do, and is success. Any
# other non-running state, and any non-zero exit, is a failure.
unhealthy_report=""
wait_deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
printed_waiting=0
while :; do
  unhealthy_report=""
  container_ids="$(compose_query ps -a -q || true)"
  if [ -z "$container_ids" ]; then
    err "Compose reported success but this project has no running containers."
    "${COMPOSE[@]}" "${COMPOSE_FILE_ARGS[@]}" ps -a >&2 || true
    exit 1
  fi
  while IFS= read -r container_id; do
    [ -n "$container_id" ] || continue
    container_name="$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null | sed 's|^/||' || true)"
    container_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)"
    container_state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || echo unknown)"
    container_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || echo unknown)"
    container_exit="$(docker inspect --format '{{.State.ExitCode}}' "$container_id" 2>/dev/null || echo unknown)"
    case "${container_state}/${container_health}/${container_exit}" in
      running/healthy/*|running/none/*) ;;
      exited/*/0) ;;
      *)
        unhealthy_report="${unhealthy_report}${container_name} (service ${container_service}): ${container_state}/${container_health} (exit ${container_exit})"$'\n'
        ;;
    esac
  done <<< "$container_ids"

  if [ -z "$unhealthy_report" ]; then
    ok "Every container is running and healthy, or is a one-shot that exited 0."
    break
  fi
  if [ "$(date +%s)" -ge "$wait_deadline" ]; then
    err "Timed out after ${HEALTH_TIMEOUT}s waiting for containers to become healthy:"
    printf '%s' "$unhealthy_report" >&2
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      failing_service="${line#*(service }"
      failing_service="${failing_service%%)*}"
      [ -n "$failing_service" ] && report_failure_logs "$failing_service"
    done <<< "$unhealthy_report"
    exit 1
  fi
  if [ "$printed_waiting" -eq 0 ]; then
    info "Waiting up to ${HEALTH_TIMEOUT}s for healthchecks after Compose startup..."
    info "The server's 90s start period is its initial healthcheck grace window."
    printed_waiting=1
  fi
  sleep 5
done

# b1. Proxy mode: prove what the PROXY will experience, which a host-side
# probe of a published port cannot speak to at all. Three assertions:
#   - the app container is on BOTH networks (internal + proxy);
#   - its alias resolves FROM a container on the proxy network; and
#   - readiness answers over that network.
# The probe runs in a throwaway container on the proxy network, using the app's
# own image (it has wget -- its healthcheck uses it) so nothing has to be
# pulled, with --entrypoint sh so the app's own startup does not run.
if [ "$PROXY_MODE" -eq 1 ]; then
  title "Proxy reachability"
  PROXY_APP_CONTAINER="$(compose_query ps -q app 2>/dev/null | head -1 || true)"
  if [ -z "$PROXY_APP_CONTAINER" ]; then
    err "No running app container to check proxy reachability against."
    exit 1
  fi

  PROXY_APP_NETWORKS="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$PROXY_APP_CONTAINER" 2>/dev/null || true)"
  info "app container networks: ${PROXY_APP_NETWORKS}"
  case " ${PROXY_APP_NETWORKS} " in
    *" ${PROXY_NETWORK} "*) ok "Attached to the proxy network '${PROXY_NETWORK}'." ;;
    *)
      err "The app container is NOT attached to '${PROXY_NETWORK}'."
      err "  Networks found: ${PROXY_APP_NETWORKS}"
      exit 1
      ;;
  esac
  PROXY_INTERNAL_NETWORK_FOUND=0
  for network_name in $PROXY_APP_NETWORKS; do
    case "$network_name" in
      *standard-red-notes*|*_default) PROXY_INTERNAL_NETWORK_FOUND=1 ;;
    esac
  done
  if [ "$PROXY_INTERNAL_NETWORK_FOUND" -eq 1 ]; then
    ok "Still attached to the internal network as well."
  else
    err "The app container lost its internal network; it cannot reach the server."
    err "  Networks found: ${PROXY_APP_NETWORKS}"
    exit 1
  fi

  PROXY_APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$PROXY_APP_CONTAINER" 2>/dev/null || true)"
  if [ -z "$PROXY_APP_IMAGE" ]; then
    err "Could not determine the app image to run the in-network probe with."
    exit 1
  fi

  PROXY_PROBE_LOG="$(mktemp)"
  CLEANUP_FILES+=("$PROXY_PROBE_LOG")
  PROXY_READINESS_URL="http://${PROXY_ALIAS}:8080/healthcheck/readiness"
  PROXY_MARKER_URL="http://${PROXY_ALIAS}:8080/.well-known/srn-deployment.json"
  info "Probing ${PROXY_READINESS_URL} from a container on '${PROXY_NETWORK}'"
  if ! docker run --rm --network "$PROXY_NETWORK" --entrypoint sh "$PROXY_APP_IMAGE" \
      -c "wget -qO- --timeout=20 ${PROXY_READINESS_URL}" >"$PROXY_PROBE_LOG" 2>&1; then
    err "The app is not reachable as '${PROXY_ALIAS}' from the proxy network."
    cat "$PROXY_PROBE_LOG" >&2 || true
    err "  This is exactly what your reverse proxy would see. Check that the"
    err "  proxy container is itself attached to '${PROXY_NETWORK}':"
    err "    docker network connect ${PROXY_NETWORK} <your-proxy-container>"
    report_failure_logs app
    exit 1
  fi
  ok "Readiness answered over the proxy network, by service alias."
  head -c 400 "$PROXY_PROBE_LOG"
  printf '\n'

  # Identity over the proxy network. scripts/verify-deployment-identity.mjs
  # needs host reachability and node, and neither is available in here, so this
  # asserts the exact revision and derived version on BOTH surfaces the
  # verifier reads. Stated for what it is: an exact-string check on both
  # endpoints, not the verifier's full key-shape validation.
  if [ "$STAMP_REVISION" -eq 1 ]; then
    PROXY_EXPECTED_VERSION="src-$(printf '%s' "$REVISION" | cut -c1-12)"
    if ! docker run --rm --network "$PROXY_NETWORK" --entrypoint sh "$PROXY_APP_IMAGE" \
        -c "wget -qO- --timeout=20 ${PROXY_MARKER_URL}" >>"$PROXY_PROBE_LOG" 2>&1; then
      err "The deployment marker is not reachable over the proxy network."
      cat "$PROXY_PROBE_LOG" >&2 || true
      exit 1
    fi
    # grep -o, not grep -c: -c counts LINES, and neither endpoint's JSON body
    # ends in a newline, so both responses append into a single line and a
    # line count of the two surfaces would be 1 however well it worked.
    PROXY_IDENTITY_HITS="$(grep -o "\"revision\":\"${REVISION}\"" "$PROXY_PROBE_LOG" | wc -l | tr -d '[:space:]')"
    if [ "${PROXY_IDENTITY_HITS:-0}" -lt 2 ] || ! grep -q "\"version\":\"${PROXY_EXPECTED_VERSION}\"" "$PROXY_PROBE_LOG"; then
      err "Over the proxy network, readiness and the deployment marker do not both"
      err "report the commit just built (${REVISION} / ${PROXY_EXPECTED_VERSION})."
      cat "$PROXY_PROBE_LOG" >&2 || true
      exit 1
    fi
    ok "Both identity surfaces report ${REVISION} (${PROXY_EXPECTED_VERSION}) over the proxy network."
  fi
fi

# b. A real HTTP request over the published port. The readiness endpoint fans
# out to the database, cache and every sub-service, so its worst case is around
# four seconds; --max-time 20 leaves room without hiding a hang.
#
# The port comes from Compose, which knows what it actually published -- not
# from APP_PORT in .env. Compose lets an APP_PORT exported in the environment
# win over the .env value, so a .env-derived URL can point somewhere else
# entirely. Measured here: with APP_PORT=13902 exported, the .env-derived probe
# hit 13901, got HTTP 200 and {"status":"ready"} from a DIFFERENT project's
# container on this host, and called the deploy verified. Asking Compose closes
# that, and --url still overrides everything for a reverse-proxied deployment.
PROXY_SKIPS_HOST_PROBE=0
if [ "$PROXY_MODE" -eq 1 ] && [ "$PUBLISH_PORTS" -eq 0 ] && [ -z "$HEALTH_URL" ]; then
  PROXY_SKIPS_HOST_PROBE=1
  info "Proxy mode publishes no host port, so there is nothing to probe from this"
  info "host. The proxy-network checks above are the stronger evidence anyway:"
  info "they test the path your proxy actually uses. Pass --publish-ports for a"
  info "loopback port, or --url for a probe through the proxy itself."
fi

if [ "$PROXY_SKIPS_HOST_PROBE" -eq 0 ] && [ -z "$HEALTH_URL" ]; then
  PUBLISHED_ENDPOINT="$(compose_query port app 8080 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -n "$PUBLISHED_ENDPOINT" ]; then
    PROBE_PORT="${PUBLISHED_ENDPOINT##*:}"
    PROBE_HOST="${PUBLISHED_ENDPOINT%:*}"
  else
    # No published port on the app service: fall back to .env and say so, since
    # this is the one case where the probe target is inferred rather than read.
    PROBE_PORT="$(env_value APP_PORT)"
    [ -n "$PROBE_PORT" ] || PROBE_PORT=3001
    PROBE_HOST="$(env_value APP_BIND_ADDRESS)"
    warn "Compose reports no published port for the app service; falling back to APP_PORT from .env."
  fi
  case "$PROBE_HOST" in
    ""|0.0.0.0|"::"|"[::]") PROBE_HOST="127.0.0.1" ;;
  esac
  HEALTH_URL="http://${PROBE_HOST}:${PROBE_PORT}"
fi
HEALTH_URL="${HEALTH_URL%/}"
READINESS_URL=""
if [ -n "$HEALTH_URL" ]; then
  READINESS_URL="${HEALTH_URL}/healthcheck/readiness"
fi

PROBE_LOG="$(mktemp)"
CLEANUP_FILES+=("$PROBE_LOG")
probe_status=1
probe_readiness() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 20 "$READINESS_URL" >"$PROBE_LOG" 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 20 -O - "$READINESS_URL" >"$PROBE_LOG" 2>&1
  else
    return 2
  fi
}

if [ -n "$READINESS_URL" ]; then
  info "Probing ${READINESS_URL}"
  probe_deadline=$(( $(date +%s) + 60 ))
fi

# Does not run at all when there is no URL to probe, which is the normal case
# in proxy mode: the proxy-network checks above already covered that path.
while [ -n "$READINESS_URL" ]; do
  # Read the status from the command itself. `$?` after `if cmd; then ... fi`
  # with no else branch is the status of the IF, which is 0 even when cmd failed.
  probe_status=0
  probe_readiness || probe_status=$?
  if [ "$probe_status" -eq 0 ]; then
    break
  fi
  if [ "$probe_status" -eq 2 ]; then
    warn "Neither curl nor wget is installed, so the published port could not be probed."
    warn "  Container healthchecks passed, which is weaker evidence: they run"
    warn "  inside the container and say nothing about the published port."
    break
  fi
  if [ "$(date +%s)" -ge "$probe_deadline" ]; then
    err "${READINESS_URL} did not answer successfully within 60s."
    cat "$PROBE_LOG" >&2 || true
    err "  The containers are healthy, so the port publication or the host"
    err "  firewall is the likely cause. Check APP_PORT and APP_BIND_ADDRESS in"
    err "  .env, or pass --url for a deployment behind a reverse proxy."
    report_failure_logs app
    exit 1
  fi
  sleep 3
done

if [ "$probe_status" -eq 0 ]; then
  ok "Readiness endpoint answered over the published port."
  head -c 400 "$PROBE_LOG"
  printf '\n'
fi

# c. Deployment identity. This is the check that distinguishes "a server is
# running" from "the commit I just built is running" -- the difference that
# makes a deploy either verified or merely hopeful. Reuses the repository's own
# tested verifier rather than re-deriving the rule a fifth time.
IDENTITY_SCRIPT="${REPO_ROOT}/scripts/verify-deployment-identity.mjs"
if [ "$STAMP_REVISION" -eq 0 ]; then
  warn "Skipping the deployment-identity check: --allow-dirty built unstamped images."
elif [ "$PROXY_SKIPS_HOST_PROBE" -eq 1 ]; then
  info "Deployment identity was checked over the proxy network above."
elif [ "$probe_status" -ne 0 ]; then
  warn "Skipping the deployment-identity check: the readiness endpoint was not reachable from this host."
elif [ ! -f "$IDENTITY_SCRIPT" ]; then
  warn "Skipping the deployment-identity check: ${IDENTITY_SCRIPT} is missing."
elif ! command -v node >/dev/null 2>&1; then
  warn "Skipping the deployment-identity check: node is not installed on this host."
  warn "  Container health and the readiness endpoint both passed; what is NOT"
  warn "  proven is that the running image is the commit just built."
else
  IDENTITY_LOG="$(mktemp)"
  CLEANUP_FILES+=("$IDENTITY_LOG")
  if run node "$IDENTITY_SCRIPT" --app-url "$HEALTH_URL" --expected-revision "$REVISION" >"$IDENTITY_LOG" 2>&1; then
    ok "$(cat "$IDENTITY_LOG")"
  else
    err "The live deployment identity does not match the commit just built:"
    cat "$IDENTITY_LOG" >&2
    err "  Something other than ${REVISION} is serving traffic. A cached image"
    err "  layer or a stale running container is the usual cause."
    report_failure_logs app
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
title "Deployed"
ok "Revision:  ${REVISION}"
if [ "$PROXY_MODE" -eq 1 ]; then
  ok "Proxy net: ${PROXY_NETWORK}"
  ok "Upstream:  http://${PROXY_ALIAS}:8080   <- point your reverse proxy here"
fi
if [ -n "$HEALTH_URL" ]; then
  ok "App:       ${HEALTH_URL}"
fi
if [ -n "$BACKUP_FILE" ]; then
  ok "Backup:    ${BACKUP_FILE}"
fi
if [ "$SETTINGS_SAVED" -eq 1 ]; then
  ok "Saved in:  ${STATE_FILE}   <- a plain ./deploy.sh redeploys this way"
fi
case "$BARE_COMPOSE" in
  guarded)
    info "By hand:   'docker compose up -d' in ${REPO_ROOT} deploys this too."
    ;;
  unguarded)
    warn "By hand:   start and restart this stack with ./deploy.sh. A bare"
    warn "           'docker compose up -d' does not know the settings above."
    ;;
esac
if [ "$WARNING_COUNT" -gt 0 ]; then
  warn "${WARNING_COUNT} configuration warning(s) above are still unresolved."
fi
info "Logs:      $(compose_display) logs -f"
info "Stop:      $(compose_display) stop -t 75 app server"
