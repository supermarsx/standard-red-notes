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
2. Fetches the repo (`REPO_URL`) or uses an existing checkout at `APP_DIR`.
3. Builds the server workspace and the web SPA bundle.
4. Generates + persists per-instance secrets under the data dir.
5. Writes the home-server `.env` (sqlite + in-memory cache) and installs a
   **systemd** unit (`standard-red-notes.service`) that runs it.
6. Configures nginx to serve the SPA and reverse-proxy the API same-origin,
   self-healing the CSP inline-script hash (same method as the Docker image).

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

# Build + install + start everything
REPO_URL=https://github.com/<owner>/standard-red-notes.git ./install.sh
```

If you already cloned to `/opt/standard-red-notes` (as above), `REPO_URL` is
optional — the script uses the existing checkout.

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

Register a user in the web UI. To grant the in-app Admin panel, set
`ADMIN_EMAILS=you@example.com` in
`/opt/standard-red-notes/server/packages/home-server/.env` and
`systemctl restart standard-red-notes`.

## Operate

```sh
systemctl status standard-red-notes
journalctl -u standard-red-notes -f      # backend logs
systemctl restart standard-red-notes
nginx -t && systemctl reload nginx
```

## Upgrade

Re-run the installer — it re-pulls `REPO_REF` (default `main`), rebuilds, and
restarts. Secrets and data under `DATA_DIR` are preserved:

```sh
cd /opt/standard-red-notes/deploy/lxc && ./install.sh
```

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

## Verification (manual — cannot be run in CI here)

```sh
bash -n deploy/lxc/install.sh          # syntax check (run in this repo)
shellcheck deploy/lxc/install.sh       # if shellcheck is installed

# After install, inside the container:
systemctl is-active standard-red-notes # -> active
curl -fsS http://127.0.0.1/healthcheck # -> 200
curl -fsSI http://127.0.0.1/ | grep -i content-security-policy   # served CSP
# Confirm the served CSP hash matches the served inline script (self-heal):
#   see docs/DEPLOYMENT.md "Verifying the CSP self-heal".
```
