#!/bin/zsh
# Stops the local streams relay started by scripts/relay-dev/start-local.sh (state is kept;
# start-local.sh --fresh wipes it).
#
#   scripts/relay-dev/stop-local.sh [--port 8787]
set -uo pipefail
LOGS=/Users/kavin/personal/obsidiansync/experiments/logs
PORT=8787
[[ ${1:-} == --port ]] && PORT=$2
PIDFILE=$LOGS/client-e2e-local-$PORT.pid
if [[ -f $PIDFILE ]]; then
  PID=$(<$PIDFILE)
  if kill -0 $PID 2>/dev/null; then
    kill -TERM $PID 2>/dev/null
    for i in {1..20}; do kill -0 $PID 2>/dev/null || break; sleep 0.5; done
    kill -0 $PID 2>/dev/null && kill -KILL $PID 2>/dev/null
  fi
  rm -f $PIDFILE
fi
# workerd may outlive wrangler: free the port.
LEFT=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null || true)
[[ -n $LEFT ]] && kill -TERM ${(f)LEFT} 2>/dev/null
echo "stopped local relay (port $PORT)"
