# Quarantined upstream server workflows

These files are preserved as upstream source history, but they are intentionally disabled in this monorepo. GitHub only discovers workflows in the repository-root `.github/workflows/` directory, so the original `server/.github/workflows/` files were not independently runnable here. Moving the mutation-capable definitions out of that nested workflow directory makes their status explicit, prevents accidental activation by repository tooling or later extraction of the server subtree, and gives release checks a stable quarantine boundary.

## Quarantined inventory

| Workflow | Upstream target and mutation |
| --- | --- |
| `publish.yml` | On upstream `main`, builds/tests the server, calls `standardnotes/server` reusable workflows at mutable `@main` refs, publishes the self-hosting image, uses a PAT and GPG key to create signed release/version commits, and publishes server workspaces to npm with the upstream CI token. |
| `analytics.yml` | For `@standardnotes/analytics` tags or manual dispatch, inherits all secrets into `standardnotes/server/.github/workflows/common-server-application.yml@main`, which publishes `standardnotes/analytics` images to Docker Hub and Amazon ECR. |
| `api-gateway.yml` | For `@standardnotes/api-gateway` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/api-gateway` images to Docker Hub and Amazon ECR. |
| `auth.yml` | For `@standardnotes/auth-server` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/auth` images to Docker Hub and Amazon ECR. |
| `files.yml` | For `@standardnotes/files-server` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/files` images to Docker Hub and Amazon ECR. |
| `revisions.yml` | For `@standardnotes/revisions-server` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/revisions` images to Docker Hub and Amazon ECR. |
| `scheduler.yml` | For `@standardnotes/scheduler-server` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/scheduler` images to Docker Hub and Amazon ECR. |
| `syncing-server.yml` | For `@standardnotes/syncing-server` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/syncing-server-js` images to Docker Hub and Amazon ECR. |
| `websockets.yml` | For `@standardnotes/websockets-server` tags or manual dispatch, inherits all secrets into the mutable upstream reusable workflow, which publishes `standardnotes/websockets` images to Docker Hub and Amazon ECR. |
| `common-server-application.yml` | Reusable publishing coordinator that inherits Docker and AWS credentials into `standardnotes/server/.github/workflows/common-docker-image.yml@main`; its dormant deployment branches also target the mutable upstream ECS deployment workflow. |
| `common-deploy.yml` | Reads and rewrites an Amazon ECS production task definition, then deploys it to the upstream `prod` cluster and service using AWS credentials and the upstream ECR registry. |
| `common-docker-image.yml` | Logs in to Docker Hub and Amazon ECR, builds multi-architecture service images, and pushes mutable `latest` plus commit-SHA tags to both upstream registries. |
| `common-self-hosting.yml` | Logs in to Docker Hub and pushes multi-architecture `standardnotes/server:latest` and commit-SHA self-hosting images. |

The five nested test/support definitions remain in `server/.github/workflows/`: `pr.yml`, `e2e-test-suite.yml`, `e2e-self-hosted.yml`, `e2e-home-server.yml`, and `common-e2e.yml`. They build or test code and upload test artifacts; they do not publish packages, push images, deploy infrastructure, dispatch external repositories, or write releases. They remain upstream reference material and are still not repository-root workflows in this monorepo.

## Re-enable contract

Do not move any quarantined workflow back into a discoverable workflow directory until all of these gates are satisfied:

1. Replace every upstream credential, registry, repository, package scope, and deployment target with resources explicitly owned and documented by this fork.
2. Pin all actions and reusable workflows to reviewed immutable commit SHAs; do not inherit secrets into mutable branch refs.
3. Put each publish or deploy behind the monorepo's package-impact decision so unchanged packages cannot release automatically.
4. Reserve releases as drafts and implement identity-bound retry reconciliation before any asset replacement or final publication. Apply an equivalent idempotent preflight and recovery contract to npm, container registries, and deployment targets.
5. Add automated tests for target ownership, exact artifact/image inventories, signatures and checksums, retry behavior, and failure-safe cleanup.
6. Require an independent security and release review of the complete workflow diff and a passing release-contract gate before activation.

Until every gate is met, these files are documentation-only upstream artifacts and must remain quarantined.
