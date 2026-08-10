# Standard Red Notes in an LXC system container

Run the whole app as native systemd services inside a Debian/Ubuntu **LXC system
container** (Proxmox or `lxd`/`incus`) — no Docker required. Uses the same
single-process backend as the all-in-one container image: the **home-server**
(auth + syncing + files + revisions + api-gateway in one Node process) with
**embedded sqlite + in-memory cache + in-process events**, fronted by **nginx**
serving the web app. Zero external services (no MySQL, no Redis).

## What the installer does

`install.sh` is idempotent (`set -euo pipefail`) and, run as root inside the
container:

1. Installs Node.js, Yarn (corepack), nginx, git, openssl, build tools.
2. Resolves an explicit Git ref to a full commit (or pins an existing checkout's
   current `HEAD`) and fails closed on fetch/ref errors.
3. Builds and boots the server plus web SPA in an isolated staging release.
4. Generates + persists per-instance secrets under the data dir.
5. Writes the home-server `.env` (sqlite + in-memory cache) and installs a
   **systemd** unit (`standard-red-notes.service`) that runs it.
6. Switches one `current` symlink only after the staged backend health check
   passes. nginx and systemd both use that link; `previous` is retained for an
   explicit rollback. Releases are root-owned/read-only at runtime.

The staged boot uses an isolated fresh SQLite database. It verifies startup and
schema creation without reading or changing the production database.

The NodeSource setup script is not piped into a shell. The installer downloads
the repository signing key, verifies its pinned fingerprint, and then lets APT
verify signed Node.js packages.

## Proxmox — create the container

On the Proxmox host (adjust storage/bridge/IDs):

```sh
# Download a template if you don't have one
pveam update && pveam available | grep debian-12
pveam download local debian-12-standard_12.7-1_amd64.tar.zst

# Create an unprivileged container (2 vCPU, 2 GiB RAM, 8 GiB disk)
pct create 200 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname notes --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:8 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1 --unprivileged 1

pct start 200
pct enter 200
```

> `nesting=1` is recommended (lets systemd + user-namespaced services behave).
> A plain unprivileged container is fine — this stack needs no Docker-in-LXC.

## lxd / incus — create the container

```sh
incus launch images:debian/12 notes -c security.nesting=true
incus exec notes -- bash
```

## Install (inside the container)

```sh
apt-get update && apt-get install -y git
git clone https://github.com/<owner>/standard-red-notes.git /opt/standard-red-notes
cd /opt/standard-red-notes/deploy/lxc

# Build + install + start exactly the checked-out commit
REPO_REF="$(git rev-parse HEAD)" ./install.sh
```

If no checkout exists, set both `REPO_URL` and `REPO_REF`. A full 40-character
commit SHA is accepted directly. Every symbolic branch or tag also requires
`EXPECTED_COMMIT=<full-sha>`, and deployment stops if resolution differs.
Omitting `REPO_REF` is allowed only with an existing checkout and deploys its
already-concrete current `HEAD` without fetching.

Optional overrides, e.g. bind to port 8080 and a custom data dir:

```sh
HTTP_PORT=8080 DATA_DIR=/srv/notes-data ./install.sh
```

## Access

```sh
# From the host or another machine on the network:
curl -fsS http://<container-ip>/healthcheck        # -> {"...":"ok"} style 200
# Browser:
http://<container-ip>/
```

Register a user in the web UI, then persist its administrator role locally:

```sh
srn-admin roles grant you@example.com ADMIN_USER
```

## Operate

```sh
systemctl status standard-red-notes
journalctl -u standard-red-notes -f      # backend logs
systemctl restart standard-red-notes
nginx -t && systemctl reload nginx
```

## Upgrade and rollback

Fetch deliberately, inspect the commit, then deploy that exact SHA. Fetch,
build, staging health, and the live health check are fail-closed. Secrets and
data under `DATA_DIR` are preserved:

```sh
cd /opt/standard-red-notes
git fetch --all --tags --prune
commit="$(git rev-parse origin/main^{commit})"
REPO_REF="$commit" EXPECTED_COMMIT="$commit" ./deploy/lxc/install.sh
```

The prior successful release remains at `previous`. Roll back with the copy of
the installer in the live release (custom `APP_DIR` values must be exported):

```sh
/opt/standard-red-notes/current/deploy/lxc/install.sh --rollback
```

Rollback switches `current`, updates `previous` with immediate link recovery on
partial failure, restarts both services, and switches back automatically if the
rollback target does not become healthy.

## Back up

Everything stateful lives under `DATA_DIR` (default
`/var/lib/standard-red-notes`): `database/home_server.sqlite`, `uploads/`, and
`secrets.env`. Stop the service, copy the directory, restart:

```sh
systemctl stop standard-red-notes
tar czf notes-backup.tgz -C /var/lib standard-red-notes
systemctl start standard-red-notes
```

> Keep `secrets.env` with the backup — without the same secrets, existing
> sessions and encrypted MFA data won't validate against a restored DB.

## HTTPS

Terminate TLS at a reverse proxy in front (Caddy/nginx/Traefik on the host or
another container) pointing at `http://<container-ip>:<HTTP_PORT>`, then set in
the home-server `.env`: `COOKIE_SECURE=true`, `COOKIE_DOMAIN=notes.example.com`,
and `PUBLIC_FILES_SERVER_URL=https://notes.example.com/files`. Restart the
service.

## Verification

```sh
bash -n deploy/lxc/install.sh          # syntax check (run in this repo)
bash -n deploy/lxc/release.sh
shellcheck deploy/lxc/install.sh       # if shellcheck is installed
node --test scripts/validate-lxc-deploy.test.mjs # fail-closed mutation checks

# After install, inside the container:
systemctl is-active standard-red-notes # -> active
curl -fsS http://127.0.0.1/healthcheck # -> 200
curl -fsSI http://127.0.0.1/ | grep -i content-security-policy   # served CSP
# Confirm the served CSP hash matches the served inline script (self-heal):
#   see docs/DEPLOYMENT.md "Verifying the CSP self-heal".
```
