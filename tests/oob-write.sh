#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage:
  tests/oob-write.sh <vault_root> <scenario>

Scenarios:
  single-create    Create one markdown file out-of-band.
  bulk-copy        Copy a nested markdown tree into the vault in one shot.
  bulk-copy-hu     Same as bulk-copy, plus a few Hungarian filename examples.
  modify-latest    Append to the most recently created YAOS-OOB markdown file.
  all              Run single-create + bulk-copy-hu + modify-latest.

Examples:
  tests/oob-write.sh "/path/to/vault" single-create
  tests/oob-write.sh "/path/to/vault" bulk-copy
  tests/oob-write.sh "/path/to/vault" all
EOF
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi

VAULT_ROOT="$1"
SCENARIO="${2:-all}"

if [[ ! -d "$VAULT_ROOT" ]]; then
	echo "Vault root does not exist: $VAULT_ROOT" >&2
	exit 1
fi

timestamp_utc() {
	date -u +"%Y-%m-%dT%H:%M:%SZ"
}

timestamp_fs() {
	date -u +"%Y%m%d-%H%M%S"
}

latest_yaos_oob_md() {
	find "$VAULT_ROOT" -type f -name "yaos-oob-*.md" -print0 2>/dev/null \
		| xargs -0 -I{} stat -c "%Y %n" "{}" \
		| sort -nr \
		| head -n 1 \
		| cut -d' ' -f2-
}

single_create() {
	local folder="$VAULT_ROOT/Inbox"
	local stamp
	stamp="$(timestamp_fs)"
	local path="$folder/yaos-oob-$stamp.md"
	mkdir -p "$folder"
	cat >"$path" <<EOF
# YAOS OOB single create

created_at_utc: $(timestamp_utc)
source: external shell script
EOF
	echo "created: $path"
}

bulk_copy() {
	local include_hu="$1"
	local stamp
	stamp="$(timestamp_fs)"

	local tmp_src
	tmp_src="$(mktemp -d "/tmp/yaos-oob-src-$stamp-XXXX")"
	local src_root="$tmp_src/Imported-$stamp"

	mkdir -p "$src_root/Batch/Alpha"
	mkdir -p "$src_root/Batch/Beta/Sub"
	mkdir -p "$src_root/Batch/Gamma"

	local i
	for i in $(seq 1 120); do
		local bucket
		if (( i % 3 == 0 )); then
			bucket="$src_root/Batch/Alpha"
		elif (( i % 3 == 1 )); then
			bucket="$src_root/Batch/Beta/Sub"
		else
			bucket="$src_root/Batch/Gamma"
		fi
		cat >"$bucket/yaos-oob-$stamp-$i.md" <<EOF
# YAOS OOB bulk file $i

created_at_utc: $(timestamp_utc)
batch_id: $stamp
index: $i
EOF
	done

	if [[ "$include_hu" == "yes" ]]; then
		cat >"$src_root/Batch/Beta/Sub/árvíztűrő-tükörfúrógép.md" <<EOF
# YAOS OOB unicode filename

created_at_utc: $(timestamp_utc)
note: Hungarian filename test
EOF
		cat >"$src_root/Batch/Beta/Sub/őű-éá.md" <<EOF
# YAOS OOB unicode filename 2

created_at_utc: $(timestamp_utc)
note: Hungarian diacritics test
EOF
	fi

	local dest_parent="$VAULT_ROOT/Inbox"
	mkdir -p "$dest_parent"
	cp -R "$src_root" "$dest_parent/"

	# Optional non-markdown control file.
	printf "non-md control at %s\n" "$(timestamp_utc)" >"$dest_parent/Imported-$stamp/Batch/non-md-control.txt"

	local count
	count="$(find "$dest_parent/Imported-$stamp" -type f -name "*.md" | wc -l | tr -d ' ')"
	echo "bulk-copied: $dest_parent/Imported-$stamp ($count markdown files)"
	echo "temp-source: $tmp_src"
}

modify_latest() {
	local latest
	latest="$(latest_yaos_oob_md || true)"
	if [[ -z "${latest:-}" ]]; then
		echo "no yaos-oob markdown file found to modify" >&2
		exit 2
	fi
	cat >>"$latest" <<EOF

oob_modified_at_utc: $(timestamp_utc)
oob_modify_source: external shell script
EOF
	echo "modified: $latest"
}

case "$SCENARIO" in
single-create)
	single_create
	;;
bulk-copy)
	bulk_copy "no"
	;;
bulk-copy-hu)
	bulk_copy "yes"
	;;
modify-latest)
	modify_latest
	;;
all)
	single_create
	bulk_copy "yes"
	modify_latest
	;;
*)
	echo "unknown scenario: $SCENARIO" >&2
	usage
	exit 1
	;;
esac
