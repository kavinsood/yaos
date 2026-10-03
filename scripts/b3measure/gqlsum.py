"""b3-m-import: summarize gql.ts output per objectId (and per-minute for the busiest object).
   python3 gqlsum.py <gql.json> [--minutes] [--split HH:MM]  (split: totals before/after that minute for the top object)"""
import json, sys
a = sys.argv[1:]; d = json.load(open(a[0]))
inv = [(x['dimensions']['type'], x['dimensions']['status'], x['sum']['requests'], x['sum']['errors'], round(x['quantiles']['cpuTimeP50']/1000,1), round(x['quantiles']['cpuTimeP90']/1000,1), round(x['quantiles']['wallTimeP50']/1000)) for x in d.get('invocations', [])]
print(d['className'], 'invocations (type,status,req,err,cpuP50ms,cpuP90ms,wallP50ms):', inv)
per = {}
for m in d.get('periodicMinutes', []):
    o = m['dimensions']['objectId']; s = m['sum']
    t = per.setdefault(o, {'w': 0, 'r': 0, 'cpu': 0, 'min': 0})
    t['w'] += s['rowsWritten']; t['r'] += s['rowsRead']; t['cpu'] += s['cpuTime']; t['min'] += 1
for o, t in sorted(per.items(), key=lambda x: -x[1]['w']):
    print(f"  obj {o[:12]} minutes={t['min']} rowsWritten={t['w']} rowsRead={t['r']} cpuMs={t['cpu']/1000:.0f}")
if per:
    top = max(per, key=lambda o: per[o]['w'])
    rows = sorted([m for m in d['periodicMinutes'] if m['dimensions']['objectId'] == top], key=lambda m: m['dimensions']['datetimeMinute'])
    if '--minutes' in a:
        for m in rows: print('   ', m['dimensions']['datetimeMinute'][11:16], m['sum']['rowsWritten'], m['sum']['rowsRead'], round(m['sum']['cpuTime']/1000))
    if '--split' in a:
        sp = a[a.index('--split')+1]
        b = [m for m in rows if m['dimensions']['datetimeMinute'][11:16] < sp]; c = [m for m in rows if m['dimensions']['datetimeMinute'][11:16] >= sp]
        f = lambda L, k: sum(m['sum'][k] for m in L)
        print(f"  split {sp}: before w={f(b,'rowsWritten')} r={f(b,'rowsRead')} | after w={f(c,'rowsWritten')} r={f(c,'rowsRead')}")
