#!/bin/zsh
# Relay v2 fast full-run orchestrator (user-approved restructure, 2026-10-01). One detached process:
#
#   nohup zsh scripts/relay2/runfast.sh --sha <commit> --tag <tag> [--small] [--jobs 10] [--phases id,id] [--lanes A,B]
#         [--no-final] [--dry-run] > ../logs/relay2/runall-<tag>.nohup 2>&1 &
#
# Every phase (one scenario × one variant) runs on its OWN freshly deployed worker
# yaos-relay2-<tag>-<phase id lowercased>[-a<k>], so that worker's gql analytics are exactly that phase's traffic.
# No inter-phase quiet gaps and no inline gql stability waits (scenarios run with --quiet-gap-ms 0 --no-gql); one
# gqlfill pass at the end (scripts/relay2/gqlfill.ts --progress) attaches whole-phase totals (gqlPhase / phaseLevel)
# and backfills the per-window numbers.
#
# Schedule:
#   lane B  every non-latency phase (C1–C5, B1–B6, B8, CW, X1, X3, X4, K1, MB, SEED/INERT), --jobs at a time,
#           longest first; while it runs, the lane A workers are deployed + claimed + seeded (provision tasks).
#   lane A  latency phases strictly one at a time, nothing else running: L1 L2 L3 L4 L6 L7 L5(b1,b8) B7 (L2 victim)
#           X2, variant order alternating per scenario.
#   final   C6 (deploy records), gqlfill (waits until >= 20 min after the last lane B phase; retried), convergence
#           suite, summarize.py → tables.md.
# Outputs: $EXP/logs/relay2/runall-<tag>[-small]/  raw/<phase>.json, <phase>.log, plan.tsv, progress.jsonl (one event
# per line), progress.json (snapshot: stage, counts, running, failed, per-phase status/worker/start/end).
# Resumable: a phase whose raw/<phase>.json exists without an "error" key is skipped. A failed phase is retried once
# on a fresh worker, then recorded as failed; the run continues. Per-phase timeout (default 45 min, small 20 min).
#
# --reuse-pool <file> (account DO-namespace cap, CF error 10067: each worker = 3 namespaces, max 500): instead of a
# new worker name per phase, (re)deploy onto an existing idle yaos-relay2-* worker listed in <file> (one per line,
# taken in order). Same script name + same DO classes = same namespaces (no new ones). Each pool worker is used by at
# most one phase attempt of the run (claimed atomically: state/pool/<worker>; mapping in state/pool.tsv), and its
# state is fresh because context.ts --fresh-vault creates a NEW vault (random vaultId → new YAOS_SYNC DO instance)
# with new devices + standard seed. gql (scriptName + namespaceId + [deploy start, phase end]) then sees only this
# phase's traffic, the worker's previous traffic being hours older. The previous context / deploy record are kept as
# context-<w>.pre-<label>.json / deploy-<w>.pre-<tag>.json. Workers are never deleted.
set -uo pipefail
EXP=/Users/kavin/personal/obsidiansync/experiments
MAIN=$EXP/yaos-relay2
HERE=${0:A:h}
source $EXP/env.sh
ulimit -n 10240 2>/dev/null || true

SHA="" TAG="f$(date +%m%d)" DRY=0 SMALL=0 JOBS=10 ONLY_PHASES="" ONLY_LANES="" FINAL=1 POOL="" APAR=0 PLAN=default PTXT=""
while (( $# )); do
  case $1 in
    --sha) SHA=$2; shift 2;;
    --tag) TAG=$2; shift 2;;
    --small) SMALL=1; shift;;
    --jobs) JOBS=$2; shift 2;;
    --phases) ONLY_PHASES=$2; shift 2;;
    --lanes) ONLY_LANES=$2; shift 2;;
    --no-final) FINAL=0; shift;;
    --lane-a-parallel) APAR=1; shift;;
    --plan) PLAN=$2; shift 2;;
    --progress-txt) PTXT=${2:A}; shift 2;;
    --reuse-pool) POOL=${2:A}; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[[ -n $SHA ]] || { echo "usage: runfast.sh --sha <commit> [--tag t] [--small] [--jobs n] [--phases a,b] [--lanes A,B] [--no-final] [--reuse-pool file] [--dry-run]" >&2; exit 2; }
[[ -z $POOL || -s $POOL ]] || { echo "reuse pool $POOL missing/empty" >&2; exit 2; }
SHA=$(git -C $MAIN rev-parse --verify "$SHA^{commit}") || exit 2
TREE=$EXP/yaos-relay2-run-${SHA[1,8]}
LOGS=$EXP/logs/relay2/runall-$TAG; (( SMALL )) && LOGS=$LOGS-small
RAW=$LOGS/raw STATE=$LOGS/state
mkdir -p $RAW $STATE $RAW/failed
rm -rf $LOGS/.token.lock
PHASE_TIMEOUT=$(( SMALL ? 1200 : 2700 ))

COMMON_VARS=(--var YAOS_RELAY_RESET_COOLDOWN_MS=0)
PRIMARY_VARS=(--var YAOS_RELAY_LEAN_ROWS=true --var YAOS_RELAY_MICROBATCH_MS=10)
STRICT_VARS=(--var YAOS_RELAY_LEAN_ROWS=false --var YAOS_RELAY_MICROBATCH_MS=0)
# Relay v3 write reduction (group commit + tail row + receipt ring; server/src/relayFlag.ts). Micro-batch 0:
# group commit replaces it. Explicit GC knobs = the defaults, so the deploy log records them.
V3_VARS=(--var YAOS_RELAY_LEAN_ROWS=true --var YAOS_RELAY_MICROBATCH_MS=0 --var YAOS_RELAY_GROUP_COMMIT=1
  --var YAOS_RELAY_GC_IDLE_MS=300 --var YAOS_RELAY_GC_MAX_MS=1500 --var YAOS_RELAY_GC_MAX_BYTES=65536)
K1_VARS=(--var YAOS_RELAY_CHECKPOINT_ENTRIES=1000000 --var YAOS_RELAY_CHECKPOINT_BYTES=1073741824 --var YAOS_RELAY_CHECKPOINT_MAX_ROWS=100000)
BENCH=(node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts)
L5=(node tests/run-typescript.mjs --test-aliases scripts/relay2/l5-cli-baseline.ts)
B5=(node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/b5.ts)

say() { print -r -- "[runfast $(date -u +%H:%M:%S)] $*" >> $LOGS/runall.log; [[ -n $PTXT ]] && print -r -- "[$(date -u +%H:%M:%S)] $*" >> $PTXT; print -ru2 -- "[runfast $(date -u +%H:%M:%S)] $*"; }
ev() { (( DRY )) && return 0; python3 $HERE/progress.py event $LOGS "$@" || true; }
n() { (( SMALL )) && print -r -- $2 || print -r -- $1; }   # n <full> <small>
iso() { date -u +%FT%TZ; }
host_of() { print -r -- "https://$1.kavinsood.workers.dev"; }
done_json() { [[ -s $1 ]] && ! grep -qE '^  "error": [^n]' $1; }   # "error": null (L5) is fine

# ------------------------------------------------------------------------------------------------ plan
typeset -A LANE SPEC KIND ARGS EST
typeset -a ORDER_B ORDER_A
# P <id> <lane A|B> <spec> <est min> <kind bench|l5|b5|c3|diag> <args...>
P() {
  local id=$1 lane=$2 spec=$3 est=$4 kind=$5; shift 5
  if [[ -n $ONLY_PHASES && ",$ONLY_PHASES," != *",$id,"* ]]; then return 0; fi
  if [[ -n $ONLY_LANES && ",$ONLY_LANES," != *",$lane,"* ]]; then return 0; fi
  LANE[$id]=$lane SPEC[$id]=$spec KIND[$id]=$kind ARGS[$id]="$*" EST[$id]=$est
  if [[ $lane == A ]]; then ORDER_A+=($id); else ORDER_B+=($id); fi
}
NOGAP=(--quiet-gap-ms 0 --no-gql)
# Lane B, longest first.
for v in base relay strict; do P C2-stress-$v B $v 12 bench C2 --trace stress --clients 5 --rate 0 --n $(n 50000 500) $NOGAP; done
P K1-compact-base B k1base 14 bench K1 --trigger compact --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
P K1-compact-relay B k1relay 6 bench K1 --trigger compact --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
P K1-alarm-relay B relay 6 bench K1 --trigger alarm --tails $(n 50,500,5000 50,500) --repeats $(n 3 1) --tail
for v in base relay; do P X1-$v B $v 10 bench X1 --steps $(n 100,250,500,1000,2000 20,40) --probe-n $(n 30 12); done
# MB sweep (trimmed): base + strict (lean off, mb0) + lean × mb {0,10,50}; patterns burst (8 keys/s) and stream (25/s).
for cfg in base:base strict:strict lean-mb0:lean0 lean-mb10:relay lean-mb50:lean50; do
  for pat in burst stream; do P MB-${cfg%%:*}-$pat B ${cfg#*:} 6 bench MB --patterns $pat --pattern-seconds $(n 110 30) $NOGAP; done
done
for v in base relay strict; do P C2-quick-$v B $v 8 bench C2 --trace quick --n $(n 5000 300) --tail $NOGAP; done
for v in base relay strict; do P C1-$v B $v 7 bench C1 --n $(n 40 12) --tail; done
for v in base relay; do
  P C5-bursts-$v B $v 6 bench C5 --parts bursts --n $(n 40 4) $NOGAP
  P C5-catchups-$v B $v 4 bench C5 --parts catchups --catchups $(n 20 3) $NOGAP
done
for v in base relay; do P X3-$v B $v 6 bench X3 --sizes-mb $(n 1,5,10 1,5) --repeats $(n 3 2) --tail; done
for v in base relay; do P X4-$v B $v 5 bench X4 --bodies $(n 100 10) --edits $(n 50 5); done
for v in base relay; do P B1-$v B $v 6 bench B1 $( (( SMALL )) && print -- --idle 30000); done
for v in base relay; do P CW-$v B $v 3 bench CW --writers 4 --seconds $(n 120 20); done
for v in base relay strict; do P C4-$v B $v 2 bench C4 --n $(n 50 10) --reconnects $(n 20 4); done
for v in base relay; do P C3-$v B $v 3 c3 --big $(n 32 4) --steps $(n 1,8,32,100 1,8); done
for v in base relay; do
  P B2-$v B $v 4 bench B2 --edits 50
  P B3-$v B $v 3 bench B3 --edited 20
  P B4-$v B $v 2 bench B4
  P B6-$v B $v 2 bench B6
  P B8-$v B $v 2 bench B8 --n $(n 20 5)
done
P B5-relay B relay 3 b5 --no-cover --races $(n 20 2) --upload-n $(n 5 1)
# SEED-<v>: deploy + claim + standard seed only (diag read) = the per-worker fixed cost gqlfill subtracts.
# SEED-base doubles as the INERT evidence (lean/mb vars present, relay block absent on the flag-off worker).
for v in base relay strict; do P SEED-$v B $v 1 diag; done
# Lane A: latency, serialized, order alternating.
P L1-relay A relay 1 bench L1 --n $(n 100 12)
P L1-base A base 1 bench L1 --n $(n 100 12)
P L2-base A base 3.5 bench L2 --n $(n 300 20)
P L2-relay A relay 3.5 bench L2 --n $(n 300 20)
P L2-strict A strict 3.5 bench L2 --n $(n 300 20)
P L3-relay A relay 3 bench L3 --n $(n 50 12) --replay-rate $(n 100 200)
P L3-base A base 3 bench L3 --n $(n 50 12) --replay-rate $(n 100 200)
P L4-strict A strict 4.5 bench L4 --n $(n 5000 300)
P L4-base A base 4.5 bench L4 --n $(n 5000 300)
P L4-relay A relay 4.5 bench L4 --n $(n 5000 300)
P L6-base A base 2.5 bench L6 --n $(n 100 12)
P L6-relay A relay 2.5 bench L6 --n $(n 100 12)
P L7-relay A relay 1.5 bench L7 --n $(n 100 12)
P L7-base A base 1.5 bench L7 --n $(n 100 12)
P L5b1-base A base 8 l5 --n $(n 100 12) --mode prod,nodebounce --burst 1 --burst-interval 125 --spacing 1500 --typing-probe
P L5b1-relay A relay 8 l5 --n $(n 100 12) --mode relay,relay250 --burst 1 --burst-interval 125 --spacing 1500 --typing-probe
P L5b8-relay A relay 9 l5 --n $(n 100 12) --mode relay,relay250 --burst 8 --burst-interval 125 --spacing 1500 --typing-probe
P L5b8-base A base 9 l5 --n $(n 100 12) --mode prod,nodebounce --burst 8 --burst-interval 125 --spacing 1500 --typing-probe
P B7-base A base 2.5 bench B7 --n $(n 40 12) $( (( SMALL )) && print -- --flood-ms 10000)
P B7-relay A relay 2.5 bench B7 --n $(n 40 12) $( (( SMALL )) && print -- --flood-ms 10000)
P B7-strict A strict 2.5 bench B7 --n $(n 40 12) $( (( SMALL )) && print -- --flood-ms 10000)
P X2-strict A strict 3 bench X2 $( (( SMALL )) && print -- --rates 25,50,100 --step-ms 4000)
P X2-relay A relay 3 bench X2 $( (( SMALL )) && print -- --rates 25,50,100 --step-ms 4000)
P X2-base A base 3 bench X2 $( (( SMALL )) && print -- --rates 25,50,100 --step-ms 4000)

# --plan v3: relay v3 write-reduction run (group commit). Replaces the default plan. Specs: v3 (harness client with
# candidateId), v3nc (relay-nocand adapter = the real client, which sends no candidateId), relay (v2 BODIES+LEAN+MB10),
# base. (B5 client send-coalescing, spec v3b5, was measured and removed: 1.53 rows/keystroke vs 0.29, +280 ms.)
if [[ $PLAN == v3 ]]; then
  LANE=() SPEC=() KIND=() ARGS=() EST=() ORDER_B=() ORDER_A=()
  P C2-stress-v3 B v3 12 bench C2 --trace stress --clients 5 --rate 0 --n $(n 50000 500) $NOGAP
  P X1-v3 B v3 10 bench X1 --steps $(n 100,250,500,1000,2000 20,40) --probe-n $(n 30 12)
  P MB-v3-autosave B v3 7 bench MB --patterns autosave --pattern-seconds $(n 320 30) $NOGAP
  P MB-v3nc-autosave B v3nc 7 bench MB --patterns autosave --pattern-seconds $(n 320 30) $NOGAP
  P HTTPSAVE-v3 B v3 6 bench HTTPSAVE --seconds $(n 300 30) --interval-ms 5000
  for pat in type5 burst bursty stream; do P MB-v3-$pat B v3 4 bench MB --patterns $pat --pattern-seconds $(n 110 30) $NOGAP; done
  for pat in type5 burst; do P MB-v3nc-$pat B v3nc 4 bench MB --patterns $pat --pattern-seconds $(n 110 30) $NOGAP; done
  for pat in type5 burst; do P MB-relay-$pat B relay 4 bench MB --patterns $pat --pattern-seconds $(n 110 30) $NOGAP; done
  P MB-base-type5 B base 4 bench MB --patterns type5 --pattern-seconds $(n 110 30) $NOGAP
  for v in base relay v3 v3nc; do P C4-$v B $v 3 bench C4 --n $(n 50 10) --reconnects 0; done
  P CRASH-v3 B v3 5 bench CRASH --rounds $(n 5 2) --modes online,offline
  P FENCE-v3 B v3 3 bench FENCE --rounds $(n 5 2)
  P FENCE2-v3 B v3 3 bench FENCE --rounds $(n 5 2) --variants rate --rate-frames 200
  P CW-v3 B v3 3 bench CW --writers 4 --seconds $(n 120 20)
  P B1-v3 B v3 6 bench B1 $( (( SMALL )) && print -- --idle 30000)
  P C5-bursts-v3 B v3 6 bench C5 --parts bursts --n $(n 40 4) $NOGAP
  P C5-catchups-v3 B v3 4 bench C5 --parts catchups --catchups $(n 20 3) $NOGAP
  P X4-v3 B v3 5 bench X4 --bodies $(n 100 10) --edits $(n 50 5)
  P B2-v3 B v3 4 bench B2 --edits 50
  P B3-v3 B v3 3 bench B3 --edited 20
  P B4-v3 B v3 2 bench B4
  P B6-v3 B v3 2 bench B6
  P B8-v3 B v3 2 bench B8 --n $(n 20 5)
  P B5-v3 B v3 3 b5 --no-cover --races $(n 20 2) --upload-n $(n 5 1)
  for v in base relay v3; do P SEED-$v B $v 1 diag; done
  for v in base relay v3; do P L2-$v A $v 3.5 bench L2 --n $(n 300 20); done
  P L4-v3 A v3 4.5 bench L4 --n $(n 5000 300)
  L5F=(--n $(n 100 12) --burst-interval 125 --spacing 1500 --typing-probe)
  P L5b1-base A base 8 l5 --mode prod,nodebounce --burst 1 $L5F
  P L5b1-relay A relay 8 l5 --mode relay,relay250 --burst 1 $L5F
  P L5b1-v3 A v3 8 l5 --mode relay,native --burst 1 $L5F
  P L5b8-v3 A v3 9 l5 --mode native --burst 8 $L5F
  P B7-v3 A v3 2.5 bench B7 --n $(n 40 12) $( (( SMALL )) && print -- --flood-ms 10000)
fi

write_plan() {
  { print -r -- "# phase	lane	variant	est_min	kind	args"
    for id in $ORDER_B $ORDER_A; do print -r -- "$id	${LANE[$id]}	${SPEC[$id]}	${EST[$id]}	${KIND[$id]}	${ARGS[$id]}"; done
  } > $LOGS/plan.tsv
}

# ------------------------------------------------------------------------------------------------ helpers
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

# Serialise wrangler OAuth refreshes: concurrent wranglers refreshing one rotating refresh token can log us out.
# Under a lock: if the access token expires within 5 min, wait for expiry and refresh once (wrangler whoami).
token_left() {
  python3 -c '
import re,sys,datetime as d
c=open(sys.argv[1]).read(); m=re.search(r"expiration_time\s*=\s*\"([^\"]+)\"",c)
print(int((d.datetime.fromisoformat(m.group(1).replace("Z","+00:00"))-d.datetime.now(d.timezone.utc)).total_seconds()) if m else -1)' \
    $HOME/Library/Preferences/.wrangler/config/default.toml 2>/dev/null || print -- -1
}
ensure_token() {
  (( DRY )) && return 0
  local lock=$LOGS/.token.lock i=0
  until mkdir $lock 2>/dev/null; do sleep 1; (( ++i > 300 )) && rm -rf $lock; done
  local left=$(token_left)
  if (( left < 300 )); then
    (( left > 0 )) && sleep $(( left + 2 ))
    $WRANGLER whoami > /dev/null 2>&1 || say "wrangler whoami failed (token refresh)"
    say "wrangler token refreshed (now $(token_left) s left)"
  fi
  rmdir $lock 2>/dev/null
}

killtree() { local p=$1 sig=${2:-TERM} c; for c in $(pgrep -P $p 2>/dev/null); do killtree $c $sig; done; kill -$sig $p 2>/dev/null; }

# with_timeout <secs> <log> <cmd...>: run in $TREE, kill the whole process tree (incl. wrangler tail) on timeout.
with_timeout() {
  local secs=$1 log=$2; shift 2
  ( cd $TREE && RELAY2_WORKTREE=$TREE "$@" ) >> $log 2>&1 &
  local pid=$! t=0
  while kill -0 $pid 2>/dev/null; do
    sleep 2; t=$(( t + 2 ))
    if (( t >= secs )); then
      print -r -- "[runfast] TIMEOUT after ${secs}s; killing process tree" >> $log
      killtree $pid TERM; sleep 5; killtree $pid KILL; wait $pid 2>/dev/null; return 124
    fi
  done
  wait $pid
}

deploy_args() {   # deploy_args <spec> -> --relay on|off + vars
  case $1 in
    base) print -r -- --relay off $PRIMARY_VARS;;
    relay) print -r -- --relay on $PRIMARY_VARS;;
    strict) print -r -- --relay on $STRICT_VARS;;
    lean0) print -r -- --relay on --var YAOS_RELAY_LEAN_ROWS=true --var YAOS_RELAY_MICROBATCH_MS=0;;
    lean50) print -r -- --relay on --var YAOS_RELAY_LEAN_ROWS=true --var YAOS_RELAY_MICROBATCH_MS=50;;
    v3|v3nc) print -r -- --relay on $V3_VARS;;
    k1base) print -r -- --relay off $PRIMARY_VARS $K1_VARS;;
    k1relay) print -r -- --relay on $PRIMARY_VARS $K1_VARS;;
    *) return 1;;
  esac
}
adapter_of() { [[ $1 == base || $1 == k1base ]] && print base || { [[ $1 == v3nc ]] && print relay-nocand || print relay; }; }

# Fresh worker name for a phase: attempt k = number of earlier deploys of this phase + 1.
# With --reuse-pool: the next unclaimed pool worker (atomic mkdir claim; one phase attempt per worker).
next_worker() {
  local id=$1 k=1 base=yaos-relay2-$TAG-${(L)1} w
  if [[ -n $POOL ]]; then
    (( DRY )) && { print -r -- "<pool>"; return 0; }
    mkdir -p $STATE/pool
    for w in ${(f)"$(grep -E '^yaos-relay2-[a-z0-9-]+$' $POOL)"}; do
      if mkdir $STATE/pool/$w 2>/dev/null; then
        print -r -- "$id	$w	$(iso)" >> $STATE/pool.tsv; print -r -- $id > $STATE/pool/$w/phase
        print -r -- $w; return 0
      fi
    done
    say "reuse pool exhausted ($POOL)"; return 1
  fi
  [[ -f $LOGS/progress.jsonl ]] && k=$(( $(grep -F "\"phase\": \"$id\"," $LOGS/progress.jsonl | grep -c '"status": "deploy"') + 1 ))
  (( k == 1 )) && print -r -- $base || print -r -- $base-a$k
}

# provision <id> <log>: deploy a fresh worker + claim + standard seed; prints "<worker> <start>" on success.
provision() {
  local id=$1 log=$2 spec=${SPEC[$1]} w t0
  w=$(next_worker $id) || return 1; t0=$(iso)
  local ctxflags=()
  if [[ -n $POOL ]]; then
    ctxflags=(--fresh-vault $TAG-$id)
    local dj=$EXP/logs/relay2/deploy-$w.json
    [[ -f $dj && ! -f ${dj%.json}.pre-$TAG.json ]] && cp -p $dj ${dj%.json}.pre-$TAG.json
    ev phase=$id lane=${LANE[$id]} variant=$spec status=deploy worker=$w start=$t0 reused=1
  else
    ev phase=$id lane=${LANE[$id]} variant=$spec status=deploy worker=$w start=$t0
  fi
  ensure_token
  zsh $TREE/scripts/relay2/deploy.sh $w ${=$(deploy_args $spec)} $COMMON_VARS --src $TREE --require-clean >> $log 2>&1 \
    || { print -r -- "[runfast] DEPLOY FAILED $w" >> $log; return 1; }
  local attempt
  for attempt in 1 2 3 4; do
    (cd $TREE && RELAY2_WORKTREE=$TREE node tests/run-typescript.mjs --test-aliases scripts/relay2/context.ts \
      --host $(host_of $w) --devices A,B,C --seed standard $ctxflags) >> $log 2>&1 && { print -r -- "$w $t0"; return 0; }
    print -r -- "[runfast] context attempt $attempt failed" >> $log; sleep 20
  done
  return 1
}

# Lane A workers are provisioned during lane B (state/<id>.prov = "<worker> <deploy start>").
provision_only() {
  local id=$1 log=$LOGS/$1.log r
  done_json $RAW/$id.json && return 0
  [[ -s $STATE/$id.prov ]] && return 0
  ev phase=$id status=provisioning
  if r=$(provision $id $log); then print -r -- $r > $STATE/$id.prov; ev phase=$id status=provisioned worker=${r%% *}
  else ev phase=$id status=pending note=provision-failed; fi
}

phase_cmd() {   # phase_cmd <id> <host> <out>: sets global array CMD
  local id=$1 h=$2 out=$3 ad=$(adapter_of ${SPEC[$1]}) a=(${=ARGS[$1]})
  case ${KIND[$id]} in
    bench) CMD=($BENCH $a[1] --host $h --adapter $ad $a[2,-1] --out $out);;
    diag) CMD=($BENCH diag --host $h --adapter $ad --out $out);;
    l5) CMD=($L5 --host $h $a --out $out);;
    b5) CMD=($B5 --host $h $a --out $out);;
    c3) CMD=(c3_phase $id $h $ad $out $a);;
  esac
}

# C3: seed the big bodies, redeploy the same worker (fresh isolate + DO), then measure.
c3_phase() {
  local id=$1 h=$2 ad=$3 out=$4; shift 4
  local w=${${h#https://}%%.*}
  $BENCH C3 --host $h --adapter $ad "$@" --seed-only --out $RAW/failed/$id.seed.json || return 1
  ensure_token
  zsh $TREE/scripts/relay2/deploy.sh $w ${=$(deploy_args ${SPEC[$id]})} $COMMON_VARS --src $TREE --require-clean || return 1
  $BENCH C3 --host $h --adapter $ad "$@" --out $out
}

# run_phase <id>: up to 2 attempts, each on a fresh worker (a pre-provisioned one first if present).
run_phase() {
  local id=$1 out=$RAW/$1.json log=$LOGS/$1.log attempt w t0 r rc
  if done_json $out; then ev phase=$id lane=${LANE[$id]} variant=${SPEC[$id]} status=skip; say "skip $id (valid output exists)"; return 0; fi
  for attempt in 1 2; do
    if [[ -s $STATE/$id.prov ]]; then r=$(<$STATE/$id.prov); rm -f $STATE/$id.prov
    else
      ev phase=$id lane=${LANE[$id]} variant=${SPEC[$id]} status=provisioning attempt=$attempt
      if ! r=$(provision $id $log); then
        say "$id: provision failed (attempt $attempt)"; ev phase=$id status=$( (( attempt == 2 )) && print failed || print retry) attempt=$attempt note=provision-failed
        continue
      fi
    fi
    w=${r%% *} t0=${r#* }
    local rs=$(iso)
    ev phase=$id lane=${LANE[$id]} variant=${SPEC[$id]} status=running worker=$w attempt=$attempt start=$t0 runStart=$rs
    say "run $id on $w (attempt $attempt)"
    [[ ${ARGS[$id]} == *--tail* ]] && ensure_token
    phase_cmd $id $(host_of $w) $out
    with_timeout $PHASE_TIMEOUT $log $CMD; rc=$?
    local te=$(iso)
    if (( rc == 0 )) && done_json $out; then
      ev phase=$id lane=${LANE[$id]} variant=${SPEC[$id]} status=done worker=$w attempt=$attempt start=$t0 runStart=$rs end=$te rc=0
      say "done $id ($w)"
      return 0
    fi
    [[ -f $out ]] && mv $out $RAW/failed/$id.a$attempt.json
    say "FAILED $id rc=$rc attempt $attempt (see $log)"
    ev phase=$id status=$( (( attempt == 2 )) && print failed || print retry) worker=$w attempt=$attempt start=$t0 runStart=$rs end=$te rc=$rc
  done
  return 1
}

# ------------------------------------------------------------------------------------------------ main
write_plan
if (( DRY )); then
  print -r -- "plan ($LOGS/plan.tsv):"; cat $LOGS/plan.tsv
  for id in $ORDER_B $ORDER_A; do print -r -- "$id → $(next_worker $id) [$(deploy_args ${SPEC[$id]})]"; done
  exit 0
fi
prepare_tree
ev phase=_stage status=start tag=$TAG sha=$SHA small=$SMALL pid=$$ jobs=$JOBS pool=${POOL:-none}
say "runfast tag=$TAG sha=${SHA[1,8]} small=$SMALL jobs=$JOBS lanes B=${#ORDER_B} A=${#ORDER_A} pool=${POOL:-none} logs=$LOGS"

# Lane B (parallel) + lane A provisioning.
ev phase=_stage status=laneB
typeset -a PIDS
reap() { local p keep=(); for p in $PIDS; do kill -0 $p 2>/dev/null && keep+=($p); done; PIDS=($keep); }
spawn() { while reap; (( ${#PIDS} >= JOBS )); do sleep 2; done; "$@" & PIDS+=($!); }
for id in $ORDER_B; do spawn run_phase $id; done
for id in $ORDER_A; do spawn provision_only $id; done
while reap; (( ${#PIDS} )); do sleep 5; done
LANE_B_END=$(date +%s)
say "lane B finished"

# Lane A (serialized; nothing else runs).
ev phase=_stage status=laneA
if (( APAR )); then
  # Light latency phases concurrently (own worker/DO each); flood/ramp phases (B7, X2) alone afterwards.
  for id in $ORDER_A; do [[ $id == B7-* || $id == X2-* ]] || spawn run_phase $id; done
  while reap; (( ${#PIDS} )); do sleep 5; done
  for id in $ORDER_A; do [[ $id == B7-* || $id == X2-* ]] && run_phase $id; done
else
  for id in $ORDER_A; do run_phase $id; done
fi
say "lane A finished"

if (( FINAL )); then
  ev phase=_stage status=final
  # C6: bundle + startup from the deploy records (no traffic).
  if ! done_json $RAW/C6-relay.json; then
    rw=$(grep -F '"phase": "L1-relay",' $LOGS/progress.jsonl | grep '"status": "done"' | tail -1 | sed -E 's/.*"worker": "([^"]+)".*/\1/')
    bw=$(grep -F '"phase": "L1-base",' $LOGS/progress.jsonl | grep '"status": "done"' | tail -1 | sed -E 's/.*"worker": "([^"]+)".*/\1/')
    if [[ -n $rw && -n $bw ]]; then
      with_timeout 300 $LOGS/C6-relay.log $BENCH C6 --host $(host_of $rw) --adapter relay --compare $(host_of $bw) --out $RAW/C6-relay.json \
        && ev phase=C6-relay lane=final variant=relay status=done worker=$rw || ev phase=C6-relay lane=final variant=relay status=failed
    fi
  fi
  # One gql pass over every phase worker, >= 20 min after the last lane B phase (analytics periods settle).
  wait_s=$(( LANE_B_END + 1200 - $(date +%s) ))
  (( SMALL )) && wait_s=$(( LANE_B_END + 420 - $(date +%s) ))
  if (( wait_s > 0 )); then say "gqlfill: waiting ${wait_s}s for analytics to settle"; sleep $wait_s; fi
  ev phase=_stage status=gqlfill
  for try in 1 2 3; do
    ensure_token
    say "gqlfill pass $try"
    with_timeout 3600 $LOGS/gqlfill.log node tests/run-typescript.mjs --test-aliases scripts/relay2/gqlfill.ts --dir $RAW \
      --progress $LOGS/progress.jsonl --gql-attempts $(n 10 4) --jobs 8 && break
    say "gqlfill pass $try left incomplete windows/phases (see $LOGS/gqlfill.log)"; (( try < 3 )) && sleep 600
  done
  ev phase=_stage status=summary
  for v in relay strict base; do
    suffix=""; [[ $v != relay ]] && suffix=-$v
    (cd $TREE && node tests/run-typescript.mjs --test-aliases scripts/relay2/convergence.ts --dir $RAW --variant $v \
      --out $RAW/convergence-suite$suffix.json) >> $LOGS/runall.log 2>&1
  done
  python3 $TREE/scripts/relay2/summarize.py --dir $RAW > $LOGS/tables.md 2>> $LOGS/runall.log || say "summarize failed"
fi
python3 $HERE/progress.py snapshot $LOGS
ev phase=_stage status=done
say "done (raw: $RAW, progress: $LOGS/progress.json, tables: $LOGS/tables.md)"
