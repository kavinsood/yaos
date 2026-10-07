# Source me (zsh). Shared config generation for the client-remake streams relay (local + deployed).
#
# relay_dev_config <worker-name> [K=V]...
#   Prints a wrangler config derived from server/wrangler.toml: name replaced, the [[r2_buckets]] YAOS_BUCKET
#   binding kept (wrangler dev emulates the bucket locally under --persist-to), plus [vars] with any extra K=V.
#   Attachments, oversized updates (bodyUpdateRef) and snapshot parts go to that bucket over HTTP PUT only;
#   they never ride the relay's sequence log (DESIGN §j.1), so every client e2e needs it.
#   RELAY_DEV_R2=0 drops the binding: the relay answers 503 attachments_unavailable and clients do not sync
#   attachments (fail closed). Only for the store-less path (conformance T-BLOB-UNAVAILABLE).
#   Streams are always on (docs/server-rewrite/DECISIONS.md §2.1), so there is no flag to set. Generated
#   files live at server/wrangler.relay2-*.toml, which .git/info/exclude ignores.
RELAY_DEV_WT=${${(%):-%x}:A:h:h:h}
relay_dev_config() {
  local name=$1; shift
  awk -v name="$name" -v keep_r2="${RELAY_DEV_R2:-1}" '
    !named && /^name = / {print "name = \"" name "\""; named=1; next}
    keep_r2 != "1" && /^\[\[r2_buckets\]\]/ {skip=1; next}
    skip && /^\[/ {skip=0}
    skip {next}
    {print}' $RELAY_DEV_WT/server/wrangler.toml
  print ""
  print "[vars]"
  local kv
  for kv in "$@"; do print -r -- "${kv%%=*} = \"${kv#*=}\""; done
}
