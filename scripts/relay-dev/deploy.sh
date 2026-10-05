#!/bin/zsh
# Deploy the client-remake streams relay as a real Worker (default name yaos-relay2-client-e2e).
#
#   scripts/relay-dev/deploy.sh [<yaos-relay2-name>] [--var K=V]... [--dry-run]
#
# Config: scripts/relay-dev/config.sh (server/wrangler.toml, name replaced, no R2, YAOS_STREAMS=true) written
# to server/wrangler.relay2-<suffix>.toml (git-excluded). Credentials: the `cf` CLI OAuth session, fed to
# wrangler through scripts/relay2/cf-cred.sh (never printed).
# The account sits at the Durable Object namespace cap (500; each worker = 3; CF error 10067), so a new name fails
# until namespaces are freed. Like scripts/relay2/runfast.sh --reuse-pool, redeploy onto an idle yaos-relay2-*
# worker instead (same script + classes = same namespaces); the client e2e target is yaos-relay2-scratch-3.
# Output goes to $EXP_ROOT/logs/client-e2e-deploy-<name>-<ts>.log; the URL is printed after
# /api/capabilities reports "streams":1.
set -euo pipefail
source /Users/kavin/personal/obsidiansync/experiments/env.sh
source ${0:A:h}/config.sh
WT=$RELAY_DEV_WT
NAME=yaos-relay2-client-e2e
if (( $# )) && [[ $1 != --* ]]; then NAME=$1; shift; fi
[[ $NAME == yaos-relay2-* ]] || { echo "worker name must start with yaos-relay2-" >&2; exit 2; }
DRY=0
typeset -a VARS
while (( $# )); do
  case $1 in
    --var) VARS+=("$2"); shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
TOML=wrangler.relay2-${NAME#yaos-relay2-}.toml
mkdir -p $EXP_ROOT/logs
LOG=$EXP_ROOT/logs/client-e2e-deploy-$NAME-$(date -u +%Y%m%dT%H%M%SZ).log
exec > >(tee -a $LOG) 2>&1
echo "=== deploy $NAME $(date -u +%FT%TZ) sha $(git -C $WT rev-parse --short HEAD) log $LOG"
relay_dev_config $NAME "${VARS[@]}" > $WT/server/$TOML
grep -A20 '^\[vars\]' $WT/server/$TOML
(( DRY )) && { echo "dry run; not deploying"; exit 0; }

source $WT/scripts/relay2/cf-cred.sh
cd $WT/server
# `cf deploy` (tried first per the experiment rules) refuses to run here: it delegates to wrangler >= 4.136 in
# server/node_modules and server/ pins 4.69, and it has no flag for a non-default config file. Deploy with
# wrangler, authenticated as the cf CLI session.
${WRANGLER:-./node_modules/.bin/wrangler} deploy -c $TOML
URL=https://$NAME.kavinsood.workers.dev
echo "polling $URL/api/capabilities"
for i in {1..90}; do
  BODY=$(curl -s "$URL/api/capabilities?probe=$RANDOM" || true)
  [[ $BODY == *'"streams":1'* ]] && { echo "streams capability live after $i polls"; break; }
  sleep 2
done
[[ $BODY == *'"streams":1'* ]] || { echo "capabilities never reported streams (last: ${BODY:0:200})" >&2; exit 1; }
echo "=== deployed $URL"
