# Mobile Fastlane lanes

Install the Xcode command-line tools and the locked Ruby bundle before using
these lanes:

```sh
xcode-select --install
bundle install
```

Production release automation deliberately separates signed artifact creation
from store publication. The repository workflows build and validate **both**
platforms, fan the APK, AAB, IPA, signed platform identities, and release
fingerprint into one checksummed artifact, and only then start either store
publisher.

The production iOS order is always `build_prod` -> `upload_prod` ->
`distribute_prod` -> `submit_prod`. Each publication lane consumes the exact
validated identity and only performs its named stage.

> [!CAUTION]
> Google Play and App Store Connect are independent systems; a mobile release
> is not transactional. Never publish one platform from a local rebuild. The
> workflows persist provider-specific intent evidence before the first upload
> and only resume the exact same run, commit, app identity, version/build,
> fingerprint, artifact hash, and byte size. If one store succeeds first, rerun
> the failed job in the same GitHub workflow run so it reconciles the original
> validated bytes.

The mobile workflows pin every external GitHub Action to a full upstream commit
SHA. The human release labels and their SHA mapping live in the `mobile`
release-packaging contract. iOS certificate access uses the runner's own
`ssh-agent`; the private key is loaded through standard input and the agent is
always stopped immediately after signing. The dedicated signing keychain is
locked and deleted before artifact inspection. Android signing material and App
Store API-key files are created with restrictive permissions only when needed
and removed by fail-closed cleanup steps.

The root workflow is the canonical publisher. The workflow under
`app/.github/workflows/mobile.release.prod.yml` is a noncanonical recovery path:
it has no push or tag trigger, requires an explicit confirmation, and hashes a
minimum-length operator audit reason into every store and GitHub release intent.

> [!WARNING]
> The recovery workflow is not an alternate automatic publisher. Use it only
> when the canonical monorepo workflow cannot be recovered. A new dispatch gets
> a new run identity and cannot adopt a provider upload or draft reserved by a
> previous run.

### Required production environment

Create a protected GitHub environment named `mobile-production` in every
repository that can run one of these workflows. Require production reviewers,
prevent self-review where supported, restrict deployment to protected `main`
and the canonical release-tag policy, and scope all production credentials to
that environment. Manual publication is accepted only from the fetched exact
`origin/main` head; a canonical tag is accepted only when its exact commit is
contained in protected `origin/main`. The recovery publisher accepts only an
exact `main`-head dispatch with confirmation and an audit reason containing at
least 20 non-whitespace characters.

The marker-bound GitHub draft is reserved before signing or store mutation.
Store intents, signed platform artifacts, and the checksummed fan-in payload
are retained for 30 days, so repository Actions retention policy must permit
that window. Recover by rerunning only the failed job and its dependent jobs in
the same run. Never use **rerun all jobs** or rebuild signed bytes under an
existing run/version/provider intent.

## iOS

### Build a signed production IPA

```sh
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
PACKAGE_VERSION=1.2.3 BUILD_NUMBER=123 bundle exec fastlane ios build_prod
```

`PACKAGE_VERSION` must be stable core SemVer with no prerelease, build metadata,
or leading-zero numeric identifiers. `BUILD_NUMBER` is the requested positive
numeric build input. The workflow extracts `CFBundleShortVersionString` and
`CFBundleVersion` from the built IPA, verifies the deep code signature and every
embedded Mach-O as device `arm64` without simulator slices, and carries the
identity evidence alongside the validated IPA. Production validation is fixed
to app bundle ID `com.standardnotes.standardnotes`, share-extension bundle ID
`com.standardnotes.standardnotes.Share-To-SN`, and Apple team `HKF9BXSN95`.
Both bundles must satisfy their designated requirements, entitlements, and
unexpired embedded App Store provisioning profiles. The signed leaf certificate
must occur in each profile's `DeveloperCertificates`; device/ad-hoc,
enterprise, and debug profiles are rejected. Host and extension must expose the
exact app group `group.com.standardnotes.standardnotes`, signed/profile
entitlements must agree, and their marketing/build versions must match. A
matching version string alone is never accepted as signing evidence.

`IOS_USES_NON_EXEMPT_ENCRYPTION` is a protected, operator-reviewed legal/export
classification and must be exactly `true` or `false`; the pipeline never infers
an exemption from source. A `true` classification also requires Apple's
reviewed `IOS_EXPORT_COMPLIANCE_CODE`. The production build embeds the approved
values, signature validation reads them back, and provider evidence must agree
before external TestFlight distribution. Legal/export owners remain
responsible for the classification and code.

### Upload a validated production IPA

```sh
IOS_IPA_PATH=/absolute/path/to/validated.ipa \
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
bundle exec fastlane ios upload_prod
```

This uploads the binary only. It skips submission and does not wait for build
processing, distribute testers, or submit App Store review metadata.

### Inspect exact App Store upload evidence

```sh
IOS_IPA_PATH=/absolute/path/to/validated.ipa \
APP_VERSION=1.2.3 BUILD_NUMBER=123 \
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
PROVIDER_EVIDENCE_PATH=/tmp/app-store.json \
bundle exec fastlane ios inspect_upload
```

The inspector authenticates directly to App Store Connect, resolves exactly one
app for `com.standardnotes.standardnotes`, and queries the exact iOS
`cfBundleShortVersionString` and `cfBundleVersion` through
`apps/{id}/buildUploads`. A successful result requires one `COMPLETE` upload and
one `COMPLETE` IPA `BuildUploadFile` whose file name, byte size, and source MD5
match the validated local IPA. It also resolves one processed Build and proves
the approved export-compliance state. Duplicate identities, malformed
`sourceFileChecksums.file` MD5 evidence, provider errors, and completed uploads
with different bytes fail closed.

### Distribute the validated existing beta build

```sh
APP_VERSION=1.2.3 BUILD_NUMBER=123 \
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
bundle exec fastlane ios distribute_prod
```

This waits for and distributes the exact uploaded build to the Public group,
including external tester notification and beta review.

### Submit the validated existing App Store build

```sh
APP_VERSION=1.2.3 BUILD_NUMBER=123 \
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
bundle exec fastlane ios submit_prod
```

The distribution and submission lanes never upload an IPA. `APP_VERSION` and
`BUILD_NUMBER` must come from the validated IPA's evidence files, not from the
fresh checkout or newly generated values.

> [!IMPORTANT]
> An App Store upload is resumable only when the same workflow run has a valid
> pre-upload intent artifact. If App Store Connect is still absent, the job
> retries the same IPA. If the exact `BuildUploadFile` is pending or complete,
> it waits for and verifies Apple’s MD5/size evidence without re-uploading. A
> provider identity without that same-run marker, or one that cannot expose
> exact binary evidence, is blocked for operator review. Distribution and
> submission have distinct durable 30-day intent markers.
> `inspect_distribution` proves exact Public-group membership and beta-review
> state; `inspect_submission` proves the exact App Store version, selected
> build, and review state. When the same run owns the distribution marker, an
> exact partial state containing Public-group membership XOR a beta-review
> submission is reconciled by creating only the missing relationship or
> submission. Partial state without that marker, duplicate/ambiguous state, or
> a rejected review remains fail-closed. Every stage revalidates the checksummed
> payload immediately before its one allowed reconciliation.

```sh
APP_VERSION=1.2.3 BUILD_NUMBER=123 \
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
PROVIDER_EVIDENCE_PATH=/tmp/testflight-distribution.json \
bundle exec fastlane ios inspect_distribution

APP_VERSION=1.2.3 BUILD_NUMBER=123 \
IOS_USES_NON_EXEMPT_ENCRYPTION='<operator-approved-true-or-false>' \
IOS_EXPORT_COMPLIANCE_CODE='<Apple-approved-code-or-empty>' \
PROVIDER_EVIDENCE_PATH=/tmp/app-store-submission.json \
bundle exec fastlane ios inspect_submission
```

### Development and maintenance lanes

```sh
bundle exec fastlane ios dev
bundle exec fastlane ios setup
bundle exec fastlane ios refresh_dsyms
```

## Android

### Build signed production AAB and APK artifacts

```sh
PACKAGE_VERSION=1.2.3 BUILD_NUMBER=123 bundle exec fastlane android build_prod
```

`BUILD_NUMBER` is a required positive integer. The lane fails before Gradle if
it is missing or malformed. `PACKAGE_VERSION` has the same stable core SemVer
rules as iOS and is checked before Gradle. The workflow then verifies
the fixed application ID `com.standardnotes`, the APK signature, the strict AAB
JAR signature, and complete normalized native-library
sets for `arm64-v8a` and `x86_64` in both the universal APK and AAB.
The same exact-set and symmetry proof covers the supported 32-bit
`armeabi-v7a` and `x86` ABIs, preserving the existing Android compatibility
matrix.

> [!IMPORTANT]
> Configure `EXPECTED_ANDROID_UPLOAD_CERT_SHA256` as a protected GitHub secret in
> both repositories/environments before enabling production publication. It is
> the normalized 64-hex SHA-256 fingerprint of the production **upload
> certificate** that signs the local APK and AAB. With Play App Signing, the
> distribution/app-signing leaf is a different key and must not be used here.
> Bootstrap the upload value from a separately authenticated certificate copy
> with two-person verification, never from the artifact being released. Track
> and review the Play app-signing lineage separately as provider/operator
> evidence. Upload-certificate rotation is a reviewed change: update the
> protected value in the same maintenance window and retain the audit record.
> The APK signer, AAB signer, and protected upload fingerprint must be identical.

### Publish a validated production AAB

```sh
ANDROID_AAB_PATH=/absolute/path/to/validated.aab \
bundle exec fastlane android publish_prod
```

The Google Play credential environment variable is required by the publish
lane and is intentionally absent from the build job.

### Inspect exact Google Play release evidence

```sh
ANDROID_VERSION_CODE=3004123 \
ANDROID_AAB_SHA256=<64-hex-digest> \
ANDROID_TRACK=beta \
PROVIDER_EVIDENCE_PATH=/tmp/google-play.json \
bundle exec fastlane android inspect_prod
```

The inspector creates an edit, reads `edits.bundles` and the `beta` track, then
deletes the edit. Google Play permits only one active edit per principal/app,
so this can invalidate another concurrent edit. Use a dedicated release service
account and prohibit concurrent Play edits for this app; this is provider-state
inspection, not a purely read-only operation. A successful result requires one
matching `versionCode`, the provider’s AAB SHA-256 matching the validated local
file, exactly one track release containing that code, and release status
`completed`.

> [!IMPORTANT]
> The workflow writes a same-run Google Play intent artifact after a clean
> preflight and before calling `publish_prod`. On rerun, provider absence causes
> the same AAB to be retried; exact digest and track evidence causes upload to be
> skipped; partial, duplicate, foreign-run, or mismatched evidence fails closed.

After both stores finish, GitHub publication follows the same rule. The workflow
adopts only the marker-bound draft reserved before store mutation, uploads the exact six-file
inventory, verifies every release-asset byte size and GitHub SHA-256 digest, and
publishes last. A retry of an already published prerelease is verification-only;
published assets are never clobbered.

### Development lane

```sh
bundle exec fastlane android dev
```

For Fastlane installation and command details, see the
[official Fastlane documentation](https://docs.fastlane.tools/).
