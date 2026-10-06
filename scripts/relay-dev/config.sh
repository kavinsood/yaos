# Source me (zsh). Shared config generation for the client-remake streams relay (local + deployed).
#
# relay_dev_config <worker-name> [K=V]...
#   Prints a wrangler config derived from server/wrangler.toml: name replaced, [[r2_buckets]] removed
#   (no YAOS_BUCKET: blobs are off; the streams surface never needs R2), plus [vars] with any extra K=V.
#   Streams are always on (docs/server-rewrite/DECISIONS.md §2.1), so there is no flag to set. Generated
#   files live at server/wrangler.relay2-*.toml, which .git/info/exclude ignores.
#   RELAY_DEV_R2=1 keeps [[r2_buckets]] (attachments on; wrangler dev emulates the bucket locally under
#   --persist-to), for client e2e that exercise the blob store (e2e/client/snapshots.ts).
RELAY_DEV_WT=${${(%):-%x}:A:h:h:h}
relay_dev_config() {
  local name=$1; shift
  awk -v name="$name" -v keep_r2="${RELAY_DEV_R2:-0}" '
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
