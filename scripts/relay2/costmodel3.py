#!/usr/bin/env python3
"""Relay v3 (group commit) cost model: extends costmodel.py (relay v2, RFC section 9) with v3 day shapes.

    python3 scripts/relay2/costmodel3.py --json measured-v3.json [--format md|json]

Inputs (JSON object; every key optional, defaults are the f1001 / relay3 values documented in RESULTS.md):
  base_rows_per_edit       base rows per keystroke (gql, idle-subtracted)       -> base_rows_per_flush = x * 5 / 4
  relay_rows_per_edit      relay v2 rows per keystroke (gql)
  v3_rows_per_edit         v3 rows per keystroke, real client (no candidateId; MB-v3nc-type5 gql)
  v3c_rows_per_edit        v3 rows per keystroke, harness client with candidateId (MB-v3-type5 gql)
  v3b5_rows_per_edit       v3 + B5 send-coalesce 250 ms rows per keystroke (MB-v3b5-type5 gql)
  v3b5_frames_per_edit     wire update frames per keystroke with B5 (MB-v3b5-type5 clientCoalesce)
  autosave_rows_per_save   v3 rows per 1 s plugin rewrite, open note (MB-v3nc-autosave gql)
  httpsave_rows_per_post   v3 rows per HTTP candidate POST, closed note (HTTPSAVE phaseLevel)
  base_autosave_rows_per_save  base rows per 1 s rewrite (inferred: one flush + one candidate POST)
Day shapes (3 devices, Free = 100k rows/day, 100k DO requests/day):
  typical  2 h editing, 25% typing duty, 5 frames/typing-s           (= RFC section 9)
  heavy    8 h editing, 40% typing duty
  autosave typical day + a plugin rewriting one note every 1 s for 8 h (open note: socket frames; closed note:
           the disk path admits once per 5 s max-wait -> one HTTP candidate POST per 5 s)
Checkpoint rows: the gql rows/edit already include them (whole-window), so checkpoint rows are zeroed as in run A.
Standard library only; all outputs are INFERRED from the measured inputs.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import costmodel as cm  # noqa: E402

DEFAULTS = {
    "base_rows_per_edit": 3.10,        # f1001 MB/C2 gql
    "relay_rows_per_edit": 5.92,       # f1001 MB-lean-mb10-stream gql
    "v3_rows_per_edit": 1.0,
    "v3c_rows_per_edit": 1.5,
    "v3b5_rows_per_edit": 1.0,
    "v3b5_frames_per_edit": 0.5,
    "autosave_rows_per_save": 3.0,
    "httpsave_rows_per_post": 15.0,
    "base_autosave_rows_per_save": 3.875 + 11,
}
SHAPES = {
    "typical": {"editing_hours": 2.0, "typing_duty": 0.25},
    "heavy": {"editing_hours": 8.0, "typing_duty": 0.40},
}
ZERO_CKPT = {"checkpoint_fixed_rows": 0, "journal_delete_rows_per_entry": 0}


def params(extra: dict[str, float]) -> dict[str, float]:
    p = {k: float(v[0]) for k, v in cm.PARAMS.items()}
    p.update(ZERO_CKPT)
    p.update(extra)
    return p


def config(m: dict[str, float], name: str) -> tuple[str, dict[str, float]]:
    """(costmodel mode, overrides) for a configuration."""
    fps = cm.PARAMS["frames_per_typing_s"][0]
    if name == "base":
        return "base", {"base_rows_per_flush": m["base_rows_per_edit"] * fps / min(fps, 4.0)}
    if name == "relay v2":
        return "relay", {"relay_rows_per_append": m["relay_rows_per_edit"], "relay_microbatch_ms": 10}
    if name == "v3":
        return "relay", {"relay_rows_per_append": m["v3_rows_per_edit"]}
    if name == "v3 (candidateId)":
        return "relay", {"relay_rows_per_append": m["v3c_rows_per_edit"]}
    if name == "v3+B5":
        # rows per keystroke measured; envelope + binary per WIRE frame, B5 sends fewer wire frames
        return "relay", {"relay_rows_per_append": m["v3b5_rows_per_edit"],
                         "relay_ws_msgs_per_frame": 2 * m["v3b5_frames_per_edit"]}
    raise KeyError(name)


CONFIGS = ["base", "relay v2", "v3", "v3 (candidateId)", "v3+B5"]


def rows_per_typing_s(m: dict[str, float], name: str) -> float:
    fps = cm.PARAMS["frames_per_typing_s"][0]
    mode, o = config(m, name)
    if mode == "base":
        # base flushes at most 4/s + one candidate per 10 s burst (11 rows)
        return o["base_rows_per_flush"] * min(fps, 4.0) + cm.PARAMS["base_candidate_rows"][0] / cm.PARAMS["burst_s"][0]
    return o["relay_rows_per_append"] * fps


def run(m: dict[str, float]) -> dict:
    out: list[dict] = []
    for shape, s in SHAPES.items():
        for name in CONFIGS:
            mode, o = config(m, name)
            r = cm.typical(params({**s, **o}), mode)
            out.append({"shape": shape, "config": name, "do_requests": r.do_requests, "worker_requests": r.worker_requests,
                        "rows_written": r.rows_written, "notes": r.notes})
    # Plugin autosave day: typical day + 8 h x 1 rewrite/s on one note.
    saves = 8 * 3600
    posts = saves / 5
    for name, path in (("base", "open"), ("v3", "open"), ("v3", "closed")):
        mode, o = config(m, name)
        t = cm.typical(params({**SHAPES["typical"], **o}), mode)
        p = params(o)
        if name == "base":
            rows = saves * m["base_autosave_rows_per_save"]
            do = saves * (p["base_ws_msgs_per_frame"] / p["ws_billing_ratio"] + 1)   # one candidate POST per save (250 ms debounce < 1 s)
            worker = saves
            note = "inferred: 1 flush + 1 candidate POST per save"
        elif path == "open":
            rows = saves * m["autosave_rows_per_save"]
            do = saves * p["relay_ws_msgs_per_frame"] / p["ws_billing_ratio"]
            worker = 0
            note = "open note: 1 socket frame per save (MB autosave gql)"
        else:
            rows = posts * m["httpsave_rows_per_post"]
            do = posts
            worker = posts
            note = "closed note: 1 HTTP candidate per 5 s (HTTPSAVE gql)"
        out.append({"shape": f"autosave-8h ({path} note)", "config": name, "do_requests": t.do_requests + do,
                    "worker_requests": t.worker_requests + worker, "rows_written": t.rows_written + rows, "notes": note})
    hours = {name: 100_000 / (rows_per_typing_s(m, name) * 3600) for name in CONFIGS}
    return {"inputs": m, "rows": out, "rows_per_typing_s": {n: rows_per_typing_s(m, n) for n in CONFIGS},
            "typing_hours_to_100k": hours}


def render(res: dict) -> str:
    lines = ["| Day shape | Config | DO req/day | % Free | x base | Worker req/day | Rows written/day | % Free | x base | Notes |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---|"]
    base = {r["shape"]: r for r in res["rows"] if r["config"] == "base"}
    for r in res["rows"]:
        b = base.get(r["shape"]) or base.get(r["shape"].replace("closed", "open"))
        xd = f"{r['do_requests'] / b['do_requests']:.2f}" if b else ""
        xr = f"{r['rows_written'] / b['rows_written']:.2f}" if b else ""
        lines.append(f"| {r['shape']} | {r['config']} | {r['do_requests']:,.0f} | {100 * r['do_requests'] / 1e5:.1f}% | {xd} "
                     f"| {r['worker_requests']:,.0f} | {r['rows_written']:,.0f} | {100 * r['rows_written'] / 1e5:.0f}% | {xr} | {r['notes']} |")
    lines += ["", "| Config | Rows per typing-second | Non-stop typing hours/day to 100k rows (excl. idle) |", "|---|---:|---:|"]
    for n in CONFIGS:
        lines.append(f"| {n} | {res['rows_per_typing_s'][n]:.1f} | {res['typing_hours_to_100k'][n]:.2f} |")
    lines += ["", "Inputs: " + ", ".join(f"{k}={v:g}" for k, v in res["inputs"].items())]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--format", choices=["md", "json"], default="md")
    a = ap.parse_args(argv)
    m = dict(DEFAULTS)
    if a.json:
        m.update({k: float(v) for k, v in json.loads(Path(a.json).read_text()).items()})
    for item in a.set:
        k, _, v = item.partition("=")
        m[k] = float(v)
    unknown = sorted(set(m) - set(DEFAULTS))
    if unknown:
        print(f"unknown input(s): {', '.join(unknown)}", file=sys.stderr)
        return 2
    res = run(m)
    print(json.dumps(res, indent=2) if a.format == "json" else render(res))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
