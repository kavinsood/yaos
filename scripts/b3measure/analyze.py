"""b3-m-import (from b3-cpu): join wrangler-tail JSON events by ?b3c=<cell> and report front-Worker (and DO) cpuTime per cell.
   python3 analyze.py <tail.jsonl> [tag]"""
import json, sys, statistics
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, '/Users/kavin/personal/obsidiansync/experiments/yaos-b3-run-557dfd3/scripts/relay2')
from tailparse import events
evs = events(sys.argv[1]); tag = sys.argv[2] if len(sys.argv) > 2 else None
cells = {}
order = []
for e in evs:
    req = (e.get('event') or {}).get('request') or {}
    q = parse_qs(urlparse(req.get('url', '')).query)
    if 'b3c' not in q or (tag and q.get('b3t', [None])[0] != tag):
        continue
    ent = e.get('entrypoint') or 'front'
    key = (q['b3c'][0], 'front' if ent in ('front', 'default') else ent)
    if key not in cells: cells[key] = []; order.append(key)
    cells[key].append((e.get('cpuTime'), e.get('wallTime'), e.get('outcome')))
def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
print(f"{'cell':22} {'who':16} {'n':>3} {'cpu p50':>8} {'p90':>6} {'max':>5} {'min':>5} {'wall p50':>8}  outcomes")
for key in order:
    v = cells[key]; cpu = [x[0] for x in v if x[0] is not None]; wall = [x[1] for x in v if x[1] is not None]
    oc = {}
    for x in v: oc[x[2]] = oc.get(x[2], 0) + 1
    print(f"{key[0]:22} {key[1]:16} {len(v):>3} {pct(cpu,.5):>8.1f} {pct(cpu,.9):>6.1f} {max(cpu):>5} {min(cpu):>5} {pct(wall,.5):>8.0f}  {oc}")
