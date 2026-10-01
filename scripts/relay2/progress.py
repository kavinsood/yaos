#!/usr/bin/env python3
"""runfast.sh progress log helper (standard library only).

    progress.py event <logdir> key=value ...   append one JSON line to <logdir>/progress.jsonl, refresh progress.json
    progress.py snapshot <logdir>              refresh <logdir>/progress.json from plan.tsv + progress.jsonl

progress.jsonl: one event per line {"at", "phase", "status", ...}; phase "_stage" lines mark run stages.
progress.json: {"stage", "counts", "phases": {id: {lane, variant, est_min, status, worker, attempt, start, end, ...}}}.
Statuses: pending → provisioning → provisioned → running → done | retry | failed (after the last attempt) | skip
(an earlier run's valid output exists).
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from datetime import datetime, timezone


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot(d: str) -> None:
    plan: dict[str, dict] = {}
    order: list[str] = []
    try:
        for line in open(os.path.join(d, "plan.tsv")):
            if not line.strip() or line.startswith("#"):
                continue
            pid, lane, variant, est, *rest = line.rstrip("\n").split("\t")
            plan[pid] = {"lane": lane, "variant": variant, "est_min": float(est or 0), "status": "pending"}
            order.append(pid)
    except FileNotFoundError:
        pass
    meta: dict = {}
    stage = None
    try:
        lines = open(os.path.join(d, "progress.jsonl")).read().splitlines()
    except FileNotFoundError:
        lines = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        pid = e.get("phase")
        if pid == "_stage":
            stage = e.get("status")
            meta.setdefault("startedAt", e.get("at"))
            for k in ("tag", "sha", "small", "pid", "jobs"):
                if k in e:
                    meta[k] = e[k]
            continue
        p = plan.setdefault(pid, {"lane": e.get("lane"), "variant": e.get("variant"), "status": "pending"})
        if pid not in order:
            order.append(pid)
        for k, v in e.items():
            if k in ("phase", "at"):
                continue
            p[k] = v
        p["updatedAt"] = e.get("at")
    counts: dict[str, int] = {}
    for p in plan.values():
        counts[p["status"]] = counts.get(p["status"], 0) + 1
    out = {**meta, "stage": stage, "updatedAt": now(), "counts": counts,
           "running": [k for k in order if plan[k]["status"] in ("running", "provisioning")],
           "failed": [k for k in order if plan[k]["status"] == "failed"],
           "phases": {k: plan[k] for k in order}}
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".progress.", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    os.replace(tmp, os.path.join(d, "progress.json"))


def event(d: str, kv: list[str]) -> None:
    e: dict = {"at": now()}
    for item in kv:
        k, _, v = item.partition("=")
        if v.lstrip("-").isdigit() and k not in ("phase", "worker", "sha", "tag"):
            e[k] = int(v)
        else:
            e[k] = v
    with open(os.path.join(d, ".progress.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with open(os.path.join(d, "progress.jsonl"), "a") as f:
            f.write(json.dumps(e) + "\n")
        snapshot(d)


if __name__ == "__main__":
    cmd, d, *rest = sys.argv[1:]
    if cmd == "event":
        event(d, rest)
    elif cmd == "snapshot":
        snapshot(d)
    else:
        sys.exit(f"unknown command {cmd}")
