#!/usr/bin/env python3
"""Join a bench.ts run JSON with its wrangler tail capture (VaultSyncServer DO events only).

  python3 scripts/relay2/analyze.py <run.json> [--tail <tail.jsonl>] [--out <file>]

Adapted from relay v1 a5/analyze.py:
  * keystroke sample sets (any list of objects with `sentAtWall`, e.g. C1 small/heavy .samples) are matched
    1:1 to ws-message events: the local-vs-server clock offset is the median nearest delta, then each send
    takes the closest unused event within 400 ms. Unmatched sends are tail sampling/drop losses.
  * windows ({start,end} ISO pairs such as editWindow/reconnectWindow, or windowStart/windowEnd) get
    per-kind event/cpu/wall totals.
tail cpuTime/wallTime are milliseconds (GraphQL analytics use microseconds).
Default output: <run>.tail.json next to the run.
"""
import json, math, os, statistics, sys
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tailparse import do_events


def dist(v):
    if not v:
        return None
    s = sorted(v)
    p = lambda f: s[min(len(s) - 1, max(0, math.ceil(len(s) * f) - 1))]
    return {"n": len(s), "p50": p(0.5), "p90": p(0.9), "p99": p(0.99), "max": s[-1],
            "mean": round(sum(s) / len(s), 3), "sum": round(sum(s), 3)}


def ms(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp() * 1000


def match_samples(ev, samples, max_after=1500, window=400):
    msgs = [e for e in ev if e['_kind'] == 'ws-message']
    ts = [e['eventTimestamp'] for e in msgs]
    offsets = []
    for s in samples:
        near = [t - s['sentAtWall'] for t in ts if -1000 <= t - s['sentAtWall'] <= max_after]
        if near:
            offsets.append(min(near, key=abs))
    off = statistics.median(offsets) if offsets else 0
    out, used = [], set()
    for s in samples:
        target = s['sentAtWall'] + off
        best = None
        for i, e in enumerate(msgs):
            if i in used:
                continue
            d = abs(e['eventTimestamp'] - target)
            if d < window and (best is None or d < best[0]):
                best = (d, i)
        if best:
            used.add(best[1])
            e = msgs[best[1]]
            out.append({"i": s['i'], "cpu": e['cpuTime'], "wall": e['wallTime']})
    return off, out


def window_totals(ev, start, end):
    by = {}
    for e in ev:
        if not (start <= e['eventTimestamp'] <= end):
            continue
        k = 'req:ws-upgrade' if '/ws' in e['_kind'] else e['_kind']
        b = by.setdefault(k, {"events": 0, "cpu": 0, "wall": 0})
        b['events'] += 1; b['cpu'] += e['cpuTime']; b['wall'] += e['wallTime']
    return by


def find_sample_sets(obj, path=''):
    """Yield (path, samples) for every list of dicts carrying sentAtWall."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from find_sample_sets(v, f'{path}.{k}' if path else k)
    elif isinstance(obj, list) and obj and isinstance(obj[0], dict) and 'sentAtWall' in obj[0]:
        yield path, obj


def find_windows(obj, path=''):
    if isinstance(obj, dict):
        if isinstance(obj.get('start'), str) and isinstance(obj.get('end'), str) and obj['end']:
            yield path, obj['start'], obj['end']
        if isinstance(obj.get('windowStart'), str) and isinstance(obj.get('windowEnd'), str):
            yield path or 'window', obj['windowStart'], obj['windowEnd']
        for k, v in obj.items():
            if isinstance(v, (dict, list)):
                yield from find_windows(v, f'{path}.{k}' if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:50]):
            yield from find_windows(v, f'{path}[{i}]')


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(2)
    run_path = args[0]
    opt = {args[i][2:]: args[i + 1] for i in range(1, len(args) - 1, 2) if args[i].startswith('--')}
    run = json.load(open(run_path))
    tail = opt.get('tail') or run.get('tailFile')
    if not tail or not os.path.exists(tail):
        print(f'no tail file (run had tailFile={run.get("tailFile")}); pass --tail'); sys.exit(1)
    ev = do_events(tail)
    report = {"run": run_path, "tail": tail, "scenario": run.get('scenario'), "workerName": run.get('workerName'),
              "doEvents": len(ev), "units": "tail cpuTime/wallTime in ms", "sampleSets": {}, "windows": {}}
    for path, samples in find_sample_sets(run):
        off, m = match_samples(ev, samples)
        report['sampleSets'][path] = {"sent": len(samples), "matchedTailEvents": len(m), "clockOffsetMs": off,
            "cpuMs": dist([x['cpu'] for x in m]), "wallMs": dist([x['wall'] for x in m]), "matched": m}
    for path, start, end in find_windows(run):
        s, e = ms(start), ms(end)
        tot = window_totals(ev, s - 500, e + 3000)
        report['windows'][path] = {"start": start, "end": end, "byKind": tot,
            "cpuMsTotal": round(sum(v['cpu'] for v in tot.values()), 3)}
    whole = window_totals(ev, ms(run['startedAt']) - 500, ms(run['endedAt']) + 3000)
    report['wholeRun'] = {"byKind": whole, "cpuMsTotal": round(sum(v['cpu'] for v in whole.values()), 3)}
    report['alarms'] = [(e['eventTimestamp'], e['cpuTime'], e['wallTime']) for e in ev if e['_kind'] == 'alarm']
    out = opt.get('out') or run_path[:-5] + '.tail.json'
    json.dump(report, open(out, 'w'), indent=2)
    summary = {k: {kk: vv for kk, vv in v.items() if kk != 'matched'} for k, v in report['sampleSets'].items()}
    print(json.dumps({"out": out, "doEvents": len(ev), "sampleSets": summary, "wholeRun": report['wholeRun']}, indent=1)[:6000])


if __name__ == '__main__':
    main()
