# Quarantined upstream workflows

These files are preserved from the vendored Standard Notes app, but this directory is not an executable GitHub Actions workflow directory. They are quarantined because their active definitions target Standard Notes-owned infrastructure, stores, credentials, or repositories rather than Standard Red Notes resources.

| File | Upstream mutation target | Why it is disabled here |
| --- | --- | --- |
| `clipper.release.prod.yml` | Firefox AMO, Chrome Web Store extension `heapafmadojoodklnkhjanbinemaagok`, and `@standardnotes/clipper` GitHub releases | A web tag or manual dispatch can publish the official extension with upstream AMO, Chrome, and PAT credentials, without a clipper-specific release comparison. |
| `web.release.prod.yml` | `s3://app.standardnotes.com` with `--delete`, its CloudFront distribution, and an upstream Discord webhook | The workflow deploys to the official web application using long-lived AWS credentials and can delete remote objects. |
| `publish.yml` | npm packages, Docker Hub images `standardnotes/snjs` and `standardnotes/web` (including `latest`), and Standard Notes release commits | A push to `main` can publish official packages and mutable Docker tags using upstream PAT, Docker, npm, and GPG identities. Its dormant E2E jobs also name `standardnotes/server`. |
| `releases.notify.yml` | The repository selected by `RELEASES_EVENT_RECEIVING_REPO`, using event `releases-updated-event` | The target is an external upstream marketing/release repository selected by a secret and mutated with `CI_PAT_TOKEN`. |
| `ios.testflight.yml` | The Standard Notes App Store Connect application and TestFlight lane `ios testflight_beta` | This is an obsolete duplicate of the active split mobile release path and uses legacy interactive credentials, mutable wrapper actions, and upstream signing assets. |
| `git-sync.yml` | `standardnotes/app` to `standardnotes/internal-app`, including pull-request creation in the internal repository | Every pushed branch can synchronize into and open pull requests against Standard Notes' private repository using SSH and PAT credentials. |

## Requirements before deliberate re-enablement

A fork must satisfy all of these gates before moving any file back under `workflows/`:

- replace every repository, package scope, bucket, CDN distribution, store application or extension ID, image namespace, webhook, signing identity, and credential with a verified fork-owned target;
- use least-privilege, short-lived credentials where the provider supports them; do not restore broad PATs or long-lived cloud keys by default;
- pin every external action to an audited full commit SHA and register an exact, job-scoped action inventory;
- add package-specific source-impact and prior-artifact fingerprint comparison, explicit publication intent, an audited force reason, non-cancelling product concurrency, and retry-safe remote-state reconciliation;
- separate build and validation from publication, then bind exact artifact names, checksums, versions, architectures, package or bundle identifiers, and expected signing identities before any external mutation;
- register the publisher and its active-versus-disabled ownership in the release validator and repository release report, with mutation tests for credentials, target identities, permissions, and retry behavior.

Additional target-specific gates apply: browser-store publication needs fork-owned AMO and Chrome listings plus accepted-upload reconciliation; web deployment needs a fork-owned bucket/CDN, a reviewed deletion manifest, and rollback evidence; npm and Docker publication needs fork-owned namespaces, trusted publishing/provenance, and immutable version checks; TestFlight publication must use the current upload/distribute/submit lanes with exact App Store Connect build identity; repository sync and marketing dispatch need explicit destination allowlists and opt-in branch/event scopes.
