#!/usr/bin/env bash

# SNS/SQS bootstrap for the local AWS emulator. Historically written for
# LocalStack; it now runs unchanged under floci (floci/floci:*-compat), which
# executes the same /etc/localstack/init/ready.d hooks and ships awslocal.
# floci's SNS/SQS state is in-memory, so this runs on EVERY emulator start —
# all calls below are idempotent (create-queue/create-topic/subscribe).

set -euo pipefail

echo "configuring sns/sqs"
echo "==================="
LOCALSTACK_HOST=localhost
AWS_REGION=us-east-1
LOCALSTACK_DUMMY_ID=000000000000

get_all_queues() {
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sqs list-queues
}

create_queue() {
  local QUEUE_NAME_TO_CREATE=$1
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sqs create-queue --queue-name ${QUEUE_NAME_TO_CREATE}
}

get_all_topics() {
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sns list-topics
}

create_topic() {
  local TOPIC_NAME_TO_CREATE=$1
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sns create-topic --name ${TOPIC_NAME_TO_CREATE}
}

link_queue_and_topic() {
  local TOPIC_ARN_TO_LINK=$1
  local QUEUE_ARN_TO_LINK=$2
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sns subscribe --topic-arn ${TOPIC_ARN_TO_LINK} --protocol sqs --notification-endpoint ${QUEUE_ARN_TO_LINK}
}

# Subscribe with an SNS FilterPolicy so the queue receives ONLY the listed
# event types (matched against the `event` message attribute every
# SNSDomainEventPublisher stamps). Attribute values are JSON strings, hence the
# nested encoding.
link_queue_and_topic_filtered() {
  local TOPIC_ARN_TO_LINK=$1
  local QUEUE_ARN_TO_LINK=$2
  local FILTER_POLICY=$3
  local FILTER_POLICY_ATTRIBUTES
  FILTER_POLICY_ATTRIBUTES=$(printf '{"FilterPolicy":"%s"}' "${FILTER_POLICY//\"/\\\"}")
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sns subscribe --topic-arn ${TOPIC_ARN_TO_LINK} --protocol sqs --notification-endpoint ${QUEUE_ARN_TO_LINK} --attributes "${FILTER_POLICY_ATTRIBUTES}"
}

# Point a queue's redrive policy at a dead-letter queue: a message the consumer
# refuses to acknowledge MAX_RECEIVE_COUNT times is parked there instead of
# being redelivered forever every visibility timeout.
set_queue_redrive_policy() {
  local QUEUE_URL_TO_CONFIGURE=$1
  local DEAD_LETTER_QUEUE_ARN=$2
  local MAX_RECEIVE_COUNT=$3
  local REDRIVE_ATTRIBUTES
  REDRIVE_ATTRIBUTES=$(printf '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}"}' "${DEAD_LETTER_QUEUE_ARN}" "${MAX_RECEIVE_COUNT}")
  awslocal --endpoint-url=http://${LOCALSTACK_HOST}:4566 sqs set-queue-attributes --queue-url ${QUEUE_URL_TO_CONFIGURE} --attributes "${REDRIVE_ATTRIBUTES}"
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

echo "all topics are:"
echo "$(get_all_topics)"

echo "all queues are:"
echo "$(get_all_queues)"
