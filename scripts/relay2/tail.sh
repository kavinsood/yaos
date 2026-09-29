#!/bin/zsh
# Capture `wrangler tail --format json` for a relay2 worker into logs/relay2/tail-<worker>-<label>-<ts>.jsonl.
#   zsh scripts/relay2/tail.sh <yaos-relay2-name|url> [label]     (Ctrl-C / kill -INT to stop)
# bench.ts --tail does the same in-process (8 s warmup, 10 s drain). Join with scripts/relay2/analyze.py.
set -u
[[ $# -ge 1 ]] || { echo "usage: tail.sh <worker|url> [label]" >&2; exit 2; }
NAME=${1#https://}; NAME=${NAME%%.*}
[[ $NAME == yaos-relay2-* ]] || { echo "refusing: worker must start with yaos-relay2-" >&2; exit 2; }
LABEL=${2:-manual}
source /Users/kavin/personal/obsidiansync/experiments/env.sh 2>/dev/null || true
unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=261336883158b276696d7181091ba1a6
WRANGLER=${WRANGLER:-/Users/kavin/personal/obsidiansync/node_modules/.bin/wrangler}
OUT=/Users/kavin/personal/obsidiansync/experiments/logs/relay2/tail-$NAME-$LABEL-$(date -u +%Y-%m-%dT%H-%M-%S).jsonl
mkdir -p ${OUT:h}
echo "tail $NAME -> $OUT" >&2
exec $WRANGLER tail $NAME --format json > $OUT
