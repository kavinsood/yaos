"""Parse `wrangler tail --format json` output (concatenated JSON objects). Adapted from relay v1 a5/tailparse.py."""
import json, sys


def events(path):
    buf = open(path).read(); dec = json.JSONDecoder(); i = 0; out = []
    while True:
        while i < len(buf) and buf[i] in ' \n\r\t':
            i += 1
        if i >= len(buf):
            break
        try:
            o, j = dec.raw_decode(buf, i)
        except Exception:
            break
        out.append(o); i = j
    return out


def kind(e):
    ev = e.get('event') or {}
    if 'getWebSocketEvent' in ev:
        return 'ws-' + ev['getWebSocketEvent'].get('webSocketEventType', '?')
    if 'scheduledTime' in ev:
        return 'alarm'
    if 'request' in ev:
        url = ev['request'].get('url', '')
        p = url.split('?')[0].split('/', 3)[-1] if '://' in url else url
        return 'req:' + p[:40]
    return 'other'


def do_events(path, entrypoint='VaultSyncServer'):
    ev = [e for e in events(path) if e.get('entrypoint') == entrypoint]
    for e in ev:
        e['_kind'] = kind(e)
    ev.sort(key=lambda e: e['eventTimestamp'])
    return ev


if __name__ == '__main__':
    for e in do_events(sys.argv[1]):
        print(e['eventTimestamp'], e['_kind'], e['cpuTime'], e['wallTime'])
