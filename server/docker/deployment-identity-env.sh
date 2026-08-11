#!/usr/bin/env sh

# Project the operator's public deployment expectation into the api-gateway
# dotenv namespace. Direct API_GATEWAY_* injection is removed first, and the
# immutable marker path is selected in application code rather than from env.
unset API_GATEWAY_SRN_DEPLOY_REVISION
unset API_GATEWAY_SRN_DEPLOY_VERSION
unset API_GATEWAY_SRN_DEPLOY_MARKER_PATH
unset SRN_DEPLOY_MARKER_PATH

if [ "${#SRN_DEPLOY_REVISION}" -eq 40 ]; then
  case "${SRN_DEPLOY_REVISION}" in
    *[!0-9a-f]*) ;;
    *) export API_GATEWAY_SRN_DEPLOY_REVISION="${SRN_DEPLOY_REVISION}" ;;
  esac
fi

if [ -n "${SRN_DEPLOY_VERSION:-}" ] && [ "${#SRN_DEPLOY_VERSION}" -le 128 ]; then
  case "${SRN_DEPLOY_VERSION}" in
    [0-9A-Za-z]*[!0-9A-Za-z._+-]*) ;;
    [0-9A-Za-z]*) export API_GATEWAY_SRN_DEPLOY_VERSION="${SRN_DEPLOY_VERSION}" ;;
  esac
fi
