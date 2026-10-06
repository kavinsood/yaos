#!/bin/zsh
# Local streams relay for the client remake: `wrangler dev` (real workerd + local DO SQLite) with
# no R2, the same config as the deployed e2e worker (scripts/relay-dev/deploy.sh).
#
#   scripts/relay-dev/start-local.sh [--port 8787] [--fresh] [--var K=V]...
#
# Starts in the background (nohup; log at experiments/logs/client-e2e-local-<ts>.log), waits until
# /api/capabilities advertises streams=1, then prints the base URL as the last stdout line.
# State persists in experiments/logs/client-e2e-local-state; --fresh wipes it (a new, unclaimed server).
# Stop with scripts/relay-dev/stop-local.sh.
set -euo pipefail
EXP_ROOT=/Users/kavin/personal/obsidiansync/experiments
WT=${0:A:h:h:h}
PORT=8787
FRESH=0
typeset -a VARS
while (( $# )); do
  case $1 in
    --port) PORT=$2; shift 2;;
    --fresh) FRESH=1; shift;;
    --var) VARS+=("$2"); shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
LOGS=$EXP_ROOT/logs
STATE_DIR=$LOGS/client-e2e-local-state
PIDFILE=$LOGS/client-e2e-local.pid
PORTFILE=$LOGS/client-e2e-local.port
LOG=$LOGS/client-e2e-local-$(date -u +%Y%m%dT%H%M%SZ).log
TOML=$WT/server/wrangler.relay2-client-e2e-local.toml
mkdir -p $LOGS
if [[ -f $PIDFILE ]] && kill -0 $(<$PIDFILE) 2>/dev/null; then
  echo "already running (pid $(<$PIDFILE), port $(<$PORTFILE 2>/dev/null)); run stop-local.sh first" >&2
  exit 1
fi
(( FRESH )) && rm -rf $STATE_DIR
mkdir -p $STATE_DIR
source ${0:A:h}/config.sh
relay_dev_config yaos-relay2-client-e2e-local "${VARS[@]}" > $TOML
cd $WT/server
nohup ./node_modules/.bin/wrangler dev -c ${TOML:t} --ip 127.0.0.1 --port $PORT --persist-to $STATE_DIR \
  > $LOG 2>&1 < /dev/null &
print $! > $PIDFILE
print $PORT > $PORTFILE
URL=http://127.0.0.1:$PORT
for i in {1..180}; do
  if curl -sf "$URL/api/capabilities" 2>/dev/null | grep -q '"streams":1'; then
    echo "local relay ready after ${i}s (pid $(<$PIDFILE)); log $LOG" >&2
    print $URL
    exit 0
  fi
  kill -0 $(<$PIDFILE) 2>/dev/null || { echo "wrangler dev exited; tail of $LOG:" >&2; tail -20 $LOG >&2; rm -f $PIDFILE; exit 1; }
  sleep 1
done
echo "timed out waiting for $URL; see $LOG" >&2
exit 1
