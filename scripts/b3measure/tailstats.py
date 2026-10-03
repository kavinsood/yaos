"""b3-m-import: summarize a wrangler-tail capture by (who, route kind): n, cpu p50/p90/max, wall p50, outcomes.
   python3 tailstats.py <tail.jsonl> [--since ISO] [--until ISO] [--do <objectId-prefix>]
   who = front | <DO class>; kind = create-bulk | blob-put | heads | ... | alarm."""
import sys, re, json, datetime
sys.path.insert(0, '/Users/kavin/personal/obsidiansync/experiments/yaos-b3-run-557dfd3/scripts/relay2')
from tailparse import events
from urllib.parse import urlparse
a = sys.argv[1:]; path = a[0]
opt = {a[i][2:]: a[i+1] for i in range(1, len(a)-1, 2)}
ts = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()*1000
since = ts(opt['since']) if 'since' in opt else 0; until = ts(opt['until']) if 'until' in opt else 1e18
def kind(e):
    ev = e.get('event') or {}
    if 'request' not in ev: return 'alarm' if 'scheduledTime' in ev or e.get('executionModel') == 'durableObject' else 'other'
    req = ev['request']; p = urlparse(req.get('url', '')).path; m = req.get('method', '')
    if 'create-bulk' in p: return 'create-bulk'
    if '/blobs/' in p: return f'blob-{m.lower()}'
    if p.endswith('/candidate') or p.endswith('/candidates'): return 'candidate'
    seg = [s for s in p.split('/') if s]
    return f"{m} {'/'.join(seg[2:4]) if len(seg) > 2 else p}"[:40]
def pct(xs, p):
    xs = sorted(xs); k = (len(xs)-1)*p; f = int(k); c = min(f+1, len(xs)-1); return xs[f] + (xs[c]-xs[f])*(k-f)
g = {}
for e in events(path):
    t = e.get('eventTimestamp') or 0
    if t < since or t > until: continue
    if 'do' in opt and e.get('durableObjectId') and not e['durableObjectId'].startswith(opt['do']): continue
    who = e.get('entrypoint') or 'front'
    g.setdefault((who, kind(e)), []).append(e)
print(f"{'who':16} {'kind':26} {'n':>5} {'cpu p50':>7} {'p90':>6} {'p99':>6} {'max':>5} {'sum':>7} {'wall p50':>8} outcomes")
for (who, k), v in sorted(g.items(), key=lambda x: (x[0][0], -len(x[1]))):
    cpu = [x.get('cpuTime') or 0 for x in v]; wall = [x.get('wallTime') or 0 for x in v]
    oc = {}
    for x in v: oc[x.get('outcome')] = oc.get(x.get('outcome'), 0) + 1
    print(f"{who:16} {k:26} {len(v):>5} {pct(cpu,.5):>7.1f} {pct(cpu,.9):>6.1f} {pct(cpu,.99):>6.1f} {max(cpu):>5} {sum(cpu):>7} {pct(wall,.5):>8.0f} {oc}")
