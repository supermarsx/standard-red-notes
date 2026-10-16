import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const instructions = (source) =>
  source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
const runtime = (path) =>
  instructions(read(path)).slice(instructions(read(path)).lastIndexOf("FROM "));

for (const path of ["app/Dockerfile", "server/Dockerfile"]) {
  test(`${path}: revision-only changes do not invalidate runtime setup or artifact ownership`, () => {
    const source = runtime(path);
    const identity = source.indexOf("ARG SRN_DEPLOY_REVISION");
    assert.ok(identity > 0);
    assert.ok(
      source.lastIndexOf("\nRUN ") < identity,
      "runtime setup must precede revision scope",
    );
    assert.ok(
      source.lastIndexOf("COPY --from=build") < identity,
      "built artifacts must precede revision scope",
    );
    assert.ok(source.indexOf("COPY --from=deployment-identity") > identity);
    assert.match(
      source,
      /COPY --from=deployment-identity --chown=0:0 --chmod=0444/,
    );
  });
}

test("web dependencies build before revision scope; the stamped bundle still builds cold with its portable-output check", () => {
  const source = instructions(read("app/Dockerfile"));
  const buildStage = source.slice(
    source.indexOf("FROM node:"),
    source.lastIndexOf("FROM "),
  );
  const dependencies = buildStage.indexOf(
    "RUN yarn workspaces foreach -pt --topological-dev --verbose -R --from @standardnotes/web --exclude @standardnotes/web run build",
  );
  const revision = buildStage.indexOf("ARG SRN_DEPLOY_REVISION");
  const web = buildStage.indexOf(
    'RUN SRN_DEPLOY_REVISION="${SRN_DEPLOY_REVISION}" yarn workspace @standardnotes/web build',
  );
  assert.ok(dependencies > 0 && dependencies < revision && revision < web);
  assert.doesNotMatch(buildStage.slice(dependencies), /--mount=type=cache/);
  assert.match(
    JSON.parse(read("app/packages/web/package.json")).scripts.build,
    /AssertPortableBundle\.mjs/,
  );
});

test("web artifacts are copied with their writable runtime owner instead of a recursive chown layer", () => {
  const source = runtime("app/Dockerfile");
  assert.match(
    source,
    /COPY --from=build --chown=nginx:nginx .*\/dist \/usr\/share\/nginx\/html/,
  );
  assert.match(source, /COPY --chown=nginx:nginx docker\/nginx\.conf/);
  assert.match(source, /COPY --chmod=0555 docker\/docker-entrypoint\.sh/);
  assert.doesNotMatch(source, /chown -R nginx/);
  assert.match(source, /RUN chown nginx:nginx \/usr\/share\/nginx\/html/);
  assert.match(source, /USER nginx/);
});
