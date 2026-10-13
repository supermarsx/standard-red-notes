#!/usr/bin/env bash

# SNS/SQS bootstrap for the local AWS emulator. Historically written for
# LocalStack; it now runs under floci (floci/floci:*-compat), which executes
# the same /etc/localstack/init/ready.d hooks.
#
# Two modes, one topology. The topology below is written once and read in
# both modes, so the health check can never drift from what is created:
#
#   (no argument)  floci runs this as its ready hook on EVERY emulator start
#                  (SNS/SQS state is in-memory) and it creates every topic,
#                  queue, subscription and redrive policy. All calls are
#                  idempotent: re-running it changes nothing.
#   --check        the compose health check runs this. It creates nothing; it
#                  exits non-zero, naming the first thing missing, unless every
#                  topic, queue, subscription and the redrive policy exist. So
#                  "healthy" means "events can be delivered", not merely "the
#                  emulator answers HTTP".
#
# Speed is the point. floci kills the emulator when a ready hook outlives
# floci.init-hooks.timeout-seconds (30 s by default; compose raises it), and
# the restarted emulator starts with empty state and runs the hook again. Each
# `awslocal` call starts the Python AWS CLI (about 1.7 s on an idle host, far
# more on a loaded one), and the ~30 calls here overran 30 s on a loaded host:
# the emulator restart-looped forever while every container reported healthy
# and no event was ever delivered. The calls below speak the SNS/SQS Query
# API with plain curl instead: a few milliseconds each, about one second for
# the whole topology even under load, with no sleeps. Each call is bounded
# (connect/total timeouts) and retried a few times for a transient failure.

set -euo pipefail

BOOTSTRAP_MODE=create
if [[ "${1:-}" == "--check" ]]; then
  BOOTSTRAP_MODE=check
  # The topology body below narrates what it does on stdout; a health check
  # only reports what is missing (on stderr), so Docker's health log stays
  # readable.
  exec >/dev/null
fi

echo "configuring sns/sqs"
echo "==================="
LOCALSTACK_HOST=localhost
AWS_REGION=us-east-1
LOCALSTACK_DUMMY_ID=000000000000
EMULATOR_ENDPOINT="http://${LOCALSTACK_HOST}:4566/"

# One SNS or SQS Query API call. floci does not validate signatures, but the
# credential scope names the service, so routing never depends on guessing it
# from the action name. Parameters are passed as name=value and URL-encoded.
emulator_query() {
  local SERVICE=$1
  local API_VERSION=$2
  shift 2
  local FORM=(--data-urlencode "Version=${API_VERSION}")
  local PARAMETER
  for PARAMETER in "$@"; do
    FORM+=(--data-urlencode "${PARAMETER}")
  done
  local RETRY=(--retry 4 --retry-delay 1 --retry-connrefused --retry-max-time 20)
  if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
    # A health check reports the current state; Docker repeats it.
    RETRY=()
  fi
  curl --silent --show-error --fail-with-body \
    --connect-timeout 2 --max-time 5 "${RETRY[@]}" \
    -H "Authorization: AWS4-HMAC-SHA256 Credential=floci/20000101/${AWS_REGION}/${SERVICE}/aws4_request, SignedHeaders=host, Signature=0" \
    "${FORM[@]}" "${EMULATOR_ENDPOINT}"
}

sqs_query() {
  emulator_query sqs 2012-11-05 "$@"
}

sns_query() {
  emulator_query sns 2010-03-31 "$@"
}

# Report a missing piece of the topology and fail the health check.
check_failed() {
  echo "queue emulator not ready: $*" >&2
  return 1
}

get_all_queues() {
  sqs_query Action=ListQueues
}

get_all_topics() {
  sns_query Action=ListTopics
}

# Every subscription, following NextToken pages, one <member> per line.
get_all_subscriptions() {
  local NEXT_TOKEN=""
  local PAGE
  local TOKEN_PATTERN='<NextToken>([^<]+)</NextToken>'
  while :; do
    if [[ -n "${NEXT_TOKEN}" ]]; then
      PAGE=$(sns_query Action=ListSubscriptions "NextToken=${NEXT_TOKEN}")
    else
      PAGE=$(sns_query Action=ListSubscriptions)
    fi
    PAGE=${PAGE//$'\n'/}
    printf '%s\n' "${PAGE//<\/member>/$'\n'}"
    if [[ "${PAGE}" =~ ${TOKEN_PATTERN} ]]; then
      NEXT_TOKEN=${BASH_REMATCH[1]}
    else
      return 0
    fi
  done
}

if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
  # Read the emulator's state once; every check below looks it up here.
  EXISTING_QUEUES=$(get_all_queues)
  EXISTING_TOPICS=$(get_all_topics)
  EXISTING_SUBSCRIPTIONS=$(get_all_subscriptions)
fi

create_queue() {
  local QUEUE_NAME_TO_CREATE=$1
  if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
    [[ "${EXISTING_QUEUES}" == *"/${LOCALSTACK_DUMMY_ID}/${QUEUE_NAME_TO_CREATE}</QueueUrl>"* ]] ||
      check_failed "queue ${QUEUE_NAME_TO_CREATE} does not exist"
    return
  fi
  sqs_query Action=CreateQueue "QueueName=${QUEUE_NAME_TO_CREATE}"
}

create_topic() {
  local TOPIC_NAME_TO_CREATE=$1
  if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
    [[ "${EXISTING_TOPICS}" == *"<TopicArn>$(get_topic_arn_from_name "${TOPIC_NAME_TO_CREATE}")</TopicArn>"* ]] ||
      check_failed "topic ${TOPIC_NAME_TO_CREATE} does not exist"
    return
  fi
  sns_query Action=CreateTopic "Name=${TOPIC_NAME_TO_CREATE}"
}

check_subscription() {
  local TOPIC_ARN_TO_LINK=$1
  local QUEUE_ARN_TO_LINK=$2
  local MEMBER
  while IFS= read -r MEMBER; do
    if [[ "${MEMBER}" == *"<TopicArn>${TOPIC_ARN_TO_LINK}</TopicArn>"* &&
      "${MEMBER}" == *"<Endpoint>${QUEUE_ARN_TO_LINK}</Endpoint>"* ]]; then
      return 0
    fi
  done <<<"${EXISTING_SUBSCRIPTIONS}"
  check_failed "${QUEUE_ARN_TO_LINK} is not subscribed to ${TOPIC_ARN_TO_LINK}"
}

link_queue_and_topic() {
  local TOPIC_ARN_TO_LINK=$1
  local QUEUE_ARN_TO_LINK=$2
  if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
    check_subscription "${TOPIC_ARN_TO_LINK}" "${QUEUE_ARN_TO_LINK}"
    return
  fi
  sns_query Action=Subscribe "TopicArn=${TOPIC_ARN_TO_LINK}" Protocol=sqs "Endpoint=${QUEUE_ARN_TO_LINK}"
}

# Subscribe with an SNS FilterPolicy so the queue receives ONLY the listed
# event types (matched against the `event` message attribute every
# SNSDomainEventPublisher stamps). The policy is created by the same Subscribe
# call as the subscription, so the check only has to find the subscription.
link_queue_and_topic_filtered() {
  local TOPIC_ARN_TO_LINK=$1
  local QUEUE_ARN_TO_LINK=$2
  local FILTER_POLICY=$3
  if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
    check_subscription "${TOPIC_ARN_TO_LINK}" "${QUEUE_ARN_TO_LINK}"
    return
  fi
  sns_query Action=Subscribe "TopicArn=${TOPIC_ARN_TO_LINK}" Protocol=sqs "Endpoint=${QUEUE_ARN_TO_LINK}" \
    Attributes.entry.1.key=FilterPolicy "Attributes.entry.1.value=${FILTER_POLICY}"
}

# Point a queue's redrive policy at a dead-letter queue: a message the consumer
# refuses to acknowledge MAX_RECEIVE_COUNT times is parked there instead of
# being redelivered forever every visibility timeout.
set_queue_redrive_policy() {
  local QUEUE_URL_TO_CONFIGURE=$1
  local DEAD_LETTER_QUEUE_ARN=$2
  local MAX_RECEIVE_COUNT=$3
  local REDRIVE_POLICY
  REDRIVE_POLICY=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "${DEAD_LETTER_QUEUE_ARN}" "${MAX_RECEIVE_COUNT}")
  if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
    local ATTRIBUTES
    ATTRIBUTES=$(sqs_query Action=GetQueueAttributes "QueueUrl=${QUEUE_URL_TO_CONFIGURE}" AttributeName.1=RedrivePolicy)
    [[ "${ATTRIBUTES}" == *"${DEAD_LETTER_QUEUE_ARN}"* ]] ||
      check_failed "${QUEUE_URL_TO_CONFIGURE} has no redrive policy to ${DEAD_LETTER_QUEUE_ARN}"
    return
  fi
  sqs_query Action=SetQueueAttributes "QueueUrl=${QUEUE_URL_TO_CONFIGURE}" \
    Attribute.1.Name=RedrivePolicy "Attribute.1.Value=${REDRIVE_POLICY}"
}

get_queue_arn_from_name() {
  local QUEUE_NAME=$1
  echo "arn:aws:sqs:${AWS_REGION}:${LOCALSTACK_DUMMY_ID}:$QUEUE_NAME"
}

get_topic_arn_from_name() {
  local TOPIC_NAME=$1
  echo "arn:aws:sns:${AWS_REGION}:${LOCALSTACK_DUMMY_ID}:$TOPIC_NAME"
}

PAYMENTS_TOPIC_NAME="payments-local-topic"

echo "creating topic $PAYMENTS_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${PAYMENTS_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
PAYMENTS_TOPIC_ARN=$(get_topic_arn_from_name $PAYMENTS_TOPIC_NAME)

SYNCING_SERVER_TOPIC_NAME="syncing-server-local-topic"

echo "creating topic $SYNCING_SERVER_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${SYNCING_SERVER_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
SYNCING_SERVER_TOPIC_ARN=$(get_topic_arn_from_name $SYNCING_SERVER_TOPIC_NAME)

AUTH_TOPIC_NAME="auth-local-topic"

echo "creating topic $AUTH_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${AUTH_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
AUTH_TOPIC_ARN=$(get_topic_arn_from_name $AUTH_TOPIC_NAME)

# Credential-bearing Nextcloud requests use a dedicated topic. It is linked
# only to the syncing queue below; never add auth/files/websocket subscribers.
NEXTCLOUD_BACKUP_TOPIC_NAME="nextcloud-backup-local-topic"

echo "creating topic $NEXTCLOUD_BACKUP_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${NEXTCLOUD_BACKUP_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
NEXTCLOUD_BACKUP_TOPIC_ARN=$(get_topic_arn_from_name $NEXTCLOUD_BACKUP_TOPIC_NAME)

FILES_TOPIC_NAME="files-local-topic"

echo "creating topic $FILES_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${FILES_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
FILES_TOPIC_ARN=$(get_topic_arn_from_name $FILES_TOPIC_NAME)

ANALYTICS_TOPIC_NAME="analytics-local-topic"

echo "creating topic $ANALYTICS_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${ANALYTICS_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
ANALYTICS_TOPIC_ARN=$(get_topic_arn_from_name $ANALYTICS_TOPIC_NAME)

REVISIONS_TOPIC_NAME="revisions-server-local-topic"

echo "creating topic $REVISIONS_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${REVISIONS_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
REVISIONS_TOPIC_ARN=$(get_topic_arn_from_name $REVISIONS_TOPIC_NAME)

SCHEDULER_TOPIC_NAME="scheduler-local-topic"

echo "creating topic $SCHEDULER_TOPIC_NAME"
TOPIC_CREATED_RESULT=$(create_topic ${SCHEDULER_TOPIC_NAME})
echo "created topic: $TOPIC_CREATED_RESULT"
SCHEDULER_TOPIC_ARN=$(get_topic_arn_from_name $SCHEDULER_TOPIC_NAME)

QUEUE_NAME="analytics-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
ANALYTICS_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

echo "linking topic $PAYMENTS_TOPIC_ARN to queue $ANALYTICS_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $PAYMENTS_TOPIC_ARN $ANALYTICS_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

QUEUE_NAME="auth-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
AUTH_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

echo "linking topic $PAYMENTS_TOPIC_ARN to queue $AUTH_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $PAYMENTS_TOPIC_ARN $AUTH_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"
echo "linking topic $AUTH_TOPIC_ARN to queue $AUTH_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $AUTH_TOPIC_ARN $AUTH_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"
echo "linking topic $FILES_TOPIC_ARN to queue $AUTH_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $FILES_TOPIC_ARN $AUTH_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"
echo "linking topic $REVISIONS_TOPIC_ARN to queue $AUTH_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $REVISIONS_TOPIC_ARN $AUTH_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

QUEUE_NAME="files-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
FILES_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

echo "linking topic $AUTH_TOPIC_ARN to queue $FILES_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $AUTH_TOPIC_ARN $FILES_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $SYNCING_SERVER_TOPIC_ARN to queue $FILES_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $FILES_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

QUEUE_NAME="syncing-server-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
SYNCING_SERVER_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

echo "linking topic $SYNCING_SERVER_TOPIC_ARN to queue $SYNCING_SERVER_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $FILES_TOPIC_ARN to queue $SYNCING_SERVER_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $FILES_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $SYNCING_SERVER_TOPIC_ARN to queue $AUTH_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $AUTH_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $AUTH_TOPIC_ARN to queue $SYNCING_SERVER_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $AUTH_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $NEXTCLOUD_BACKUP_TOPIC_ARN to queue $SYNCING_SERVER_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $NEXTCLOUD_BACKUP_TOPIC_ARN $SYNCING_SERVER_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

QUEUE_NAME="revisions-server-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
REVISIONS_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

echo "linking topic $SYNCING_SERVER_TOPIC_ARN to queue $REVISIONS_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $SYNCING_SERVER_TOPIC_ARN $REVISIONS_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $REVISIONS_TOPIC_ARN to queue $REVISIONS_QUEUE_ARN"
LINKING_RESULT=$(link_queue_and_topic $REVISIONS_TOPIC_ARN $REVISIONS_QUEUE_ARN)
echo "linking done:"
echo "$LINKING_RESULT"

QUEUE_NAME="scheduler-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
SCHEDULER_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

# Queue consumed by the in-process websocket gateway (api-gateway). Subscribed
# to the syncing-server topic for WEB_SOCKET_MESSAGE_REQUESTED (item changes)
# and to the auth topic for shared-vault invites/messages, MFA and roles pushes
# and INVITE_REALTIME_INVALIDATION_REQUESTED. Both subscriptions carry a
# FilterPolicy: the gateway handles exactly these two event types, so the
# other ~36 types published on those topics no longer occupy its batches.
# Messages the gateway refuses to acknowledge (an invite event that fails the
# gateway-side validator) are parked in websocket-local-dlq after 5 receives
# instead of being redelivered forever.
WEBSOCKET_QUEUE_FILTER_POLICY='{"event":["WEB_SOCKET_MESSAGE_REQUESTED","INVITE_REALTIME_INVALIDATION_REQUESTED"]}'

QUEUE_NAME="websocket-local-dlq"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
WEBSOCKET_DLQ_ARN=$(get_queue_arn_from_name $QUEUE_NAME)

QUEUE_NAME="websocket-local-queue"

echo "creating queue $QUEUE_NAME"
QUEUE_URL=$(create_queue ${QUEUE_NAME})
echo "created queue: $QUEUE_URL"
WEBSOCKET_QUEUE_ARN=$(get_queue_arn_from_name $QUEUE_NAME)
WEBSOCKET_QUEUE_URL="http://${LOCALSTACK_HOST}:4566/${LOCALSTACK_DUMMY_ID}/${QUEUE_NAME}"

echo "setting redrive policy of queue $WEBSOCKET_QUEUE_ARN to $WEBSOCKET_DLQ_ARN (maxReceiveCount 5)"
REDRIVE_RESULT=$(set_queue_redrive_policy $WEBSOCKET_QUEUE_URL $WEBSOCKET_DLQ_ARN 5)
echo "redrive done:"
echo "$REDRIVE_RESULT"

echo "linking topic $SYNCING_SERVER_TOPIC_ARN to queue $WEBSOCKET_QUEUE_ARN (filtered: $WEBSOCKET_QUEUE_FILTER_POLICY)"
LINKING_RESULT=$(link_queue_and_topic_filtered $SYNCING_SERVER_TOPIC_ARN $WEBSOCKET_QUEUE_ARN "$WEBSOCKET_QUEUE_FILTER_POLICY")
echo "linking done:"
echo "$LINKING_RESULT"

echo "linking topic $AUTH_TOPIC_ARN to queue $WEBSOCKET_QUEUE_ARN (filtered: $WEBSOCKET_QUEUE_FILTER_POLICY)"
LINKING_RESULT=$(link_queue_and_topic_filtered $AUTH_TOPIC_ARN $WEBSOCKET_QUEUE_ARN "$WEBSOCKET_QUEUE_FILTER_POLICY")
echo "linking done:"
echo "$LINKING_RESULT"

if [[ "${BOOTSTRAP_MODE}" == "check" ]]; then
  exit 0
fi

echo "all topics are:"
echo "$(get_all_topics)"

echo "all queues are:"
echo "$(get_all_queues)"

echo "sns/sqs topology ready after ${SECONDS}s"
