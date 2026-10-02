#!/usr/bin/env python3
"""Relay v2 cost model (RFC docs/rfc-relay-bodies.md section 9).

Prints the section-9 table: DO billed requests/day, Worker requests/day, and SQLite rows
written/day for three day shapes (idle, typical, heavy import), for base (flag off) and relay
(YAOS_RELAY_BODIES=true), against the Workers Free limits.

Every input is a named parameter, so the table can be re-run with measured C4/C5 values:

    python3 scripts/relay2/costmodel.py                          # defaults (inferred)
    python3 scripts/relay2/costmodel.py --set relay_rows_per_append=9 --set base_rows_per_flush=9
    python3 scripts/relay2/costmodel.py --json measured.json     # {"param": value, ...}
    python3 scripts/relay2/costmodel.py --list                   # show every parameter + provenance
    python3 scripts/relay2/costmodel.py --format json            # machine-readable output
    python3 scripts/relay2/costmodel.py --wb [--measured <raw dir>] [--set k=v]   # write-budget model (wb/wbmodel.py):
                                                                 # rows/day vs 100k for typical / heavy / autosave /
                                                                 # first open 2k/10k/25k, measured vs assumed labels

Provenance tags in PARAMS: "measured:<id>" (a spike or A-series number), "code:<file>" (a
constant read from server/src), "doc:<url>" (Cloudflare docs), "assumed" (a modelling choice,
to be replaced by C4/C5 where marked).

Standard library only.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass

# name: (default, provenance, description)
PARAMS: dict[str, tuple[float, str, str]] = {
    # ---- Cloudflare Workers Free limits (checked 2026-09-30) ----
    "free_do_requests_per_day": (100_000, "doc:developers.cloudflare.com/durable-objects/platform/pricing/",
                                 "DO requests/day (HTTP, RPC, WS messages at 20:1, alarms)"),
    "free_rows_written_per_day": (100_000, "doc:developers.cloudflare.com/durable-objects/platform/pricing/",
                                  "SQLite rows written/day (indexes, deletes and setAlarm count)"),
    "free_rows_read_per_day": (5_000_000, "doc:developers.cloudflare.com/durable-objects/platform/pricing/",
                               "SQLite rows read/day"),
    "free_worker_requests_per_day": (100_000, "doc:developers.cloudflare.com/workers/platform/pricing/",
                                     "Worker requests/day (HTTP + WS upgrades; WS messages are not Worker requests)"),
    "ws_billing_ratio": (20, "doc:developers.cloudflare.com/durable-objects/platform/pricing/",
                         "incoming WS messages per billed DO request"),

    # ---- vault shape ----
    "devices": (3, "assumed", "devices online (Obsidian left open)"),
    "idle_body_sockets_per_device": (3, "assumed", "open body sockets per device besides root"),
    "ping_interval_s": (60, "measured:A1", "client VAULT_PING cadence per socket (A1: ~60.5 s)"),
    "ticket_refresh_interval_s": (270, "measured:A1", "ticket-refresh frame cadence per socket (A1: ~4.5 min)"),
    "idle_alarms_per_day": (0, "assumed", "alarms in a fully idle vault (none are armed without appends)"),
    "idle_evictions_per_day": (24, "assumed", "DO evictions/day while idle (base reconnects after each on next edit)"),
    "base_reconnect_do_requests": (3, "measured:A1", "DO requests per base reconnect (ticket check, WS upgrade, /changes)"),
    "base_reconnect_worker_requests": (3, "measured:A1", "Worker requests per base reconnect"),
    "base_reconnect_rows_written": (0, "assumed", "rows written per reconnect (C4: seq/reconnect 0 at small n)"),

    # ---- typing workload (typical day) ----
    "editing_hours": (2.0, "assumed", "hours of editing per day, summed over devices"),
    "typing_duty": (0.25, "assumed", "fraction of editing time actually typing"),
    "frames_per_typing_s": (5.0, "assumed", "y-codemirror update frames/s while typing (one per transaction)"),
    "awareness_msgs_per_frame": (1.0, "assumed", "incoming awareness frames per update frame (cursor moves)"),
    "burst_s": (10.0, "assumed", "length of one edit burst (typing until a pause); one candidate per burst in base"),
    "noop_fraction": (0.0, "assumed", "fraction of frames the growth cap turns into no-ops (C4 reconnect resends)"),
    "reconnects_per_device_per_day": (10, "assumed", "network-driven reconnects per device on a typical day"),
    "resend_frames_per_reconnect": (1, "measured:C4-small-n", "step2 frames a client re-sends per reconnect"),

    # ---- base path (flag off) ----
    "base_flush_ms": (250, "code:server/src/server.ts PERSIST_DEBOUNCE_MS",
                      "base flush window; one durable append per window per body while frames arrive"),
    "base_rows_per_flush": (10, "inferred:coresmoke(11 incl. receipt)",
                            "rows written per base socket flush (clock, journal, attribution, head, catalog + indexes)"),
    "base_candidate_posts_per_burst": (1, "measured:D8/L5", "HTTP candidate POSTs per edit burst (IDB candidate)"),
    "base_candidate_rows": (11, "assumed<<C4>>", "rows per candidate commit (receipt + journal/head/catalog when it appends)"),
    "base_ws_msgs_per_frame": (1, "code:vaultSocketService.ts", "incoming WS messages per update frame"),

    # ---- relay path ----
    "relay_microbatch_ms": (0, "code:relayFlag.ts YAOS_RELAY_MICROBATCH_MS", "0 = one append per frame; max 50"),
    "relay_rows_per_append": (11, "measured:coresmoke", "CF rowsWritten per relay append incl. candidate receipt"),
    "relay_ws_msgs_per_frame": (2, "code:relayBodies.ts", "envelope text frame + binary update frame"),
    "relay_candidate_posts_per_burst": (0, "design:D7", "socket-ack receipts replace the HTTP candidate"),

    # ---- checkpoints (both paths use 50 entries / 1 MiB) ----
    "checkpoint_entries": (50, "code:relayFlag.ts / server.ts JOURNAL_COMPACT_ENTRIES", "tail rows per checkpoint"),
    "checkpoint_fixed_rows": (8, "assumed<<K1>>", "chunk + manifest rows with indexes, head/prune bookkeeping, setAlarm"),
    "journal_delete_rows_per_entry": (2, "code:vaultDocumentStore.ts persistCheckpoint",
                                      "row + index delete per pruned journal row (0 if the feed floor never advances)"),
    "relay_checkpoint_alarm_requests": (1, "code:server.ts alarm()", "DO requests per checkpoint alarm"),

    # ---- heavy import ----
    "import_notes": (2000, "assumed", "notes created in one import"),
    "import_rows_per_note": (25, "assumed<<measure>>", "rows per created note (lifecycle, catalog, root, head, checkpoint)"),
    "import_do_requests_per_note": (1.2, "assumed<<measure>>", "DO requests per imported note (batched create + root publish)"),
    "import_worker_requests_per_note": (1.2, "assumed<<measure>>", "Worker requests per imported note"),
    "import_initial_frames_per_note": (1, "assumed", "body frames sent when each imported note is first opened/synced"),
}


@dataclass
class Row:
    scenario: str
    mode: str
    do_requests: float
    worker_requests: float
    rows_written: float
    notes: str


def idle(p: dict[str, float], mode: str) -> Row:
    sockets = p["devices"] * (1 + p["idle_body_sockets_per_device"])
    msgs = sockets * (86_400 / p["ping_interval_s"] + 86_400 / p["ticket_refresh_interval_s"])
    do_req = msgs / p["ws_billing_ratio"] + p["idle_alarms_per_day"]
    rows = p["idle_alarms_per_day"]  # setAlarm = 1 row
    worker = 0.0
    notes = f"{sockets:.0f} sockets, {msgs:,.0f} WS msgs"
    return Row("idle", mode, do_req, worker, rows, notes)


def _typing_seconds(p: dict[str, float]) -> float:
    return p["editing_hours"] * 3600 * p["typing_duty"]


def _appends(p: dict[str, float], mode: str) -> tuple[float, float]:
    """(appends/day, update frames/day) from typing alone."""
    t = _typing_seconds(p)
    frames = t * p["frames_per_typing_s"]
    if mode == "base":
        per_s = min(p["frames_per_typing_s"], 1000 / p["base_flush_ms"])
    else:
        mb = p["relay_microbatch_ms"]
        per_s = p["frames_per_typing_s"] if mb <= 0 else min(p["frames_per_typing_s"], 1000 / mb)
        per_s *= (1 - p["noop_fraction"])
    return t * per_s, frames


def _checkpoint_cost(p: dict[str, float], appends: float) -> tuple[float, float]:
    checkpoints = appends / p["checkpoint_entries"]
    rows = checkpoints * (p["checkpoint_fixed_rows"] + p["checkpoint_entries"] * p["journal_delete_rows_per_entry"])
    return checkpoints, rows


def typical(p: dict[str, float], mode: str) -> Row:
    base_idle = idle(p, mode)
    appends, frames = _appends(p, mode)
    bursts = _typing_seconds(p) / p["burst_s"]
    reconnects = p["devices"] * p["reconnects_per_device_per_day"]
    ws_per_frame = p["base_ws_msgs_per_frame"] if mode == "base" else p["relay_ws_msgs_per_frame"]
    msgs = frames * (ws_per_frame + p["awareness_msgs_per_frame"]) + reconnects * p["resend_frames_per_reconnect"]
    posts = bursts * (p["base_candidate_posts_per_burst"] if mode == "base" else p["relay_candidate_posts_per_burst"])
    checkpoints, ck_rows = _checkpoint_cost(p, appends)
    if mode == "base":
        rows_append = appends * p["base_rows_per_flush"] + posts * p["base_candidate_rows"]
        evictions = p["idle_evictions_per_day"]
        rec_do = (reconnects + evictions) * p["base_reconnect_do_requests"]
        rec_worker = (reconnects + evictions) * p["base_reconnect_worker_requests"]
        rec_rows = (reconnects + evictions) * p["base_reconnect_rows_written"]
        resend_rows = 0.0  # base validation doc drops redundant resends
    else:
        rows_append = appends * p["relay_rows_per_append"]
        # relay sockets survive eviction (B1); only network reconnects cost an upgrade + step1
        rec_do = reconnects * 2
        rec_worker = reconnects * 2
        rec_rows = 0.0
        # large bodies (> exact-merge bytes) append step2 resends that are not byte-identical
        resend_rows = 0.0
    do_req = base_idle.do_requests + msgs / p["ws_billing_ratio"] + posts + checkpoints * (
        p["relay_checkpoint_alarm_requests"] if mode == "relay" else 0) + rec_do
    worker = base_idle.worker_requests + posts + rec_worker
    rows = base_idle.rows_written + rows_append + ck_rows + checkpoints + rec_rows + resend_rows
    notes = f"{frames:,.0f} frames, {appends:,.0f} appends, {posts:,.0f} POSTs, {checkpoints:,.0f} ckpts"
    return Row("typical", mode, do_req, worker, rows, notes)


def heavy_import(p: dict[str, float], mode: str) -> Row:
    t = typical(p, mode)
    n = p["import_notes"]
    rows = n * p["import_rows_per_note"]
    do_req = n * p["import_do_requests_per_note"]
    worker = n * p["import_worker_requests_per_note"]
    frames = n * p["import_initial_frames_per_note"] * p["devices"]
    ws_per_frame = p["base_ws_msgs_per_frame"] if mode == "base" else p["relay_ws_msgs_per_frame"]
    do_req += frames * ws_per_frame / p["ws_billing_ratio"]
    if mode == "relay":
        rows += n * p["import_initial_frames_per_note"] * p["relay_rows_per_append"]
    else:
        rows += n * p["import_initial_frames_per_note"] * p["base_rows_per_flush"]
    return Row("typical+import", mode, t.do_requests + do_req, t.worker_requests + worker,
               t.rows_written + rows, f"+{n:,.0f} notes")


def pct(value: float, limit: float) -> str:
    return f"{100 * value / limit:.0f}%"


def render(rows: list[Row], p: dict[str, float]) -> str:
    out = ["| Day shape | Mode | DO req/day | % free | Worker req/day | % free | Rows written/day | % free | Notes |",
           "|---|---|---:|---:|---:|---:|---:|---:|---|"]
    for r in rows:
        out.append(
            f"| {r.scenario} | {r.mode} | {r.do_requests:,.0f} | {pct(r.do_requests, p['free_do_requests_per_day'])} "
            f"| {r.worker_requests:,.0f} | {pct(r.worker_requests, p['free_worker_requests_per_day'])} "
            f"| {r.rows_written:,.0f} | {pct(r.rows_written, p['free_rows_written_per_day'])} | {r.notes} |")
    # headroom: typing hours/day before the rows-written limit
    out.append("")
    out.append("| Mode | Rows per typing-second | Typing hours/day to hit 100k rows (excl. idle) |")
    out.append("|---|---:|---:|")
    for mode in ("base", "relay"):
        q = dict(p)
        q["editing_hours"] = 1.0
        q["typing_duty"] = 1.0
        appends, _ = _appends(q, mode)
        _, ck = _checkpoint_cost(q, appends)
        per_append = p["base_rows_per_flush"] if mode == "base" else p["relay_rows_per_append"]
        posts = 3600 / p["burst_s"] * (p["base_candidate_posts_per_burst"] if mode == "base" else 0)
        cand = posts * p["base_candidate_rows"]
        per_hour = appends * per_append + ck + appends / p["checkpoint_entries"] + cand
        hours = p["free_rows_written_per_day"] / per_hour if per_hour else math.inf
        out.append(f"| {mode} | {per_hour / 3600:.1f} | {hours:.2f} |")
    return "\n".join(out)


def main(argv: list[str]) -> int:
    if "--wb" in argv:  # write-budget spike model (separate parameter set; see wb/wbmodel.py)
        import os
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "wb"))
        import wbmodel  # noqa: PLC0415
        return wbmodel.main([x for x in argv if x != "--wb"])
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--json", help="JSON object of parameter overrides")
    ap.add_argument("--list", action="store_true", help="list parameters and exit")
    ap.add_argument("--format", choices=["md", "json"], default="md")
    args = ap.parse_args(argv)
    if args.list:
        for name, (value, prov, desc) in PARAMS.items():
            print(f"{name:34} {value!s:>10}  {prov:48} {desc}")
        return 0
    p = {name: float(v[0]) for name, v in PARAMS.items()}
    overrides: dict[str, float] = {}
    if args.json:
        with open(args.json, encoding="utf-8") as fh:
            overrides.update({k: float(v) for k, v in json.load(fh).items()})
    for item in args.set:
        name, _, value = item.partition("=")
        overrides[name] = float(value)
    unknown = sorted(set(overrides) - set(p))
    if unknown:
        print(f"unknown parameter(s): {', '.join(unknown)}", file=sys.stderr)
        return 2
    p.update(overrides)
    rows = [f(p, mode) for f in (idle, typical, heavy_import) for mode in ("base", "relay")]
    if args.format == "json":
        print(json.dumps({"params": p, "overrides": overrides,
                          "rows": [r.__dict__ for r in rows]}, indent=2))
    else:
        print(render(rows, p))
        if overrides:
            print("\nOverrides: " + ", ".join(f"{k}={v:g}" for k, v in sorted(overrides.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
