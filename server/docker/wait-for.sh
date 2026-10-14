#!/bin/sh
set -eu

WAIT_FOR_HOST="$1"
WAIT_FOR_PORT="$2"
shift 2

# Keep addresses and raw nc errors out of logs. Record the dependency role.
case "$WAIT_FOR_PORT" in
  3101) dependency=syncing ;;
  3103) dependency=auth ;;
  3104) dependency=files ;;
  3105) dependency=revisions ;;
  3306) dependency=database ;;
  6379) dependency=cache ;;
  *) dependency=dependency ;;
esac
elapsed=0
while ! nc -z "$WAIT_FOR_HOST" "$WAIT_FOR_PORT" >/dev/null 2>&1; do
  if [ "$elapsed" -eq 0 ] || [ $((elapsed % 30)) -eq 0 ]; then
    level=info
    [ "$elapsed" -lt 30 ] || level=warn
    printf '{"timestamp":"%s","level":"%s","message":"Waiting for %s listener (%ss elapsed).","event":"dependency.wait"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$dependency" "$elapsed"
  fi
  sleep 10
  elapsed=$((elapsed + 10))
done
printf '{"timestamp":"%s","level":"info","message":"%s listener ready (%ss waited).","event":"dependency.ready"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$dependency" "$elapsed"
