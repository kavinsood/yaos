# Source me (zsh). Shared config generation for the client-remake streams relay (local + deployed).
#
# relay_dev_config <worker-name> [K=V]...
#   Prints a wrangler config derived from server/wrangler.toml: name replaced, the [[r2_buckets]] YAOS_BUCKET
#   binding kept but pointed at the test bucket $RELAY_DEV_BUCKET (every bucket_name is rewritten: server/wrangler.toml
#   names "yaos", the legacy production bucket, which test vaults must never write), plus [vars] with any extra K=V.
#   A deployed yaos-relay2-* worker needs that bucket on the account (deploy.sh); wrangler dev never touches it, it
#   emulates the bucket locally under --persist-to (v3/r2/<bucket_name>/).
#   Attachments, oversized updates (bodyUpdateRef) and snapshot parts go to that bucket over HTTP PUT only;
#   they never ride the relay's sequence log (DESIGN §j.1), so every client e2e needs it.
#   RELAY_DEV_R2=0 drops the binding: the relay answers 503 attachments_unavailable and clients do not sync
#   attachments (fail closed). Only for the store-less path (conformance T-BLOB-UNAVAILABLE).
#   Streams are always on (docs/server-rewrite/DECISIONS.md §2.1), so there is no flag to set. Generated
#   files live at server/wrangler.relay2-*.toml, which .git/info/exclude ignores.
RELAY_DEV_WT=${${(%):-%x}:A:h:h:h}
RELAY_DEV_BUCKET=yaos-relay2-e2e
relay_dev_config() {
  local name=$1; shift
  awk -v name="$name" -v keep_r2="${RELAY_DEV_R2:-1}" -v bucket="$RELAY_DEV_BUCKET" '
    /^\[/ {sec=$0; skip=(sec == "[[r2_buckets]]" && keep_r2 != "1")}
    skip {next}
    !named && /^name = / {print "name = \"" name "\""; named=1; next}
    sec == "[[r2_buckets]]" && /^(preview_)?bucket_name = / {print $1 " = \"" bucket "\""; next}
    {print}' $RELAY_DEV_WT/server/wrangler.toml
  print ""
  print "[vars]"
  local kv
  for kv in "$@"; do print -r -- "${kv%%=*} = \"${kv#*=}\""; done
}
