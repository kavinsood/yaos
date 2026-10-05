#!/bin/zsh
# Stops the local streams relay started by scripts/relay-dev/start-local.sh (state is kept;
# start-local.sh --fresh wipes it).
set -uo pipefail
LOGS=/Users/kavin/personal/obsidiansync/experiments/logs
PIDFILE=$LOGS/client-e2e-local.pid
PORTFILE=$LOGS/client-e2e-local.port
PORT=$(<$PORTFILE 2>/dev/null || print 8787)
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
