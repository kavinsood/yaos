#!/bin/zsh
# Relay v2 spike deploy helper.
#
#   scripts/relay2/deploy.sh <name> [--relay on|off] [--var KEY=VALUE]... [--no-debug-routes] [--dry-run]
#        [--src <tree>] [--require-clean] [--r2 <bucket>]
#
# --r2 binds YAOS_BUCKET to <bucket> (the generated config strips [[r2_buckets]] by default, which leaves
# the recovery projection off); use it to exercise the RecoveryJob path on a deployed worker.
#
# --src deploys server/ from another checkout (e.g. a clean `git worktree add` at a pinned SHA) instead of
# this worktree; --require-clean aborts when server/src, server/scripts or server/vendor have uncommitted
# changes (use for full-n baseline/relay deploys so the recorded spikeSha is exactly what ran).
#
# <name> must start with "yaos-relay2-". Generates server/wrangler.relay2-<suffix>.toml (gitignored via
# .git/info/exclude) from experiments/wrangler.exp.template.toml after a drift check against
# server/wrangler.toml; if the template drifted, regenerates from server/wrangler.toml (name replaced,
# [[r2_buckets]] removed). Deploys with $WRANGLER, captures version id / bundle size / startup time into
# $EXP_ROOT/logs/relay2/deploy-<name>.json and polls /api/capabilities until 200.
#
# Knob policy: baseline and relay deploys must carry identical [vars] except YAOS_RELAY_BODIES. The default
# knob set is YAOS_TEST_ONLY_DEBUG_ROUTES=true (simulate-restart) + YAOS_ENABLE_ADMIN_ROUTES=true (debug/compact);
# everything else via --var.
set -euo pipefail
source /Users/kavin/personal/obsidiansync/experiments/env.sh
WT=${0:A:h:h:h}
NAME=${1:?usage: deploy.sh <yaos-relay2-name> [--relay on|off] [--var K=V]...}
shift
[[ $NAME == yaos-relay2-* ]] || { echo "worker name must start with yaos-relay2-" >&2; exit 2; }
RELAY=off
DEBUG_ROUTES=1
DRY=0
CLEAN=0
R2=
typeset -a VARS
while (( $# )); do
  case $1 in
    --relay) RELAY=$2; shift 2;;
    --var) VARS+=("$2"); shift 2;;
    --no-debug-routes) DEBUG_ROUTES=0; shift;;
    --dry-run) DRY=1; shift;;
    --src) WT=${2:A}; shift 2;;
    --require-clean) CLEAN=1; shift;;
    --r2) R2=$2; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
SUFFIX=${NAME#yaos-relay2-}
TOML=$WT/server/wrangler.relay2-$SUFFIX.toml
LOGDIR=$EXP_ROOT/logs/relay2
mkdir -p $LOGDIR
LOG=$LOGDIR/deploy-$NAME.log
JSON=$LOGDIR/deploy-$NAME.json
TEMPLATE=$EXP_ROOT/wrangler.exp.template.toml

exec > >(tee -a $LOG) 2>&1
echo "=== deploy $NAME $(date -u +%FT%TZ) relay=$RELAY"

# Drift check: template (minus name) vs server/wrangler.toml (minus name and r2 block).
normalize_base() { awk '
  !named && /^name = / {print "name = \"__NAME__\""; named=1; next}
  /^\[\[r2_buckets\]\]/ {skip=1; next}
  skip && /^\[/ {skip=0}
  skip {next}
  {print}' "$1" | awk 'NF{print;b=0;next} !b{print;b=1}'; }
BASE_NORM=$(normalize_base $WT/server/wrangler.toml)
TPL_NORM=$(awk 'NF{print;b=0;next} !b{print;b=1}' $TEMPLATE)
if [[ "$BASE_NORM" == "$TPL_NORM" ]]; then
  SOURCE=template
  CONFIG=$TPL_NORM
else
  diff <(print -r -- "$TPL_NORM") <(print -r -- "$BASE_NORM") || true
  echo "template drifted from server/wrangler.toml; regenerating from server/wrangler.toml"
  SOURCE=worktree-wrangler.toml
  CONFIG=$BASE_NORM
fi
CONFIG=${CONFIG//__NAME__/$NAME}

typeset -a ALLVARS
(( DEBUG_ROUTES )) && ALLVARS+=("YAOS_TEST_ONLY_DEBUG_ROUTES=true" "YAOS_ENABLE_ADMIN_ROUTES=true")
[[ $RELAY == on ]] && ALLVARS+=("YAOS_RELAY_BODIES=true")
ALLVARS+=("${VARS[@]}")
{
  print -r -- "$CONFIG"
  if [[ -n $R2 ]]; then
    print ""
    print "[[r2_buckets]]"
    print "binding = \"YAOS_BUCKET\""
    print -r -- "bucket_name = \"$R2\""
  fi
  if (( ${#ALLVARS} )); then
    print ""
    print "[vars]"
    for kv in "${ALLVARS[@]}"; do
      k=${kv%%=*}; v=${kv#*=}
      print -r -- "$k = \"$v\""
    done
  fi
} > $TOML
echo "config source=$SOURCE -> $TOML"
grep -A50 '^\[vars\]' $TOML || true

SPIKE_SHA=$(git -C $WT rev-parse HEAD)
DIRTY=$(git -C $WT status --porcelain -- server/src server/scripts server/vendor | wc -l | tr -d ' ')
echo "spike sha $SPIKE_SHA src $WT (dirty server files: $DIRTY)"
if (( CLEAN && DIRTY > 0 )); then echo "--require-clean: $WT has uncommitted server changes; refusing" >&2; exit 3; fi
(( DRY )) && { echo "dry run; not deploying"; exit 0; }

OUT=$LOGDIR/deploy-$NAME.wrangler.out
( cd $WT/server && $WRANGLER deploy -c ${TOML:t} ) 2>&1 | tee $OUT
VERSION=$(grep -Eo 'Current Version ID: [0-9a-f-]+' $OUT | tail -1 | awk '{print $4}')
UPLOAD=$(grep -Eo 'Total Upload: [0-9.]+ KiB / gzip: [0-9.]+ KiB' $OUT | tail -1)
RAW=$(print -r -- "$UPLOAD" | awk '{print $3}')
GZ=$(print -r -- "$UPLOAD" | awk '{print $7}')
STARTUP=$(grep -Eo 'Worker Startup Time: [0-9]+ ms' $OUT | tail -1 | awk '{print $4}')
URL=$(grep -Eo "https://$NAME\.[a-z0-9-]+\.workers\.dev" $OUT | tail -1)
[[ -n $URL ]] || URL=https://$NAME.kavinsood.workers.dev

VARS_JSON=$(for kv in "${ALLVARS[@]}"; do print -r -- "$kv"; done | node -e '
  const lines=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);
  console.log(JSON.stringify(Object.fromEntries(lines.map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1)]))));')
JSON_OUT=$JSON SRC_TREE=$WT node -e '
  const [name,url,relay,version,raw,gz,startup,sha,dirty,source,vars]=process.argv.slice(1);
  const out={workerName:name,host:url,relay:relay==="on",deploymentVersionId:version||null,
    bundle:{uploadKiB:raw?Number(raw):null,gzipKiB:gz?Number(gz):null},startupMs:startup?Number(startup):null,
    spikeSha:sha,srcTree:process.env.SRC_TREE,dirtyServerFiles:Number(dirty),configSource:source,vars:JSON.parse(vars),deployedAt:new Date().toISOString()};
  require("fs").writeFileSync(process.env.JSON_OUT,JSON.stringify(out,null,2)+"\n");console.log(JSON.stringify(out));' \
  $NAME $URL $RELAY "$VERSION" "$RAW" "$GZ" "$STARTUP" $SPIKE_SHA $DIRTY $SOURCE "$VARS_JSON"

echo "polling $URL/api/capabilities"
for i in {1..90}; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/capabilities?probe=$RANDOM" || true)
  if [[ $CODE == 200 ]]; then echo "capabilities 200 after ${i} polls"; break; fi
  sleep 2
done
[[ $CODE == 200 ]] || { echo "capabilities never returned 200 (last $CODE)" >&2; exit 1; }
curl -s -D - -o /dev/null "$URL/api/capabilities" | grep -i '^cf-ray' || true
echo "=== done $NAME"
