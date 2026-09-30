#!/bin/zsh
# Relay v2 full-run orchestrator (brief §6/§7/§8.2). Resumable: every step writes one JSON into $RAW and is
# skipped when that JSON already exists without an "error" key. Never launched automatically.
#
#   zsh scripts/relay2/runall.sh --sha <commit> [--tag <tag>] [--only g-lat,g-mb] [--dry-run] [--small]
#
#   --sha    clean spike commit. A detached worktree is created at
#            $EXP_ROOT/yaos-relay2-run-<sha8> (node_modules symlinked per brief §3.1). Every deploy is built from it
#            with --src <tree> --require-clean, and the harness runs from it (RELAY2_WORKTREE), so the spikeSha
#            recorded in each JSON is exactly what ran.
#   --tag    worker-name / run tag (default r<MMDD>). Workers are yaos-relay2-<tag>-<group>-<variant>. Use a fresh tag
#            for a fresh set of vaults.
#   --only   comma-separated groups (default all, in the order below).
#   --small  smoke mode: tiny n for every scenario, outputs to logs/relay2/runall-<tag>-small/raw (never mixed
#            with full results).
#   --dry-run print the plan (deploys + commands) without doing anything.
#
# Groups (base/relay pairs, identical [vars] except YAOS_RELAY_BODIES unless noted):
#   g-lat    L1 L2 L3 L4 L6 L7, L5 (real VaultSync; burst 1 and burst 8), C6 (bundle/startup)
#   g-cpu    C1 (--tail), C2 quick (--tail), C4, C5 (gql windows)
#   g-stress C2 stress trace (50k edits, 5 writers)
#   g-mem    C3 on a fresh deploy (the worker is re-deployed right before C3 so the isolate/DO are clean)
#   g-beh    B1 B2 B3 B4 B6 B7 B8, CW (invariant #7)
#   g-b5     B5 lease race + K2 upload via scripts/relay2/reset/b5.ts (relay only)
#   g-x1..x4 X1 (to 2000 sockets), X2, X3 (--tail, 3 repeats), X4 — one fresh vault pair each
#   g-k1     K1 compact on checkpoint-knob workers (CHECKPOINT_ENTRIES/BYTES/MAX_ROWS raised; differs by design)
#            + K1 alarm on a default-knob relay worker
#   g-mb     MB sweep: base, relay mb0 (adapters relay and relay-nocand), relay YAOS_RELAY_MICROBATCH_MS=10/50/100/250
#            (values above the deployed cap are recorded as "clamped" in the JSON)
#   final    gql backfill (scripts/relay2/gqlfill.ts) + convergence suite summary (scripts/relay2/convergence.ts → $RAW/convergence-suite.json)
#
# Latency scenarios run strictly one at a time; within each pair the order alternates (base first on even steps,
# relay first on odd) and every choice is appended to $RAW/runall-manifest.jsonl with start/end/status.
set -uo pipefail
EXP=/Users/kavin/personal/obsidiansync/experiments
MAIN=$EXP/yaos-relay2
source $EXP/env.sh

SHA="" TAG="r$(date +%m%d)" ONLY="" DRY=0 SMALL=0
while (( $# )); do
  case $1 in
    --sha) SHA=$2; shift 2;;
    --tag) TAG=$2; shift 2;;
    --only) ONLY=$2; shift 2;;
    --dry-run) DRY=1; shift;;
    --small) SMALL=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[[ -n $SHA ]] || { echo "usage: runall.sh --sha <commit> [--tag t] [--only groups] [--dry-run] [--small]" >&2; exit 2; }
SHA=$(git -C $MAIN rev-parse --verify "$SHA^{commit}") || exit 2
TREE=$EXP/yaos-relay2-run-${SHA[1,8]}
if (( SMALL )); then
  RAW=$EXP/logs/relay2/runall-$TAG-small/raw; LOGS=$EXP/logs/relay2/runall-$TAG-small
else
  RAW=$EXP/results/relay2/raw; LOGS=$EXP/logs/relay2/runall-$TAG
fi
MANIFEST=$RAW/runall-manifest.jsonl
mkdir -p $RAW $LOGS
COMMON_VARS=(--var YAOS_RELAY_RESET_COOLDOWN_MS=0)
K1_VARS=(--var YAOS_RELAY_CHECKPOINT_ENTRIES=1000000 --var YAOS_RELAY_CHECKPOINT_BYTES=1073741824 --var YAOS_RELAY_CHECKPOINT_MAX_ROWS=100000)
STEP=0

say() { print -r -- "[runall $(date -u +%H:%M:%S)] $*" | tee -a $LOGS/runall.log; }
want() { [[ -z $ONLY || ",$ONLY," == *",$1,"* ]]; }
host() { print -r -- "https://yaos-relay2-$TAG-$1.kavinsood.workers.dev"; }
n() { (( SMALL )) && print -r -- $2 || print -r -- $1; }   # n <full> <small>
manifest() { print -r -- "$1" >> $MANIFEST; }

prepare_tree() {
  if [[ ! -d $TREE ]]; then
    say "worktree $TREE @ $SHA"
    (( DRY )) && return 0
    git -C $MAIN worktree add --detach $TREE $SHA || exit 1
  fi
  (( DRY )) && return 0
  [[ $(git -C $TREE rev-parse HEAD) == $SHA ]] || { say "tree $TREE is not at $SHA"; exit 1; }
  [[ -z $(git -C $TREE status --porcelain -- server/src server/scripts server/vendor src scripts/relay2) ]] || { say "tree $TREE is dirty"; exit 1; }
  [[ -e $TREE/node_modules ]] || ln -s ../../yaos/node_modules $TREE/node_modules
  [[ -e $TREE/server/node_modules ]] || ln -s ../../../yaos/server/node_modules $TREE/server/node_modules
  if [[ -d $EXP/../yaos/packages/cli/node_modules && ! -e $TREE/packages/cli/node_modules ]]; then
    ln -s ../../../../yaos/packages/cli/node_modules $TREE/packages/cli/node_modules
  fi
}

# deploy <suffix> <relay on|off> [extra --var ...]; skipped if the deploy record matches SHA + vars.
deploy() {
  local suffix=$1 relay=$2; shift 2
  local name=yaos-relay2-$TAG-$suffix rec=$EXP/logs/relay2/deploy-yaos-relay2-$TAG-$suffix.json
  local want_vars="${(j: :)@} ${(j: :)COMMON_VARS}"
  if [[ ${FORCE_DEPLOY:-0} == 0 && -f $rec ]] && grep -q "\"spikeSha\": \"$SHA\"" $rec && grep -q "\"dirtyServerFiles\": 0" $rec; then
    local ok=1 kv
    for kv in ${${(M)@:#*=*}} ${${(M)COMMON_VARS:#*=*}}; do grep -q "\"${kv%%=*}\": \"${kv#*=}\"" $rec || ok=0; done
    if (( ok )); then say "deploy $name: up to date"; return 0; fi
  fi
  say "deploy $name relay=$relay $want_vars"
  (( DRY )) && return 0
  zsh $TREE/scripts/relay2/deploy.sh $name --relay $relay "${COMMON_VARS[@]}" "$@" --src $TREE --require-clean > $LOGS/deploy-$suffix.log 2>&1 \
    || { say "DEPLOY FAILED $name (see $LOGS/deploy-$suffix.log)"; return 1; }
  manifest "{\"event\":\"deploy\",\"worker\":\"$name\",\"relay\":\"$relay\",\"sha\":\"$SHA\",\"at\":\"$(date -u +%FT%TZ)\"}"
}

context() {
  local suffix=$1 ctx=$EXP/logs/relay2/context-yaos-relay2-$TAG-$1.json
  [[ -f $ctx ]] && return 0
  say "context $suffix (claim + standard seed)"
  (( DRY )) && return 0
  # A just-deployed worker can answer the claim with 503 for a few seconds after capabilities is already 200.
  local attempt
  for attempt in 1 2 3 4; do
    (cd $TREE && RELAY2_WORKTREE=$TREE node tests/run-typescript.mjs --test-aliases scripts/relay2/context.ts --host $(host $suffix) --devices A,B,C --seed standard) \
      >> $LOGS/context-$suffix.log 2>&1 && return 0
    say "context $suffix attempt $attempt failed; retry in 20 s"; sleep 20
  done
  say "CONTEXT FAILED $suffix"; return 1
}

setup() { deploy "$@" && context $1; }

done_json() { [[ -f $1 ]] && ! grep -q '^  "error":' $1; }

# run <out-id> <log-id> <cmd...>: skip when $RAW/<out-id>.json exists (no error); records manifest.
run() {
  local id=$1; shift
  local out=$RAW/$id.json
  if done_json $out; then say "skip $id (exists)"; return 0; fi
  say "run $id: $*"
  (( DRY )) && return 0
  local t0=$(date -u +%FT%TZ)
  (cd $TREE && RELAY2_WORKTREE=$TREE "$@" --out $out) > $LOGS/$id.log 2>&1
  local rc=$?
  manifest "{\"event\":\"run\",\"id\":\"$id\",\"rc\":$rc,\"start\":\"$t0\",\"end\":\"$(date -u +%FT%TZ)\"}"
  (( rc == 0 )) || say "FAILED $id rc=$rc (see $LOGS/$id.log)"
  return 0
}

BENCH=(node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts)
L5=(node tests/run-typescript.mjs --test-aliases scripts/relay2/l5-cli-baseline.ts)

# pair <scenario-id> <group> <args...>: base + relay on <group>-base / <group>-relay, alternating order.
pair() {
  local id=$1 group=$2; shift 2
  local first=base second=relay
  (( STEP % 2 == 1 )) && { first=relay; second=base; }
  STEP=$(( STEP + 1 ))
  manifest "{\"event\":\"order\",\"scenario\":\"$id\",\"first\":\"$first\",\"step\":$STEP}"
  for v in $first $second; do
    run $id-$v "${BENCH[@]}" ${id%%-*} --host $(host $group-$v) --adapter $v "$@"
  done
}

prepare_tree

if want g-lat; then
  setup lat-base off && setup lat-relay on && {
    pair L1 lat --n $(n 100 12)
    pair L2 lat --n $(n 300 20)
    pair L3 lat --n $(n 50 12) $( (( SMALL )) && print -- --replay-rate 200)
    pair L4 lat --n $(n 5000 300)
    pair L6 lat --n $(n 100 12)
    pair L7 lat --n $(n 100 12)
    for b in 1 8; do
      first=base; (( STEP % 2 == 1 )) && first=relay; STEP=$(( STEP + 1 ))
      manifest "{\"event\":\"order\",\"scenario\":\"L5-b$b\",\"first\":\"$first\",\"step\":$STEP}"
      for v in $( [[ $first == base ]] && print base relay || print relay base ); do
        if [[ $v == base ]]; then modes=prod,nodebounce; else modes=relay,relay250; fi
        run L5b$b-$v "${L5[@]}" --host $(host lat-$v) --n $(n 100 12) --mode $modes --burst $b --burst-interval 125 --spacing 1500 --typing-probe
      done
    done
    run C6-relay "${BENCH[@]}" C6 --host $(host lat-relay) --adapter relay --compare $(host lat-base)
  }
fi

if want g-cpu; then
  setup cpu-base off && setup cpu-relay on && {
    pair C1 cpu --n $(n 40 12) --tail
    for v in base relay; do run C2-quick-$v "${BENCH[@]}" C2 --host $(host cpu-$v) --adapter $v --trace quick --n $(n 5000 300) --tail; done
    pair C4 cpu --n $(n 50 10) --reconnects $(n 20 4)
    for v in base relay; do
      l5=$RAW/L5b8-$v.json
      run C5-$v "${BENCH[@]}" C5 --host $(host cpu-$v) --adapter $v --n $(n 40 4) --catchups $(n 20 3) $( [[ -f $l5 ]] && print -- --l5 $l5)
    done
  }
fi

if want g-stress; then
  setup stress-base off && setup stress-relay on && {
    for v in base relay; do run C2-stress-$v "${BENCH[@]}" C2 --host $(host stress-$v) --adapter $v --trace stress --clients 5 --n $(n 50000 500); done
  }
fi

if want g-mem; then
  for v in base relay; do
    relay=off; [[ $v == relay ]] && relay=on
    setup mem-$v $relay || continue
    if ! done_json $RAW/C3-$v.json; then
      run C3-seed-$v "${BENCH[@]}" C3 --host $(host mem-$v) --adapter $v --big $(n 32 4) --seed-only
      FORCE_DEPLOY=1 deploy mem-$v $relay   # fresh isolate + DO right before the measurement
      run C3-$v "${BENCH[@]}" C3 --host $(host mem-$v) --adapter $v --big $(n 32 4) --steps $(n 1,8,32,100 1,8)
    fi
  done
fi

if want g-beh; then
  setup beh-base off && setup beh-relay on && {
    pair B1 beh $( (( SMALL )) && print -- --idle 30000)
    pair B2 beh --edits 50
    pair B3 beh --edited 20
    pair B4 beh
    pair B6 beh
    pair B7 beh --n $(n 40 12) $( (( SMALL )) && print -- --flood-ms 10000)
    pair B8 beh --n $(n 20 5)
    pair CW beh --writers 4 --seconds $(n 120 20)
  }
fi

if want g-b5; then
  setup b5-relay on && run B5-relay node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/b5.ts --host $(host b5-relay) \
    --races $(n 20 2) --upload-n $(n 5 1)
fi

if want g-x1; then setup x1-base off && setup x1-relay on && pair X1 x1 --steps $(n 100,250,500,1000,2000 20,40) --probe-n $(n 30 12); fi
if want g-x2; then setup x2-base off && setup x2-relay on && pair X2 x2 $( (( SMALL )) && print -- --rates 25,50,100 --step-ms 4000); fi
if want g-x3; then setup x3-base off && setup x3-relay on && pair X3 x3 --sizes-mb $(n 1,5,10 1,5) --repeats $(n 3 2) --tail; fi
if want g-x4; then setup x4-base off && setup x4-relay on && pair X4 x4 --bodies $(n 100 10) --edits $(n 50 5); fi

if want g-k1; then
  setup k1-base off "${K1_VARS[@]}" && setup k1-relay on "${K1_VARS[@]}" && \
    pair K1-compact k1 --trigger compact --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
  setup k1a-relay on && run K1-alarm-relay "${BENCH[@]}" K1 --host $(host k1a-relay) --adapter relay --trigger alarm --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
fi

if want g-mb; then
  secs=$(n 110 30)
  setup mb-base off && run MB-base "${BENCH[@]}" MB --host $(host mb-base) --adapter base --pattern-seconds $secs
  if setup mb0-relay on; then
    run MB-relay "${BENCH[@]}" MB --host $(host mb0-relay) --adapter relay --pattern-seconds $secs
    run MB-relay-nocand "${BENCH[@]}" MB --host $(host mb0-relay) --adapter relay-nocand --pattern-seconds $secs
  fi
  for ms in 10 50 100 250; do
    setup mb$ms-relay on --var YAOS_RELAY_MICROBATCH_MS=$ms && \
      run MB-relay-mb$ms "${BENCH[@]}" MB --host $(host mb$ms-relay) --adapter relay --pattern-seconds $secs
  done
fi

if want final; then
  # Late gql backfill: the last window of a C2/C5/MB run can take > 20 min to appear in analytics.
  say "gql backfill (C2/C5/MB windows still incomplete)"
  (( DRY )) || (cd $TREE && RELAY2_WORKTREE=$TREE node tests/run-typescript.mjs --test-aliases scripts/relay2/gqlfill.ts --dir $RAW --gql-attempts 30) \
    >> $LOGS/gqlfill.log 2>&1 || say "gql backfill left incomplete windows (see $LOGS/gqlfill.log; rerun --only final later)"
  say "convergence suite"
  (( DRY )) || (cd $TREE && node tests/run-typescript.mjs --test-aliases scripts/relay2/convergence.ts --dir $RAW --out $RAW/convergence-suite.json) | tee -a $LOGS/runall.log
fi
say "done (raw: $RAW, logs: $LOGS)"
