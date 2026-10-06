#!/bin/zsh
# Deploy the client-remake streams relay as a real Worker (default name yaos-relay2-client-e2e).
#
#   scripts/relay-dev/deploy.sh [<yaos-relay2-name>] [--var K=V]... [--dry-run]
#
# Config: scripts/relay-dev/config.sh (server/wrangler.toml, name replaced, no R2, YAOS_STREAMS=true) written
# to server/wrangler.relay2-<suffix>.toml (git-excluded; the same file start-local.sh feeds `wrangler dev`),
# then rendered by cf-config.mjs as a cf project in server/.cf-deploy/<suffix>/ (gitignored).
#
# Deploys with `cf deploy`, authenticated as the cf CLI OAuth session (`cf auth login`); no API token is read,
# printed or exported (CLOUDFLARE_API_TOKEN is unset so cf uses its own session). cf builds by delegating to
# a project-local wrangler >= 4.136 (`cf-wrangler build`); server/ pins wrangler 4.69 for local dev and the
# tests, so the deploy toolchain is pinned separately in scripts/relay-dev/cf-deploy/ (npm ci on first use).
# cf configs declare Durable Objects as an `exports` lifecycle instead of [[migrations]]; the upload API
# reconciles it against a redeployed worker's classes (same classes = same namespaces, data kept).
#
# A new name creates 3 Durable Object namespaces. If the account is at the namespace cap (CF error 10067),
# redeploy over an idle yaos-relay2-* worker with the same classes (VaultSyncServer, ServerConfig,
# RecoveryJob) instead. Never deploy over yaos-relay2-scratch-3 (owned by another session).
# Output goes to $EXP_ROOT/logs/client-e2e-deploy-<name>-<ts>.log; the URL is printed after
# /api/capabilities reports "streams":1.
set -euo pipefail
source /Users/kavin/personal/obsidiansync/experiments/env.sh
source ${0:A:h}/config.sh
WT=$RELAY_DEV_WT
TOOLS=${0:A:h}/cf-deploy
NAME=yaos-relay2-client-e2e
if (( $# )) && [[ $1 != --* ]]; then NAME=$1; shift; fi
[[ $NAME == yaos-relay2-* ]] || { echo "worker name must start with yaos-relay2-" >&2; exit 2; }
[[ $NAME == yaos-relay2-scratch-3 ]] && { echo "yaos-relay2-scratch-3 belongs to another session" >&2; exit 2; }
DRY=0
typeset -a VARS
while (( $# )); do
  case $1 in
    --var) VARS+=("$2"); shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
SUFFIX=${NAME#yaos-relay2-}
TOML=wrangler.relay2-$SUFFIX.toml
PROJ=$WT/server/.cf-deploy/$SUFFIX
mkdir -p $EXP_ROOT/logs
LOG=$EXP_ROOT/logs/client-e2e-deploy-$NAME-$(date -u +%Y%m%dT%H%M%SZ).log
exec > >(tee -a $LOG) 2>&1
echo "=== deploy $NAME $(date -u +%FT%TZ) sha $(git -C $WT rev-parse --short HEAD) log $LOG"
relay_dev_config $NAME "${VARS[@]}" > $WT/server/$TOML
grep -A20 '^\[vars\]' $WT/server/$TOML

[[ -x $TOOLS/node_modules/.bin/wrangler && -x $TOOLS/node_modules/.bin/cf ]] || (cd $TOOLS && npm ci --no-audit --no-fund)
rm -rf $PROJ
node ${0:A:h}/cf-config.mjs $WT/server/$TOML $PROJ
cp $TOOLS/package.json $PROJ/package.json
ln -s $TOOLS/node_modules $PROJ/node_modules

unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
cf auth whoami >/dev/null 2>&1 || { echo "the cf CLI is not logged in; run \`cf auth login\`" >&2; exit 1; }
cd $PROJ
export CF_QUIET=1 NO_COLOR=1
if (( DRY )); then cf deploy --dry-run; echo "dry run; not deploying"; exit 0; fi
if ! cf deploy --message "relay-dev $(git -C $WT rev-parse --short HEAD)"; then
  echo "cf deploy failed. On CF error 10067 (Durable Object namespace cap) rerun with the name of an idle" >&2
  echo "yaos-relay2-* worker that has the same classes (never yaos-relay2-scratch-3)." >&2
  exit 1
fi
URL=https://$NAME.kavinsood.workers.dev
echo "polling $URL/api/capabilities"
for i in {1..90}; do
  BODY=$(curl -s "$URL/api/capabilities?probe=$RANDOM" || true)
  [[ $BODY == *'"streams":1'* ]] && { echo "streams capability live after $i polls"; break; }
  sleep 2
done
[[ $BODY == *'"streams":1'* ]] || { echo "capabilities never reported streams (last: ${BODY:0:200})" >&2; exit 1; }
echo "=== deployed $URL"
