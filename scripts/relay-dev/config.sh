# Source me (zsh). Shared config generation for the client-remake streams relay (local + deployed).
#
# relay_dev_config <worker-name> [K=V]...
#   Prints a wrangler config derived from server/wrangler.toml: name replaced, [[r2_buckets]] removed
#   (no YAOS_BUCKET: blobs, snapshots and the R2 recovery projection are off; the streams surface never
#   needs R2), plus [vars] YAOS_STREAMS = "true" and any extra K=V. Generated files live at
#   server/wrangler.relay2-*.toml, which .git/info/exclude ignores.
RELAY_DEV_WT=${${(%):-%x}:A:h:h:h}
relay_dev_config() {
  local name=$1; shift
  awk -v name="$name" '
    !named && /^name = / {print "name = \"" name "\""; named=1; next}
    /^\[\[r2_buckets\]\]/ {skip=1; next}
    skip && /^\[/ {skip=0}
    skip {next}
    {print}' $RELAY_DEV_WT/server/wrangler.toml
  print ""
  print "[vars]"
  print 'YAOS_STREAMS = "true"'
  local kv
  for kv in "$@"; do print -r -- "${kv%%=*} = \"${kv#*=}\""; done
}
