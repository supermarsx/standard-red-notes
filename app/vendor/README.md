# Embedded server source dependencies

The desktop application uses the published `@standardnotes/home-server@1.23.8`, with a Yarn patch that binds its listener to `127.0.0.1`. That release references eight package versions which were absent from npm when this update was prepared. These directories supply the corresponding real upstream source, not older packages relabelled as newer releases.

All eight packages come from Standard Notes server commit `a9646f0f9ccb190050292774f6ba47a785969963`, the published home-server release's `gitHead`: https://github.com/standardnotes/server/tree/a9646f0f9ccb190050292774f6ba47a785969963/packages . Each directory retains its AGPL license, original manifest, original source, and Git blob hashes. Fork package versions carry `-srn.1`; application resolutions select these local file packages explicitly. Workspace dependency references become the exact upstream versions from this cohort. Upstream runtime dependencies and source are otherwise unchanged.

| Package             | Upstream version |
| ------------------- | ---------------- |
| predicates          | 1.8.3            |
| security            | 1.17.5           |
| common              | 1.52.5           |
| time                | 1.19.2           |
| sncrypto-node       | 1.16.4           |
| domain-events       | 2.141.2          |
| grpc                | 1.4.3            |
| domain-events-infra | 1.23.5           |

## Verify and rebuild

From `app`, after installing the locked application dependencies:

```
node vendor/build-upstream.cjs --verify
node vendor/build-upstream.cjs --check
node --test vendor/runtime.test.cjs
node vendor/build-upstream.cjs
```

The build checks all original source blobs and license hashes before compiling with the application's pinned TypeScript compiler. It resolves the eight packages against this matching local cohort, and other runtime types against the installed desktop dependency tree. Build declarations come from the locked desktop development dependencies. Explicit `esModuleInterop: false` preserves upstream CommonJS emission under TypeScript 6. Tests are excluded from production output. The gRPC JavaScript and declarations are already generated and checked into the upstream commit; they are verified rather than regenerated with an unrelated protoc release.

Compiled output is committed so clean installs do not need to build a server monorepo. After changing output, refresh Yarn's local file dependencies and lockfile, then run desktop tests including `homeServerNetwork.spec.ts`. The fork manifests intentionally retain upstream's declared Node engine range; deployment on newer Node/Electron requires the application's integration checks, not a claim that upstream supported those versions.

For future TypeScript source fixes, leave original files immutable and add an entry to `source-patches.json` with `path` (for example `security/src/Domain/Encoder/TokenEncoder.ts`), `before`, and `after`. The compiler applies these exact replacements in memory and rejects a patch unless it matches exactly once. Review the patch with a regression test, rebuild, review `artifacts.json`, and refresh file dependencies. Generated gRPC changes require regenerating from a new verified upstream cohort; the TypeScript patch mechanism does not rewrite its generated JavaScript. Do not silently update source hashes or substitute a published older dependency. Updating the upstream cohort requires a new immutable revision, manifest/dependency census, source verification, rebuild, desktop checks, and confirmation that the embedded listener remains loopback-only.
