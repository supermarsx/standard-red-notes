/**
 * The commit THIS bundle was built from, compiled in by webpack.
 *
 * *** WHY THE BUNDLE CARRIES ITS OWN IDENTITY. *** The deployment publishes which
 * commit it is at `/.well-known/srn-deployment.json`, and that file is fetched
 * fresh on purpose — the service worker never serves it from a cache. So it
 * answers "what is the server serving NOW", which is not the same question as
 * "what is this tab running": a tab opened before a deploy, or one still served
 * by an older service worker's cache, goes on running the old bundle while the
 * marker beside it names the new one. Nothing in the page could tell the two
 * apart, and a stale shell presents as bug fixes that never arrive.
 *
 * The value is the build's `SRN_DEPLOY_REVISION` — the same argument the image
 * stamps its marker from — admitted by shape in the webpack config, so it is
 * forty lowercase hexadecimal characters or the empty string. Empty is a bundle
 * built without a revision (a local build), which is "cannot be compared" and
 * never "matches".
 *
 * *** IMPORTED BY THE ENTRY MODULE, ON PURPOSE. *** `index.ts` imports this so
 * that it is part of the entry chunk — the code that was loaded when the tab
 * was. Reached only from a lazy chunk it would be bundled into that chunk, which
 * a stale tab loads fresh, and would then name the new build.
 *
 * A `typeof` guard rather than a bare read: a build that does not define the
 * constant must degrade to "no revision" instead of throwing a ReferenceError at
 * module load and taking the importing screen down with it.
 */
declare const __SRN_BUILD_REVISION__: string | undefined

export const WebBuildRevision: string = typeof __SRN_BUILD_REVISION__ === 'string' ? __SRN_BUILD_REVISION__ : ''
