#!/usr/bin/env python3
"""Summarise a runall raw directory into the markdown tables used by results/relay2/RESULTS.md.

    python3 scripts/relay2/summarize.py --dir <raw dir> [--v1 results/A5.md] > tables.md

Reads every <scenario>-<variant>.json that runall.sh writes (variants: base = flag off with the primary
vars, relay = primary relay v2 config, strict = relay with lean rows off and microbatch 0), plus the
convergence-suite*.json files, and prints:
  - a run index (worker, version id, SHA, start time, vars) per JSON,
  - one table per section (L, C, B, X, K, MB),
  - frame-outcome accounting, connection events, convergence pass/fail,
  - free-plan notes (CPU per invocation against 10 ms, rows written per edit).
Every number is read from the JSON; nothing is computed except ratios (base p50 / relay p50).
C1 CPU comes from analyze.py (tail match); it is run on demand and cached as <file>.tail.json.
Standard library only.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VARIANTS = ("base", "relay", "strict")


def load(d: str) -> dict[str, dict]:
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        name = os.path.basename(f)[:-5]
        if name.endswith(".tail") or name.endswith(".gql"):
            continue
        try:
            out[name] = json.load(open(f))
        except Exception as e:  # noqa: BLE001
            print(f"<!-- unreadable {f}: {e} -->", file=sys.stderr)
    return out


def g(o, *path, default=None):
    for p in path:
        if isinstance(o, dict) and p in o:
            o = o[p]
        elif isinstance(o, list) and isinstance(p, int) and -len(o) <= p < len(o):
            o = o[p]
        else:
            return default
    return o


def summ(o):
    """Accept {summary:{...}} or a bare summary dict."""
    if isinstance(o, dict) and isinstance(o.get("summary"), dict):
        return o["summary"]
    if isinstance(o, dict) and "p50" in o:
        return o
    return None


def num(x, d=1):
    if x is None:
        return "–"
    if isinstance(x, bool):
        return "yes" if x else "no"
    if isinstance(x, (int, float)):
        if isinstance(x, float) and abs(x) >= 100:
            d = 0
        s = f"{x:.{d}f}" if isinstance(x, float) else str(x)
        return s
    return str(x)


def pct(o, keys=("p50", "p90", "p99")):
    s = summ(o)
    if not s:
        return "–"
    return " / ".join(num(s.get(k)) for k in keys) + f" (n={s.get('n')})"


def p50(o):
    s = summ(o)
    return s.get("p50") if s else None


def ratio(b, r):
    if b is None or r is None or r == 0:
        return "–"
    return f"{b / r:.2f}x"


def table(head: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for r in rows:
        out.append("| " + " | ".join(num(c) if not isinstance(c, str) else c for c in r) + " |")
    return "\n".join(out)


class S:
    def __init__(self, runs: dict[str, dict], raw_dir: str):
        self.r = runs
        self.dir = raw_dir

    def v(self, sid: str, variant: str):
        return self.r.get(f"{sid}-{variant}")

    # ---------------------------------------------------------------- index
    def index(self) -> str:
        rows = []
        for name, d in sorted(self.r.items(), key=lambda kv: kv[1].get("startedAt") or kv[1].get("generatedAt") or ""):
            if name.startswith("convergence-suite"):
                continue
            vars_ = d.get("vars") or {}
            cfg = []
            if "YAOS_RELAY_BODIES" in vars_:
                cfg.append("bodies=" + str(vars_["YAOS_RELAY_BODIES"]))
            if "YAOS_RELAY_LEAN_ROWS" in vars_:
                cfg.append("lean=" + str(vars_["YAOS_RELAY_LEAN_ROWS"]))
            if "YAOS_RELAY_MICROBATCH_MS" in vars_:
                cfg.append("mb=" + str(vars_["YAOS_RELAY_MICROBATCH_MS"]))
            relay = d.get("relay")
            rows.append([
                f"`{name}`", d.get("scenario"), (d.get("workerName") or "").replace("yaos-relay2-", "…"),
                (d.get("deploymentVersionId") or "")[:8], (d.get("deployedSpikeSha") or d.get("spikeSha") or "")[:8],
                (d.get("startedAt") or "")[:19].replace("T", " "), "on" if relay else ("off" if relay is False else "–"),
                " ".join(cfg), g(d, "edge", "colo"),
            ])
        return table(["file", "scenario", "worker (yaos-relay2-…)", "version", "SHA", "started (UTC)", "relay", "vars", "colo"], rows)

    # ---------------------------------------------------------------- latency
    def latency(self) -> str:
        rows = []

        def add(label, getter, keys=("p50", "p90", "p99"), variants=VARIANTS):
            cells = {}
            for v in variants:
                d = self.v(label.split(" ")[0], v)
                cells[v] = getter(d) if d else None
            b, r, s = cells.get("base"), cells.get("relay"), cells.get("strict")
            rows.append([label, pct(b, keys), pct(r, keys), pct(s, keys) if "strict" in variants else "n/a",
                         ratio(p50(b), p50(r)), ratio(p50(b), p50(s)) if "strict" in variants else "n/a"])

        add("L1 ping RTT", lambda d: d.get("rttMs"))
        add("L2 propagation A→B", lambda d: d.get("propagationMs"))
        add("L2 origin ack", lambda d: d.get("originAckMs"))
        add("L3 64k note, before trace", lambda d: g(d, "pre", "propagationMs"))
        add("L3 replay per frame", lambda d: g(d, "replay", "perFramePropagationMs"), ("p50", "p90", "p99", "max"))
        add("L3 after 5,000-edit trace", lambda d: g(d, "post", "propagationMs"))
        add("L4 stream 25/s per frame", lambda d: d.get("perFramePropagationMs"), ("p50", "p90", "p99", "max"))
        add("L6 open→synced cold", lambda d: g(d, "cold", "totalMs"))
        add("L6 open→synced warm", lambda d: g(d, "warm", "totalMs"))
        add("L7 HEAD after ack", lambda d: d.get("headMs"))
        add("L7 GET after ack", lambda d: d.get("getMs"))
        add("L7 edit→HEAD shows it", lambda d: d.get("headVisibleSinceSendMs"))
        out = [table(["measurement", "base p50/p90/p99", "relay v2 p50/p90/p99", "relay-strict p50/p90/p99", "base/relay", "base/strict"], rows)]
        # L2 sequence per edit
        seq = []
        for v in VARIANTS:
            d = self.v("L2", v)
            if d:
                n = d.get("n")
                seq.append([v, n, d.get("sequenceDelta"), g(d, "propagationMs", "summary", "n")])
        out.append("\nL2 vault-sequence delta (lean coalescing writes extra clock/event rows, so delta can exceed edits):\n")
        out.append(table(["variant", "edits (n)", "sequence delta", "propagation samples"], seq))
        # L7 correctness
        c = []
        for v in VARIANTS:
            d = self.v("L7", v)
            if d:
                c.append([v, json.dumps(d.get("correctness"))])
        if c:
            out.append("\nL7 correctness (counts of samples whose HEAD hash / GET text / GET hash matched the client after ack):\n")
            out.append(table(["variant", "correctness"], c))
        # L5
        l5 = []
        for b in (1, 8):
            for v in ("base", "relay"):
                d = self.r.get(f"L5b{b}-{v}")
                if not d:
                    continue
                for mode, res in (d.get("results") or {}).items():
                    l5.append([f"burst {b}", v, mode, pct(res.get("editToClearedMs"), ("p50", "p90")),
                               pct(res.get("lastEditToClearedMs"), ("p50", "p90")),
                               num(g(res, "wirePerSample", "doRequestUnits", "summary", "p50"), 2),
                               num(g(res, "wirePerSample", "httpRequests", "summary", "p50"))])
        out.append("\nL5 edit → settled receipt (IDB candidate cleared):\n")
        out.append(table(["burst", "build", "mode", "first edit→cleared p50/p90", "last edit→cleared p50/p90", "DO units/burst p50", "HTTP req/burst p50"], l5))
        return "\n".join(out)

    # ---------------------------------------------------------------- cost
    def c1(self) -> str:
        rows = []
        for v in VARIANTS:
            d = self.v("C1", v)
            if not d:
                continue
            f = os.path.join(self.dir, f"C1-{v}.json")
            tj = os.path.join(self.dir, f"C1-{v}.tail.json")
            tail = None
            if d.get("tailFile") and os.path.exists(d["tailFile"]):
                if not os.path.exists(tj):
                    subprocess.run([sys.executable, os.path.join(HERE, "analyze.py"), f, "--out", tj],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if os.path.exists(tj):
                    tail = json.load(open(tj))
            for part in ("small", "heavy"):
                ss = g(tail, "sampleSets", f"{part}.samples") if tail else None
                cpu = g(ss, "cpuMs") or {}
                rows.append([v, part, g(d, part, "textLength"), pct(g(d, part, "propagationMs"), ("p50", "p90")),
                             f"{g(ss, 'matchedTailEvents')}/{g(ss, 'sent')}" if ss else "no tail",
                             num(cpu.get("p50")), num(cpu.get("p90")), num(cpu.get("mean"), 2), num(cpu.get("max"))])
        return table(["build", "note", "chars", "propagation p50/p90", "tail matched", "cpu p50 ms", "cpu p90 ms", "cpu mean ms", "cpu max ms"], rows)

    def c2(self) -> str:
        rows = []
        for trace in ("quick", "stress"):
            for v in VARIANTS:
                d = self.r.get(f"C2-{trace}-{v}")
                if not d:
                    continue
                inv = g(d, "cpu", "wsMessageInvocationCpuUs", 0) or {}
                stream = next((w for w in d.get("gql") or [] if w.get("name") == "stream"), {})
                rows.append([trace, v, d.get("frames"), d.get("clients"),
                             num(g(d, "cpu", "perUpdateUsFromMinutes", "perEdit")), num(inv.get("p50")), num(inv.get("p99")),
                             num(g(d, "rowsWritten", "perEdit"), 2), num(g(d, "inboundWsMessages", "perEdit"), 2),
                             pct(d.get("perFramePropagationMs"), ("p50", "p99")) if d.get("latencyUsed", True) else "not used (max-rate)",
                             num(g(d, "phaseLevel", "cpuTimeUs", "perUnit")), num(g(d, "phaseLevel", "rowsWritten", "perUnit"), 2),
                             num(g(stream, "totals", "exceededCpuErrors")),
                             "yes" if stream.get("attributionSuspect") else "no",
                             "yes" if stream.get("totalsStable") else "no"])
        return table(["trace", "build", "frames", "clients", "CPU µs/edit (periodic)", "WS msg CPU p50 µs", "WS msg CPU p99 µs",
                      "rows written/edit", "inbound WS/edit", "propagation p50/p99", "phase CPU µs/edit", "phase rows/edit", "exceededCpu", "attribution suspect", "totals stable"], rows)

    def c3(self) -> str:
        rows = []
        for v in ("base", "relay"):
            d = self.v("C3", v)
            if not d:
                continue
            for s in d.get("snapshots") or []:
                rows.append([v, s.get("step"), s.get("sockets"), s.get("residentBodies"),
                             num((g(s, "crdtMemory", "linearMemoryBytes") or 0) / 1e6, 2),
                             num((s.get("residentEncodedStateBytes") or 0) / 1e3, 1)])
            rows.append([v, f"{g(d, 'big', 'count')} × {g(d, 'big', 'bytes')} B opens", "", "", pct(g(d, "big", "openTotalMs"), ("p50", "p90")),
                         f"failures: {len(d.get('smallFailures') or [])}"])
        return table(["build", "step", "sockets", "resident bodies", "linear memory MB", "resident encoded KB"], rows)

    def c4(self) -> str:
        rows = []
        for v in VARIANTS:
            d = self.v("C4", v)
            if not d:
                continue
            rs = d.get("relayStats") or {}
            def cdelta(a, b, k):
                x, y = g(rs, a, "counters", k), g(rs, b, "counters", k)
                return None if x is None or y is None else y - x
            edits, recon = d.get("edits"), d.get("reconnects")
            rw_e = cdelta("before", "afterEdits", "rowsWritten")
            rw_r = cdelta("afterEdits", "afterReconnects", "rowsWritten")
            gq = self.r.get(f"C4-{v}.gql")
            rows.append([v, edits, recon, num(d.get("sequencePerEdit"), 2), num(d.get("sequencePerReconnect"), 2),
                         num(rw_e / edits, 2) if rw_e is not None and edits else "–",
                         num(rw_r / recon, 2) if rw_r is not None and recon else "–",
                         pct(d.get("ackMs"), ("p50", "p90")),
                         "pass" if g(d, "frameOutcomes", "total", "pass") else ("n/a" if g(d, "frameOutcomes", "total", "available") is False else "–")])
        return table(["build", "edits", "reconnects", "vault seq/edit", "vault seq/reconnect", "relay-counter rows/edit",
                      "relay-counter rows/reconnect", "ack p50/p90", "frame accounting"], rows)

    def c5(self) -> str:
        rows = []
        for v in ("base", "relay"):
          for name in (f"C5-{v}", f"C5-bursts-{v}", f"C5-catchups-{v}"):
            d = self.r.get(name)
            if not d:
                continue
            for unit in ("perBurst", "perCatchup"):
                x = g(d, "derived", unit)
                if not x:
                    continue
                rows.append([v, x.get("unit"), x.get("units"), num(x.get("httpPlusAlarmRequestsPerUnit"), 2),
                             num(x.get("inboundWsPerUnit"), 2), num(x.get("outboundWsPerUnit"), 2),
                             num(x.get("doRequestUnitsPerUnit"), 2), num(x.get("rowsWrittenPerUnit"), 2),
                             num(g(d, "phaseLevel", "doRequestUnitsPerUnit"), 2), num(g(d, "phaseLevel", "rowsWritten", "perUnit"), 2)])
            rows.append([v, "burst propagation / catch-up open", "", pct(d.get("burstPropagationMs"), ("p50", "p90")),
                         pct(d.get("catchupOpenMs"), ("p50", "p90")), "", "", "", "", ""])
        return table(["build", "unit", "n", "HTTP+alarm req", "inbound WS", "outbound WS", "DO request units", "rows written",
                      "phase DO units/unit", "phase rows/unit"], rows)

    def c6(self) -> str:
        d = self.r.get("C6-relay")
        if not d:
            return "(no C6)"
        rows = []
        for k in ("compare", "self"):
            x = d.get(k) or {}
            rows.append([x.get("worker"), num(g(x, "bundle", "uploadKiB"), 2), num(g(x, "bundle", "gzipKiB"), 2), x.get("startupMs")])
        return table(["worker", "upload KiB", "gzip KiB", "startup ms"], rows)

    # ---------------------------------------------------------------- behaviour
    def behaviour(self) -> str:
        rows = []
        for v in ("base", "relay"):
            d = self.v("B1", v)
            if not d:
                continue
            steps = []
            for k in ("warm", "afterIdle", "second", "afterRestart", "afterRestart2"):
                x = d.get(k) or {}
                cl = x.get("aClosed") or x.get("bClosed")
                steps.append(f"{k}: {num(x.get('propagationMs'))} ms" + (f" CLOSED {cl.get('code')} {cl.get('reason')}" if isinstance(cl, dict) else ""))
            ep = d.get("runtimeEpochs") or {}
            rows.append(["B1", v, f"idle {d.get('idleMs')} ms; runtime epoch changed after idle: {ep.get('beforeIdle') != ep.get('afterIdle')}; " + "; ".join(steps),
                         num(d.get("convergencePass"))])
        for v in ("base", "relay"):
            d = self.v("B2", v)
            if d:
                t = d.get("trace") or {}
                rows.append(["B2", v, f"50 edits ×{d.get('reps')}: time-to-current {pct(g(d, 'small', 'timeToCurrentMs'), ('p50', 'p90'))}, since ws open {pct(g(d, 'small', 'sinceWsOpenMs'), ('p50', 'p90'))}, bytes in p50 {num(g(d, 'small', 'bytesIn', 'summary', 'p50'))}; "
                             f"{t.get('frames')}-edit trace: {num(t.get('timeToCurrentMs'))} ms, {t.get('bytesIn')} B in, transport read {g(t, 'transport', 'read')} B",
                             num(d.get("convergencePass"))])
        for v in ("base", "relay"):
            d = self.v("B3", v)
            if d:
                rows.append(["B3", v, f"{d.get('edited')} relay-edited of 100: bootstrap {pct(d.get('bootstrapMs'), ('p50', 'p90'))}, bytes {g(d, 'runs', 0, 'bytes')}, all match {d.get('allMatch')}",
                             num(d.get("convergencePass"))])
        for v in ("base", "relay"):
            d = self.v("B4", v)
            if d:
                parts = []
                for run in d.get("runs") or []:
                    c = run.get("close") or {}
                    parts.append(f"close {c.get('code')} '{c.get('reason')}' {num(c.get('sinceRevokeStartMs'))} ms after revoke start; frames after revoke done {run.get('sentAfterRevokeDone')}, appended after revoke done {run.get('appendedSentAfterRevokeDone')}")
                rows.append(["B4", v, "; ".join(parts) + f"; allPass {d.get('allPass')}", num(d.get("convergencePass"))])
        d = self.r.get("B5-relay")
        if d:
            rs = d.get("raceSummary") or {}
            up = d.get("upload") or {}
            ups = ", ".join(f"{k}: {num(g(x, 'uploadMs', 'p50'))} ms upload, {x.get('requestBytes')} B request, installed {x.get('installed')}/{x.get('n')}, GET matches {x.get('getMatches')}" for k, x in up.items())
            rows.append(["B5", "relay", f"races {rs.get('passed')}/{rs.get('n')} pass, winners {rs.get('winners')}, race p50 {num(g(rs, 'raceMs', 'p50'))} ms; cover workaround: {'off' if '--no-cover' in (d.get('argv') or []) else 'ON'}; K2 upload: {ups}",
                         num(rs.get("passed") == rs.get("n") and rs.get("n") is not None)])
        for v in ("base", "relay"):
            d = self.v("B6", v)
            if d and d.get("skipped"):
                rows.append(["B6", v, "skipped: " + str(d["skipped"]), "–"])
            elif d:
                r = d.get("resend") or {}
                rows.append(["B6", v, f"{d.get('resends')} resends: appendsDelta {r.get('appendsDelta')}, dedupeHits {r.get('dedupeHitsDelta')}, exactly one append {r.get('exactlyOneAppend')}, same receipt {r.get('sameReceiptReturned')}; reused id rejected {g(d, 'reused', 'rejected')}",
                             num(d.get("convergencePass"))])
        for v in VARIANTS:
            d = self.v("B7", v)
            if d:
                fc = d.get("flooderClosed") or {}
                rows.append(["B7", v, f"target {d.get('targetMiBps')} MiB/s, achieved {num(d.get('achievedMiBps'), 2)} MiB/s; flooder closed {fc.get('code')} '{fc.get('reason')}' at {num(fc.get('at'))} ms; bystander p50 idle {num(g(d, 'idle', 'propagationMs', 'summary', 'p50'))} → under flood {num(g(d, 'underFlood', 'propagationMs', 'summary', 'p50'))} ms ({num(d.get('p50ChangePct'))} %); pass {d.get('pass')}",
                             num(d.get("convergencePass"))])
        for v in ("base", "relay"):
            d = self.v("B8", v)
            if d:
                cl = d.get("closes") or {}
                rows.append(["B8", v, f"delete {num(d.get('deleteMs'))} ms; closes " + ", ".join(f"{k}={x.get('code')} '{x.get('reason')}' +{num(x.get('sinceDeleteMs'))} ms" for k, x in cl.items() if isinstance(x, dict)) +
                             f"; reopen → {g(d, 'reopenAfterDelete', 'httpStatus')} {g(d, 'reopenAfterDelete', 'message')}; GET after {d.get('getAfterStatus')}",
                             num(d.get("convergencePass"))])
        for v in ("base", "relay"):
            d = self.v("CW", v)
            if d:
                i7 = d.get("invariant7") or {}
                rows.append(["CW", v, f"{d.get('writers')} writers × {d.get('seconds')} s, {d.get('edits')} edits; invariant 7 holds {i7.get('holds')}/{i7.get('checksWithRecordedHash')}, violations {i7.get('violations')}",
                             num(d.get("convergencePass"))])
        return table(["id", "build", "result", "converged"], rows)

    # ---------------------------------------------------------------- limits
    def limits(self) -> str:
        out = []
        rows = []
        for v in ("base", "relay"):
            d = self.v("X1", v)
            if not d:
                continue
            for s in d.get("stepResults") or []:
                rows.append([v, s.get("target"), s.get("open"), s.get("failed"), json.dumps(s.get("closeCodes") or {}),
                             num(s.get("openMs")), pct(g(s, "probe", "propagationMs"), ("p50", "p90")),
                             num((g(s, "diag", "crdtMemory", "linearMemoryBytes") or 0) / 1e6, 2), g(s, "diag", "residentBodies")])
            rows.append([v, "first failure", json.dumps(d.get("firstFailure")), "", json.dumps(d.get("failureModes")), "", "", "", ""])
        out.append("X1 concurrent body sockets per vault:\n\n" + table(["build", "target", "open", "failed", "close codes", "open ms (all)", "probe propagation p50/p90", "linear MB", "resident bodies"], rows))
        rows = []
        for v in VARIANTS:
            d = self.v("X2", v)
            if not d:
                continue
            for m in d.get("modes") or []:
                steps = "; ".join(f"{s.get('rate')}/s→{num(s.get('achievedRate'))}/s p50 {num(g(s, 'propagationMs', 'summary', 'p50'))} lost {s.get('lost')} closes {len(s.get('closed') or [])}{'' if s.get('withinTwiceFloor') else ' >2×floor'}" for s in m.get("steps") or [])
                rows.append([v, m.get("bodies"), d.get("floorPingP50Ms"), m.get("maxRateWithinTwiceFloor"), steps])
        out.append("\nX2 sustained append rate (max rate with p50 propagation ≤ 2× ping floor and no loss/closes):\n\n" + table(["build", "bodies", "floor ping p50 ms", "max edits/s within 2× floor", "steps"], rows))
        rows = []
        for v in ("base", "relay"):
            d = self.v("X3", v)
            if not d:
                continue
            for x in d.get("results") or []:
                opens = x.get("opens") or []
                rows.append([v, x.get("mb"), num(x.get("seedMs")), "/".join(num(o.get("totalMs")) for o in opens),
                             "/".join(num(o.get("step1ToStep2Ms")) for o in opens), all(o.get("correct") for o in opens) if opens else "–",
                             "/".join(num(q.get("totalMs")) for q in x.get("gets") or []), num(x.get("editAckMs")),
                             num(g(x, "compact", "ms")), g(x, "compact", "status"), num(g(x, "get", "ms")), g(x, "get", "textEqual"),
                             json.dumps(x.get("closedAfterEdit")) if x.get("closedAfterEdit") else "–"])
            rows.append([v, "converged", num(d.get("convergencePass"))] + [""] * 10)
        out.append("\nX3 large notes (open = ticket→synced incl. step2; compact = forced checkpoint):\n\n" + table(["build", "MB", "seed ms", "open ms", "step1→step2 ms", "open correct", "GET ms", "edit ack ms", "compact ms", "compact status", "GET after ms", "GET after equal", "closed after edit"], rows))
        rows = []
        for v in ("base", "relay"):
            d = self.v("X4", v)
            if d:
                h, s = d.get("httpCatchUp") or {}, d.get("socketReopen") or {}
                rows.append([v, d.get("bodies"), d.get("editsPerBody"), num(h.get("ms")), h.get("bytes"), h.get("current"), h.get("envelopeLimitHit"), h.get("error") or "–",
                             num(s.get("ms")), s.get("bytesIn"), s.get("current"), num(d.get("convergencePass"))])
        out.append("\nX4 catch-up of many stale bodies:\n\n" + table(["build", "bodies", "edits/body", "HTTP catch-up ms", "HTTP bytes", "current", "8 MiB limit hit", "error", "socket reopen ms", "socket bytes in", "current", "converged"], rows))
        return "\n".join(out)

    # ---------------------------------------------------------------- compaction
    def k1(self) -> str:
        rows = []
        for name in ("K1-compact-base", "K1-compact-relay", "K1-alarm-relay"):
            d = self.r.get(name)
            if not d:
                continue
            for s in d.get("summary") or []:
                ywb = s.get("ywasmBytes") or []
                rows.append([name, s.get("tail"), pct(s.get("compactMs"), ("p50", "p90")), pct(s.get("lastCheckpointMs"), ("p50", "p90")),
                             "/".join(map(str, s.get("logRowsBefore") or [])), "/".join(map(str, s.get("logRowsAfter") or [])),
                             "/".join(map(str, s.get("checkpointRowsWritten") or [])),
                             "; ".join("→".join(num(b / 1e6, 2) if isinstance(b, (int, float)) else "–" for b in pair)
                                       for pair in ywb if isinstance(pair, list))])
        return table(["run", "tail entries", "compact ms p50/p90", "alarm checkpoint ms p50/p90", "log rows before", "log rows after", "checkpoint rows written", "linear MB before→after"], rows)

    # ---------------------------------------------------------------- MB sweep
    def mb(self) -> str:
        rows = []
        names = [n for n in self.r if n.startswith("MB-")]

        def isbase(n):
            return n == "MB-base" or n.startswith("MB-base-")

        def key(n):
            d = self.r[n]
            return (0 if isbase(n) else 1, str(g(d, "vars", "YAOS_RELAY_LEAN_ROWS")), int(g(d, "microbatch", "effective") or 0), n)
        for n in sorted(names, key=key):
            d = self.r[n]
            lean = g(d, "vars", "YAOS_RELAY_LEAN_ROWS")
            mbms = g(d, "microbatch", "effective")
            for t in d.get("table") or []:
                part = next((p for p in d.get("parts") or [] if p.get("pattern") == t.get("pattern")), {})
                fo = part.get("frameOutcomes") or {}
                rows.append([n.replace("MB-", ""), "off" if isbase(n) else lean, "–" if isbase(n) else mbms, t.get("pattern"), t.get("edits"),
                             num(t.get("rowsPerEditGql"), 2), num(t.get("rowsPerEditRelayCounter"), 2),
                             num(t.get("propagationP50")), num(t.get("propagationP90")), num(g(part, "propagationMs", "summary", "p99")),
                             num(g(part, "gqlCpuUs", "perEdit")), num(g(d, "phaseLevel", "cpuTimeUs", "perUnit")), num(g(d, "phaseLevel", "rowsWritten", "perUnit"), 2),
                             "pass" if fo.get("pass") else ("n/a" if fo.get("available") is False else ("FAIL" if fo else "–"))])
        return table(["config", "lean", "mb ms", "pattern", "edits", "rows/edit (gql, idle-subtracted)", "rows/edit (relay counter)", "p50 ms", "p90 ms", "p99 ms", "CPU µs/edit", "phase CPU µs/edit", "phase rows/edit", "frame accounting"], rows)

    # ---------------------------------------------------------------- per-phase worker totals (runfast.sh + gqlfill --progress)
    def phases(self) -> str:
        rows = []
        for n, d in sorted(self.r.items()):
            p = d.get("gqlPhase")
            if not isinstance(p, dict):
                continue
            t = p.get("totals") or {}
            rows.append([n, p.get("worker"), " → ".join(str(x) for x in p.get("window") or []), t.get("cpuTime"), t.get("rowsWritten"),
                         t.get("inboundWsEffective"), p.get("httpRequests"), p.get("alarms"), p.get("doRequestUnits"),
                         "yes" if p.get("totalsStable") else "no"])
        return table(["phase", "worker", "window", "CPU µs", "rows written", "inbound WS", "HTTP", "alarms", "DO request units", "stable"], rows) if rows else "(no gqlPhase)"

    # ---------------------------------------------------------------- accounting
    def frame_accounting(self) -> str:
        rows = []

        def walk(name, o, path):
            if isinstance(o, dict):
                if "sumEqualsUpdateFrames" in o or o.get("available") is False and "clientNonEmptyFrames" in o:
                    rows.append([name, path or "frameOutcomes", o.get("available"), o.get("updateFrames"), o.get("outcomeSum"),
                                 o.get("clientNonEmptyFrames"), o.get("clientResent"), o.get("counterResetInWindow"),
                                 o.get("sumEqualsUpdateFrames"), o.get("updateFramesEqualsClientFrames"), "PASS" if o.get("pass") else ("n/a (base)" if o.get("available") is False else "FAIL"),
                                 json.dumps({k: v for k, v in (o.get("delta") or {}).items() if v and k in ("appendFrames", "noopSkips", "dedupeHits", "dedupeConflicts", "rateLimitCloses", "authorityCloses", "authorityDrops", "epochFences", "bodyInactiveCloses", "tooLargeCloses", "commitFailures", "frameErrors", "batchDuplicateCandidates")})])
                    return
                for k, v in o.items():
                    if k in ("diagnostics", "relayStats", "gql"):
                        continue
                    walk(name, v, f"{path}.{k}" if path else k)
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    walk(name, v, f"{path}[{i}]")
        for name, d in sorted(self.r.items()):
            walk(name, d, "")
        return table(["file", "where", "counters", "updateFrames", "Σ outcomes", "client non-empty frames", "client resent", "counter reset", "Σ = updateFrames", "updateFrames = client", "verdict", "non-zero outcomes"], rows)

    def connection_events(self) -> str:
        rows = []
        for name, d in sorted(self.r.items()):
            ce = d.get("connectionEvents")
            if not ce:
                continue
            if ce.get("unexpectedCloses") or ce.get("reconnectsOk") or ce.get("reconnectsFailed") or ce.get("resentFrames") or ce.get("droppedWhileClosed") or ce.get("errors"):
                rows.append([name, ce.get("clients"), ce.get("unexpectedCloses"), json.dumps(ce.get("unexpectedClosesByCode")), ce.get("reconnectsOk"), ce.get("reconnectsFailed"), ce.get("resentFrames"), ce.get("droppedWhileClosed"), ce.get("errors")])
        total = sum(1 for d in self.r.values() if d.get("connectionEvents"))
        head = f"{total} JSONs carry connectionEvents; {len(rows)} show any unexpected close / reconnect / resend / drop / error (listed; the rest had none).\n\n"
        return head + (table(["file", "clients", "unexpected closes", "by code", "reconnects ok", "reconnects failed", "resent", "dropped while closed", "errors"], rows) if rows else "")

    def convergence(self) -> str:
        out = []
        for name in ("convergence-suite", "convergence-suite-strict", "convergence-suite-base"):
            d = self.r.get(name)
            if not d:
                continue
            rows = []
            for r in d.get("rows") or []:
                legs = r.get("legs") or []
                failed = [l for l in legs if not l.get("pass")]
                rows.append([r.get("id"), r.get("label"), r.get("file"), (r.get("status") or "").upper(), len(legs),
                             "; ".join(f"{l.get('path')}: {l.get('failureCause') or json.dumps({k: v for k, v in l.items() if v not in ('pass', True)})[:160]}" for l in failed) or "–"])
            out.append(f"**{name}** (variant {d.get('variant')}, generated {d.get('generatedAt')}, allPass {d.get('allPass')}):\n\n" +
                       table(["id", "scenario", "file", "status", "legs", "failures"], rows))
        # per-file convergencePass for everything else
        rows = []
        for name, d in sorted(self.r.items()):
            if "convergencePass" in d and d.get("convergencePass") is not True and d.get("convergencePass") is not None:
                rows.append([name, d.get("convergencePass"), g(d, "convergence", "failureCause")])
        out.append("\nPer-run `convergencePass` not true (all other runs with a convergence check passed):\n\n" + (table(["file", "convergencePass", "failure cause"], rows) if rows else "none"))
        return "\n\n".join(out)

    def free_plan(self) -> str:
        rows = []
        for name, d in sorted(self.r.items()):
            for w in d.get("gql") or []:
                if not isinstance(w, dict) or w.get("name") == "idle":
                    continue
                for inv in w.get("invocations") or []:
                    if not isinstance(inv, dict):
                        continue
                    cpu = inv.get("cpuUs") or {}
                    if cpu.get("p99") is None:
                        continue
                    rows.append([name, w.get("name"), inv.get("type") or "–", inv.get("status"), inv.get("requests"),
                                 num(cpu["p50"] / 1000, 2), num(cpu["p90"] / 1000, 2), num(cpu["p99"] / 1000, 2),
                                 "YES" if cpu["p99"] > 10_000 else "no", num(g(w, "totals", "exceededCpuErrors")), num(g(w, "totals", "rowsWritten"))])
        return table(["file", "window", "invocation", "status", "requests", "cpu p50 ms", "cpu p90 ms", "cpu p99 ms", "p99 > 10 ms", "exceededCpu", "rows written (window)"], rows)

    # ---------------------------------------------------------------- write-budget spike (wb/scenarios.ts)
    def wbruns(self, scenario: str):
        return [(n, d) for n, d in sorted(self.r.items()) if isinstance(d, dict) and d.get("scenario") == scenario]

    @staticmethod
    def rows_cell(rows):
        """rowsWritten with its counter source; '~' = relay in-memory fallback (relay appends only, not exact)."""
        if not isinstance(rows, dict) or rows.get("rowsWritten") is None:
            return "–"
        return f"{rows['rowsWritten']}" + ("" if rows.get("exact") else " ~")

    def wb_c4(self) -> str:
        out = []
        for n, d in self.wbruns("C4W"):
            for p in d.get("parts") or []:
                out.append([f"`{n}`", "off" if d.get("relay") is False else "on", p.get("part"), p.get("edits"), self.rows_cell(p.get("rows")),
                            p.get("rowsPerEdit"), p.get("rowsPerTypingSecond"), pct(p.get("receiptMs")), pct(p.get("lastOfBurstReceiptMs")),
                            p.get("framesWithoutReceipt"), g(p, "rows", "source")])
        return table(["file", "relay", "part", "edits", "rows", "rows/edit", "rows/typing-s", "receipt ms p50/p90/p99", "last-of-burst receipt",
                      "no receipt", "counter"], out) + "\n\nTarget (spike §2): ≤ 9 rows/typing-second. `~` = not exact (relay fallback counter)."

    def wb_l5r(self) -> str:
        out = [[f"`{n}`", d.get("burst"), pct(d.get("receiptMs")), pct(d.get("firstFrameReceiptMs")), d.get("meetsTarget"), g(d, "convergence", "pass")]
               for n, d in self.wbruns("L5R")]
        return table(["file", "burst", "durable receipt ms p50/p90/p99", "first frame receipt", "p50 ≤ 1 s", "converged"], out)

    def wb_create(self) -> str:
        out = []
        for sc in ("I1", "I2", "I3"):
            for n, d in self.wbruns(sc):
                src = d if sc != "I2" else (d.get("bulk") if isinstance(d.get("bulk"), dict) and "totalRowsWritten" in d["bulk"] else d.get("seedRun") or {})
                fit = src.get("fit") or {}
                rows = src.get("totalRowsWritten")
                out.append([f"`{n}`", sc, g(d, "corpus", "preset"), src.get("adapter"), json.dumps(src.get("outcomes")) if src.get("outcomes") else "–",
                            "–" if rows is None else f"{rows}{'' if src.get('rowsExact') else ' ~'}", src.get("rowsPerFile"),
                            fit.get("rowsPerNote"), fit.get("rowsPerAttachment"), fit.get("rowsPerBatch"), src.get("requests"), src.get("batches"),
                            src.get("wallMs"), g(src, "batchMs", "p50"), g(d, "convergence", "pass")])
        t = table(["file", "scen", "preset", "adapter", "outcomes", "rows", "rows/file", "fit rows/note", "fit rows/att", "fit rows/batch",
                   "requests", "batches", "wall ms", "batch ms p50", "pass"], out)
        extra = []
        for n, d in self.wbruns("I2"):
            c = d.get("catalog") or {}
            extra.append([f"`{n}`", "catalog", c.get("identical"), c.get("different"), c.get("absent"), self.rows_cell(c.get("rows")), c.get("pass")])
            b = d.get("bulk") or {}
            if b.get("skipped"):
                extra.append([f"`{n}`", "bulk", "–", "–", "–", "–", "skipped: " + b["skipped"]])
            else:
                o = b.get("outcomes") or {}
                extra.append([f"`{n}`", "bulk", o.get("exists-identical"), o.get("exists-different"), o.get("created"),
                              "–" if b.get("totalRowsWritten") is None else str(b.get("totalRowsWritten")), b.get("pass")])
        if extra:
            t += "\n\nI2 second device (expect ~0 rows):\n\n" + table(["file", "mode", "identical", "different", "absent/created", "rows", "pass"], extra)
        peers = []
        for n, d in self.wbruns("I3"):
            for peer, v in (d.get("peers") or {}).items():
                peers.append([f"`{n}`", peer, f"{v.get('visible')}/{v.get('of')}", v.get("allVisibleMs"), pct(v.get("notesMs")), pct(v.get("imagesMs"))])
        if peers:
            t += "\n\nI3 time to visible on peers (ms from drop start):\n\n" + table(["file", "peer", "visible", "all visible", "notes p50/p90/p99", "images p50/p90/p99"], peers)
        return t + "\n\nCPU per batch: join perBatch[].startedAtWall/endedAtWall with the tail capture (--tail). `~` = not exact."

    def wb_i4(self) -> str:
        out = []
        for n, d in self.wbruns("I4"):
            for case, v in (d.get("byCase") or {}).items():
                out.append([f"`{n}`", case, pct(v.get("rows"), ("p50", "max")), pct(v.get("peerVisibleMs")), v.get("allTextOk")])
        return table(["file", "case", "rows p50/max", "peer visible ms", "text ok"], out) + \
            "\n\nfold = paste inside the 300 ms collector; hold = paste while the create is in flight; after = paste 3 s later."

    def wb_r1(self) -> str:
        out = []
        for n, d in self.wbruns("R1"):
            live = {e.get("id"): e for e in d.get("live") or []}
            for c in g(d, "mergeTable", "results", default=[]) or []:
                lv = live.get(c.get("id")) or {}
                out.append([f"`{n}`", c.get("id"), c.get("expect"), c.get("got"), c.get("pass"), lv.get("got", "–"), lv.get("pass", "–")])
        return table(["file", "case", "expect", "merge got", "table pass", "live got", "live pass"], out)

    def wb_xcrash(self) -> str:
        out = []
        for n, d in self.wbruns("XCRASH"):
            rs = d.get("rounds") or []
            out.append([f"`{n}`", len(rs), d.get("roundsCrashInsideWindow"), sum(r.get("receiptedBeforeCrash") or 0 for r in rs),
                        sum(r.get("missingRightAfterCrash") or 0 for r in rs), d.get("noReceiptViolation"), d.get("noLoss"), d.get("crashModeHonoured"),
                        g(d, "convergence", "pass")])
        return table(["file", "rounds", "crash in window", "receipted", "missing after crash", "no receipt for unpersisted", "no loss",
                      "crash mode honoured", "converged"], out) + \
            "\n\n'crash in window' counts rounds where some frames were not yet persisted when the DO restarted (the test only bites then)."

    def wb_a1(self) -> str:
        out = [[f"`{n}`", d.get("mode"), d.get("writes"), self.rows_cell(d.get("rows")), d.get("rowsPerWrite"), d.get("rowsPerHour"), d.get("rowsPer8hDay"),
                pct(d.get("changedSpanChars") or d.get("diffBytes"), ("p50", "max")), g(d, "convergence", "pass")] for n, d in self.wbruns("A1")]
        return table(["file", "mode", "writes", "rows", "rows/write", "rows/hour", "rows/8 h", "changed span p50/max", "converged"], out)

    def wb_budget(self) -> str:
        sys.path.insert(0, os.path.join(HERE, "wb"))
        import wbmodel  # noqa: PLC0415
        vals, prov, notes = wbmodel.extract_measured(self.dir)
        p = {k: float(v[0]) for k, v in wbmodel.WB_PARAMS.items()}
        pv = {k: v[1] for k, v in wbmodel.WB_PARAMS.items()}
        p.update(vals)
        pv.update(prov)
        rows = wbmodel.model(p, pv)
        return wbmodel.render(rows, p, pv, wbmodel.headroom(p, pv), notes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--section", default="all")
    a = ap.parse_args()
    s = S(load(a.dir), a.dir)
    sections = [
        ("Run index", s.index), ("Latency (L1–L7)", s.latency), ("C1 CPU per isolated keystroke (tail)", s.c1),
        ("C2 streaming cost (periodic analytics)", s.c2), ("C3 memory", s.c3), ("C4 rows per edit / reconnect", s.c4),
        ("C5 DO requests", s.c5), ("C6 bundle", s.c6), ("Behaviour (B1–B8, CW)", s.behaviour), ("Limits (X1–X4)", s.limits),
        ("K1 compaction", s.k1), ("Microbatch / lean sweep", s.mb), ("Per-phase worker totals", s.phases), ("Frame-outcome accounting", s.frame_accounting),
        ("Connection events", s.connection_events), ("Convergence", s.convergence), ("Free plan: CPU per invocation", s.free_plan),
    ]
    wb = [("WB C4 rows per edit (exact counter)", s.wb_c4), ("WB L5' durable receipt latency", s.wb_l5r),
          ("WB I1–I3 create / first open / folder drop", s.wb_create), ("WB I4 create-then-paste", s.wb_i4), ("WB R1 merge correctness", s.wb_r1),
          ("WB X-crash", s.wb_xcrash), ("WB A1 autosave", s.wb_a1), ("WB rows/day vs Free 100k", s.wb_budget)]
    if any(isinstance(d, dict) and d.get("scenario") in ("C4W", "L5R", "I1", "I2", "I3", "I4", "R1", "XCRASH", "A1") for d in s.r.values()):
        sections = [sections[0]] + wb + [x for x in sections[1:] if x[0] in ("Per-phase worker totals", "Connection events")] \
            if not any(isinstance(d, dict) and d.get("scenario") in ("L1", "C1", "C2", "B1", "X1") for d in s.r.values()) else sections + wb
    for title, fn in sections:
        if a.section != "all" and a.section.lower() not in title.lower():
            continue
        try:
            body = fn()
        except Exception as e:  # noqa: BLE001
            body = f"(summarizer error: {type(e).__name__}: {e})"
        print(f"### {title}\n\n{body}\n")


if __name__ == "__main__":
    main()
