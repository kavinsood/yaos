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
# Relay configurations (round 4; coordinator decision for the full run):
#   relay  = "relay v2" production candidate: YAOS_RELAY_BODIES=true + YAOS_RELAY_LEAN_ROWS=true + YAOS_RELAY_MICROBATCH_MS=10
#   strict = "relay-strict": YAOS_RELAY_BODIES=true, lean off, micro-batch 0 (closest to v1 + full production work);
#            run for L2 L4 C1 C2(quick+stress) C4 B7 X2 and the MB sweep so each knob's cost is visible
#   base   = flag off with the SAME lean/mb vars as relay (they are inert when the flag is off; verified by the
#            INERT-* diag runs: relay block absent/disabled on base)
# Groups:
#   g-lat    L1 L2 L3 L4 L6 L7, L5 (real VaultSync; burst 1 and burst 8), C6 (bundle/startup); strict: L2 L4
#   g-cpu    C1 (--tail), C2 quick (--tail), C4, C5 (gql windows); strict: C1 C2-quick C4
#   g-stress C2 stress trace (50k edits, 5 writers); strict too
#   g-mem    C3 on a fresh deploy (the worker is re-deployed right before C3 so the isolate/DO are clean)
#   g-beh    B1 B2 B3 B4 B6 B7 B8, CW (invariant #7); strict: B7
#   g-b5     B5 lease race + K2 upload via scripts/relay2/reset/b5.ts --no-cover (relay only; no lineage-cover workaround)
#   g-x1..x4 X1 (to 2000 sockets), X2 (strict too), X3 (--tail, 3 repeats), X4 — one fresh vault set each
#   g-k1     K1 compact on checkpoint-knob workers (CHECKPOINT_ENTRIES/BYTES/MAX_ROWS raised; differs by design)
#            + K1 alarm on a default-knob relay worker
#   g-mb     MB sweep: base + relay with lean on/off x YAOS_RELAY_MICROBATCH_MS 0/10/50/100/250, patterns l2 (2 keys/s),
#            burst (8 keys/s), stream (25 frames/s); plus relay-nocand on the primary config
#   final    gql backfill (scripts/relay2/gqlfill.ts) + convergence suite summary (scripts/relay2/convergence.ts → $RAW/convergence-suite.json)
#
# Latency scenarios run strictly one at a time; within each set the order rotates and every choice is appended to
# $RAW/runall-manifest.jsonl with start/end/status. Clients reconnect + resend on connection loss (lib/rawClient.ts)
# and every close/error is recorded in each JSON (connectionEvents).
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
PRIMARY_VARS=(--var YAOS_RELAY_LEAN_ROWS=true --var YAOS_RELAY_MICROBATCH_MS=10)
STRICT_VARS=(--var YAOS_RELAY_LEAN_ROWS=false --var YAOS_RELAY_MICROBATCH_MS=0)
K1_VARS=(--var YAOS_RELAY_CHECKPOINT_ENTRIES=1000000 --var YAOS_RELAY_CHECKPOINT_BYTES=1073741824 --var YAOS_RELAY_CHECKPOINT_MAX_ROWS=100000)
STEP=0
# Smoke mode: shorter quiet gaps (gql attribution is not the point of a smoke) and an MB subset (worker-count cap).
QG=(); (( SMALL )) && QG=(--quiet-gap-ms 90000)

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
# trio: same plus <group>-strict (relay adapter), order rotating over the three.
pair() { variants_run "base relay" "$@"; }
trio() { variants_run "base relay strict" "$@"; }
variants_run() {
  local vs=(${=1}) id=$2 group=$3; shift 3
  local k=$(( STEP % ${#vs} )) order=() i
  STEP=$(( STEP + 1 ))
  for (( i = 0; i < ${#vs}; i++ )); do order+=(${vs[$(( (k + i) % ${#vs} + 1 ))]}); done
  manifest "{\"event\":\"order\",\"scenario\":\"$id\",\"order\":\"${order[*]}\",\"step\":$STEP}"
  for v in $order; do
    local ad=$v; [[ $v == strict ]] && ad=relay
    run $id-$v "${BENCH[@]}" ${id%%-*} --host $(host $group-$v) --adapter $ad "$@"
  done
}

# Deploy helpers: base (flag off, primary vars for identical config), relay (primary), strict.
setup_base() { local g=$1; shift; setup $g-base off "${PRIMARY_VARS[@]}" "$@"; }
setup_relay() { local g=$1; shift; setup $g-relay on "${PRIMARY_VARS[@]}" "$@"; }
setup_strict() { local g=$1; shift; setup $g-strict on "${STRICT_VARS[@]}" "$@"; }
# Inertness evidence for the lean/mb vars on the flag-off worker (diagnostics has no enabled relay block).
inert() { run INERT-$1-base "${BENCH[@]}" diag --host $(host $1-base) --adapter base; }

prepare_tree

if want g-lat; then
  setup_base lat && setup_relay lat && setup_strict lat && {
    inert lat
    pair L1 lat --n $(n 100 12)
    trio L2 lat --n $(n 300 20)
    pair L3 lat --n $(n 50 12) $( (( SMALL )) && print -- --replay-rate 200)
    trio L4 lat --n $(n 5000 300)
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
  setup_base cpu && setup_relay cpu && setup_strict cpu && {
    inert cpu
    trio C1 cpu --n $(n 40 12) --tail
    for v in base relay strict; do ad=$v; [[ $v == strict ]] && ad=relay
      run C2-quick-$v "${BENCH[@]}" C2 --host $(host cpu-$v) --adapter $ad --trace quick --n $(n 5000 300) --tail "${QG[@]}"; done
    trio C4 cpu --n $(n 50 10) --reconnects $(n 20 4)
    for v in base relay; do
      l5=$RAW/L5b8-$v.json
      run C5-$v "${BENCH[@]}" C5 --host $(host cpu-$v) --adapter $v --n $(n 40 4) --catchups $(n 20 3) "${QG[@]}" $( [[ -f $l5 ]] && print -- --l5 $l5)
    done
  }
fi

if want g-stress; then
  setup_base stress && setup_relay stress && setup_strict stress && {
    for v in base relay strict; do ad=$v; [[ $v == strict ]] && ad=relay
      run C2-stress-$v "${BENCH[@]}" C2 --host $(host stress-$v) --adapter $ad --trace stress --clients 5 --n $(n 50000 500) "${QG[@]}"; done
  }
fi

if want g-mem; then
  for v in base relay; do
    relay=off; [[ $v == relay ]] && relay=on
    setup mem-$v $relay "${PRIMARY_VARS[@]}" || continue
    if ! done_json $RAW/C3-$v.json; then
      run C3-seed-$v "${BENCH[@]}" C3 --host $(host mem-$v) --adapter $v --big $(n 32 4) --seed-only
      FORCE_DEPLOY=1 deploy mem-$v $relay "${PRIMARY_VARS[@]}"   # fresh isolate + DO right before the measurement
      run C3-$v "${BENCH[@]}" C3 --host $(host mem-$v) --adapter $v --big $(n 32 4) --steps $(n 1,8,32,100 1,8)
    fi
  done
fi

if want g-beh; then
  setup_base beh && setup_relay beh && setup_strict beh && {
    pair B1 beh $( (( SMALL )) && print -- --idle 30000)
    pair B2 beh --edits 50
    pair B3 beh --edited 20
    pair B4 beh
    pair B6 beh
    trio B7 beh --n $(n 40 12) $( (( SMALL )) && print -- --flood-ms 10000)
    pair B8 beh --n $(n 20 5)
    pair CW beh --writers 4 --seconds $(n 120 20)
  }
fi

if want g-b5; then
  setup_relay b5 && run B5-relay node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/b5.ts --host $(host b5-relay) \
    --no-cover --races $(n 20 2) --upload-n $(n 5 1)
fi

if want g-x1; then setup_base x1 && setup_relay x1 && pair X1 x1 --steps $(n 100,250,500,1000,2000 20,40) --probe-n $(n 30 12); fi
if want g-x2; then setup_base x2 && setup_relay x2 && setup_strict x2 && trio X2 x2 $( (( SMALL )) && print -- --rates 25,50,100 --step-ms 4000); fi
if want g-x3; then setup_base x3 && setup_relay x3 && pair X3 x3 --sizes-mb $(n 1,5,10 1,5) --repeats $(n 3 2) --tail; fi
if want g-x4; then setup_base x4 && setup_relay x4 && pair X4 x4 --bodies $(n 100 10) --edits $(n 50 5); fi

if want g-k1; then
  setup_base k1 "${K1_VARS[@]}" && setup_relay k1 "${K1_VARS[@]}" && \
    pair K1-compact k1 --trigger compact --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
  setup_relay k1a && run K1-alarm-relay "${BENCH[@]}" K1 --host $(host k1a-relay) --adapter relay --trigger alarm --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
fi

if want g-mb; then
  secs=$(n 110 30)
  setup_base mb && run MB-base "${BENCH[@]}" MB --host $(host mb-base) --adapter base --pattern-seconds $secs "${QG[@]}"
  for lean in true false; do
    lt=lean; [[ $lean == false ]] && lt=full
    for ms in 0 10 50 100 250; do
      (( SMALL )) && [[ $lt-$ms != lean-10 && $lt-$ms != full-0 ]] && continue
      setup mb$ms-$lt on --var YAOS_RELAY_LEAN_ROWS=$lean --var YAOS_RELAY_MICROBATCH_MS=$ms || continue
      run MB-relay-$lt-mb$ms "${BENCH[@]}" MB --host $(host mb$ms-$lt) --adapter relay --pattern-seconds $secs "${QG[@]}"
      if [[ $lt == lean && $ms == 10 ]]; then
        run MB-relay-nocand-$lt-mb$ms "${BENCH[@]}" MB --host $(host mb$ms-$lt) --adapter relay-nocand --pattern-seconds $secs "${QG[@]}"
      fi
    done
  done
fi

if want final; then
  # Late gql backfill: the last window of a C2/C5/MB run can take > 20 min to appear in analytics.
  say "gql backfill (C2/C5/MB windows still incomplete)"
  (( DRY )) || (cd $TREE && RELAY2_WORKTREE=$TREE node tests/run-typescript.mjs --test-aliases scripts/relay2/gqlfill.ts --dir $RAW --gql-attempts 30) \
    >> $LOGS/gqlfill.log 2>&1 || say "gql backfill left incomplete windows (see $LOGS/gqlfill.log; rerun --only final later)"
  say "convergence suite"
  (( DRY )) || (cd $TREE && node tests/run-typescript.mjs --test-aliases scripts/relay2/convergence.ts --dir $RAW --out $RAW/convergence-suite.json) | tee -a $LOGS/runall.log
  for v in strict base; do
    (( DRY )) || (cd $TREE && node tests/run-typescript.mjs --test-aliases scripts/relay2/convergence.ts --dir $RAW --variant $v --out $RAW/convergence-suite-$v.json) | tee -a $LOGS/runall.log
  done
fi
say "done (raw: $RAW, logs: $LOGS)"
