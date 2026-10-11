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
#   SETUP   no .env yet. Generates one by running scripts/setup.sh, then builds,
#           starts and verifies. Nothing to back up on a first install.
#   UPDATE  .env exists. Pulls, backs up the database, rebuilds, restarts and
#           verifies. Safe to run twice; it reseeds nothing and never edits .env.
#
# Usage:
#   ./deploy.sh                      # detect the mode and do the right thing
#   ./deploy.sh --dry-run            # print every command, change nothing
#   ./deploy.sh --yes                # non-interactive (no confirmation prompt)
#   ./deploy.sh --single             # the all-in-one docker-compose.single.yml
#   ./deploy.sh --no-pull            # deploy the checked-out revision as-is
#   ./deploy.sh --no-backup          # skip the pre-deploy database backup
#   ./deploy.sh --proxy-network      # sit behind an external reverse proxy
#
# Flags:
#   -h, --help              Show this help and exit.
#       --setup             Force the first-install path. Refuses if .env exists.
#       --update            Force the update path. Refuses if .env is missing.
#       --single            Deploy docker-compose.single.yml (all-in-one, SQLite).
#   -f, --file PATH         Deploy an explicit Compose file instead.
#   -p, --project NAME      Compose project name (COMPOSE_PROJECT_NAME).
#       --no-pull           Do not run `git pull`.
#       --no-backup         Do not back up the database first. NOT RECOMMENDED:
#                           migrations run on container boot and a rebuild
#                           cannot undo them.
#       --backup-dir DIR    Where backups land (default: ./backups).
#       --allow-dirty       Deploy a checkout with uncommitted content changes.
#                           The images are then built UNSTAMPED, because a
#                           commit stamp on modified sources is a lie, and the
#                           deployment-identity check is skipped.
#       --timeout SECONDS   How long to wait for containers to become healthy
#                           (default: 600).
#       --log-lines N       Log lines to print from a failing container
#                           (default: 200).
#       --url BASE          Base URL for the post-deploy HTTP check. Default:
#                           derived from APP_BIND_ADDRESS / APP_PORT in .env.
#   -y, --yes               Assume yes; never prompt.
#   -n, --dry-run           Print every command that would run; change nothing.
#
# This script NEVER creates or modifies .env, never stashes, never prunes, and
# never removes a volume. It reads .env without sourcing it.
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
SINGLE=0
ALLOW_DIRTY=0
COMPOSE_FILE=""
PROJECT_NAME=""
BACKUP_DIR="${REPO_ROOT}/backups"
HEALTH_TIMEOUT=600
LOG_LINES=200
HEALTH_URL=""

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
    --single) SINGLE=1 ;;
    -f|--file) need_value "$1" "${2:-}"; COMPOSE_FILE="$2"; shift ;;
    -p|--project) need_value "$1" "${2:-}"; PROJECT_NAME="$2"; shift ;;
    --no-pull) DO_PULL=0 ;;
    --no-backup) DO_BACKUP=0 ;;
    --backup-dir) need_value "$1" "${2:-}"; BACKUP_DIR="$2"; shift ;;
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

if [ "$SINGLE" -eq 1 ] && [ -n "$COMPOSE_FILE" ]; then
  err "--single and --file are mutually exclusive; --single already selects docker-compose.single.yml."
  exit 2
fi
if [ -z "$COMPOSE_FILE" ]; then
  if [ "$SINGLE" -eq 1 ]; then
    COMPOSE_FILE="${REPO_ROOT}/docker-compose.single.yml"
  else
    COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"
  fi
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
compose_query() { "${COMPOSE[@]}" -f "$COMPOSE_FILE" "$@"; }

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
# 1. Preflight. Nothing below this point has touched the deployment yet.
# ---------------------------------------------------------------------------
title "Standard Red Notes - deploy"
if [ "$DRY_RUN" -eq 1 ]; then
  warn "DRY RUN: no command that changes anything will be executed."
fi

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
    err "'${COMPOSE[*]} -f ${COMPOSE_FILE}' configuration failed to parse:"
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

  if [ "$WARNING_COUNT" -eq 0 ]; then
    ok "No known-destructive configuration gaps found in .env."
  else
    warn "${WARNING_COUNT} warning(s). These do not block the deploy."
  fi
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
derive_project_name() {
  # Compose derives the default project name from the project directory name,
  # lowercased with everything outside [a-z0-9_-] dropped. Containers are
  # checked authoritatively with `compose ps -a -q`; this derivation is only
  # needed to look for volumes when no container exists.
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  basename -- "$(dirname -- "$COMPOSE_FILE")" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]//g'
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

if [ -n "$FORCE_MODE" ]; then
  MODE="$FORCE_MODE"
elif [ "$ENV_PRESENT" -eq 1 ]; then
  MODE="update"
else
  MODE="setup"
fi

if [ "$MODE" = "setup" ]; then
  ok "SETUP (first install): generate .env, then build, start and verify."
else
  ok "UPDATE: pull, back up, rebuild, restart and verify."
fi
if [ -n "$FORCE_MODE" ]; then
  info "  Forced with --${FORCE_MODE}; evidence on disk: ${ENV_EVIDENCE}"
else
  info "  Detected from: ${ENV_EVIDENCE}"
fi

if [ "$MODE" = "update" ] && [ "$ENV_PRESENT" -eq 0 ]; then
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
      BACKUP_DESCRIPTION="${COMPOSE[*]} -f ${COMPOSE_FILE} exec -T app sh -c ${TAR_COMMAND}"
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s %s > %s\n' "${DIM}would run:${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
      else
        printf '%s %s > %s\n' "${DIM}+${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
        if ! "${COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T app \
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
      BACKUP_DESCRIPTION="${COMPOSE[*]} -f ${COMPOSE_FILE} exec -T db sh -c ${DUMP_COMMAND}"
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '%s %s > %s\n' "${DIM}would run:${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
      else
        printf '%s %s > %s\n' "${DIM}+${RESET}" "$BACKUP_DESCRIPTION" "$BACKUP_FILE"
        if ! "${COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T db \
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

if ! confirm "Rebuild the images and restart the stack now?"; then
  info "Aborted at the operator prompt. Nothing has been built or restarted."
  if [ -n "$BACKUP_FILE" ]; then
    info "The backup taken above is kept at ${BACKUP_FILE}"
  fi
  exit 0
fi

if ! run "${BUILD_ENV[@]}" "${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d --build; then
  err "'${COMPOSE[*]} -f ${COMPOSE_FILE} up -d --build' failed."
  if [ -n "$BACKUP_FILE" ]; then
    err "  Your pre-deploy backup is at ${BACKUP_FILE}"
  fi
  exit 1
fi
if [ "$DRY_RUN" -eq 0 ]; then
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
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" logs --no-color --tail "$LOG_LINES" "$service" >&2 || true
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
    "${COMPOSE[@]}" -f "$COMPOSE_FILE" ps -a >&2 || true
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
    info "Waiting up to ${HEALTH_TIMEOUT}s for healthchecks (the server allows a 90s start period)..."
    printed_waiting=1
  fi
  sleep 5
done

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
if [ -z "$HEALTH_URL" ]; then
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
READINESS_URL="${HEALTH_URL}/healthcheck/readiness"

PROBE_LOG="$(mktemp)"
CLEANUP_FILES+=("$PROBE_LOG")
probe_readiness() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 20 "$READINESS_URL" >"$PROBE_LOG" 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 20 -O - "$READINESS_URL" >"$PROBE_LOG" 2>&1
  else
    return 2
  fi
}

info "Probing ${READINESS_URL}"
probe_deadline=$(( $(date +%s) + 60 ))
probe_status=1
while :; do
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
ok "App:       ${HEALTH_URL}"
if [ -n "$BACKUP_FILE" ]; then
  ok "Backup:    ${BACKUP_FILE}"
fi
if [ "$WARNING_COUNT" -gt 0 ]; then
  warn "${WARNING_COUNT} configuration warning(s) above are still unresolved."
fi
info "Logs:      ${COMPOSE[*]} -f ${COMPOSE_FILE} logs -f"
info "Stop:      ${COMPOSE[*]} -f ${COMPOSE_FILE} stop -t 75 app server"
