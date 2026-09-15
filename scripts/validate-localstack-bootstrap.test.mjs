import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = "server/docker/localstack_bootstrap.sh";

function readBootstrap() {
  return readFileSync(resolve(repositoryRoot, bootstrapPath), "utf8");
}

/**
 * The realtime push path is a queue wiring problem, and it fails silently. If
 * the websocket queue loses a subscription the gateway simply stops seeing that
 * class of event; if it gains an unfiltered one the gateway's batches fill with
 * the ~36 other event types those topics publish; if the redrive policy goes
 * away a message the gateway refuses is redelivered forever. None of that
 * breaks a build, so it is asserted here instead.
 */
function websocketQueueWiring(source) {
  const filterPolicy =
    /^WEBSOCKET_QUEUE_FILTER_POLICY='([^']+)'$/m.exec(source)?.[1];
  const links = [
    ...source.matchAll(
      /^LINKING_RESULT=\$\(link_queue_and_topic_filtered \$(\w+) \$WEBSOCKET_QUEUE_ARN "\$(\w+)"\)$/gm,
    ),
  ].map((match) => ({ topic: match[1], policy: match[2] }));
  const unfiltered = [
    ...source.matchAll(
      /^LINKING_RESULT=\$\(link_queue_and_topic \$(\w+) \$WEBSOCKET_QUEUE_ARN\)$/gm,
    ),
  ].map((match) => match[1]);
  const redrive =
    /^REDRIVE_RESULT=\$\(set_queue_redrive_policy \$WEBSOCKET_QUEUE_URL \$(\w+) (\d+)\)$/m.exec(
      source,
    );

  return {
    filterPolicy,
    links,
    unfiltered,
    redrive: redrive
      ? { deadLetterArn: redrive[1], maxReceiveCount: Number(redrive[2]) }
      : undefined,
    createsDeadLetterQueue: /^QUEUE_NAME="websocket-local-dlq"$/m.test(source),
  };
}

test("the websocket queue is linked to exactly the syncing-server and auth topics", () => {
  const wiring = websocketQueueWiring(readBootstrap());

  assert.deepEqual(
    wiring.links.map((link) => link.topic).sort(),
    ["AUTH_TOPIC_ARN", "SYNCING_SERVER_TOPIC_ARN"],
  );
  // An unfiltered subscription would defeat the filter policy entirely.
  assert.deepEqual(wiring.unfiltered, []);
});

test("every websocket queue subscription carries the two-event filter policy", () => {
  const wiring = websocketQueueWiring(readBootstrap());

  assert.equal(
    wiring.filterPolicy,
    '{"event":["WEB_SOCKET_MESSAGE_REQUESTED","INVITE_REALTIME_INVALIDATION_REQUESTED"]}',
  );
  for (const link of wiring.links) {
    assert.equal(link.policy, "WEBSOCKET_QUEUE_FILTER_POLICY");
  }
});

test("the websocket queue parks poison messages in a dead-letter queue", () => {
  const wiring = websocketQueueWiring(readBootstrap());

  assert.ok(
    wiring.createsDeadLetterQueue,
    "websocket-local-dlq must be created before the redrive policy references it",
  );
  assert.deepEqual(wiring.redrive, {
    deadLetterArn: "WEBSOCKET_DLQ_ARN",
    maxReceiveCount: 5,
  });
});

test("the wiring assertions reject a bootstrap that drops the guarantees", () => {
  // The parser has to actually detect each regression, otherwise the three
  // tests above would pass against a bootstrap that no longer wires anything.
  const source = readBootstrap();

  const unfiltered = source.replace(
    'LINKING_RESULT=$(link_queue_and_topic_filtered $AUTH_TOPIC_ARN $WEBSOCKET_QUEUE_ARN "$WEBSOCKET_QUEUE_FILTER_POLICY")',
    "LINKING_RESULT=$(link_queue_and_topic $AUTH_TOPIC_ARN $WEBSOCKET_QUEUE_ARN)",
  );
  assert.notEqual(unfiltered, source);
  const unfilteredWiring = websocketQueueWiring(unfiltered);
  assert.deepEqual(unfilteredWiring.links.map((link) => link.topic), [
    "SYNCING_SERVER_TOPIC_ARN",
  ]);
  assert.deepEqual(unfilteredWiring.unfiltered, ["AUTH_TOPIC_ARN"]);

  const widened = source.replace(
    '"INVITE_REALTIME_INVALIDATION_REQUESTED"]}',
    '"INVITE_REALTIME_INVALIDATION_REQUESTED","USER_REGISTERED"]}',
  );
  assert.notEqual(widened, source);
  assert.notEqual(
    websocketQueueWiring(widened).filterPolicy,
    websocketQueueWiring(source).filterPolicy,
  );

  const noRedrive = source.replace(
    "REDRIVE_RESULT=$(set_queue_redrive_policy $WEBSOCKET_QUEUE_URL $WEBSOCKET_DLQ_ARN 5)",
    "REDRIVE_RESULT=skipped",
  );
  assert.notEqual(noRedrive, source);
  assert.equal(websocketQueueWiring(noRedrive).redrive, undefined);
});
