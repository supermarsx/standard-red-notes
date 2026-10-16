# Development Compose fixtures

These files are for integration tests, not for running an end-user instance.
The supported deployment files remain at the repository root:
`docker-compose.yml`, `docker-compose.single.yml`, and their proxy overlays.

Run these commands from the repository root:

```sh
docker compose -f dev/compose/docker-compose.dav-test.yml up -d --wait
docker compose -p srn-davtest-single -f docker-compose.single.yml -f dev/compose/docker-compose.dav-test.single.yml up -d --build --wait
# Or use the multi-container deployment with its test overlay:
docker compose -p srn-davtest-multi -f docker-compose.yml -f dev/compose/docker-compose.dav-test.multi.yml up -d --build --wait
```

The DAV fixture stack publishes test credentials and binds its observer ports
to loopback. Its bind mounts are relative to this directory. Deployment overlays
resolve paths relative to the first (root-level) deployment file.
Use `node scripts/verify-dav-bridge.mjs --help` for the verification commands.

Remove the test servers when finished:

```sh
docker compose -f dev/compose/docker-compose.dav-test.yml down -v
```
