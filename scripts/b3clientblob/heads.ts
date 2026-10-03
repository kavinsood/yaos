/** b3-clientblob: list catalog paths of a deployed vault matching a substring. args: <host> <device> <substr> */
import { loadContext } from "../relay2/lib/context";
import { listHeads } from "../relay2/wb/adapters";
const [host, device, sub] = process.argv.slice(2);
const ctx = loadContext(host!);
const h = await listHeads(ctx.devices[device ?? "B"]!);
const hits = h.entries.filter((e) => e.path.includes(sub ?? ""));
console.log(JSON.stringify({ total: h.entries.length, hits: hits.slice(0, 10).map((e) => ({ path: e.path, lifecycle: e.lifecycle })) }));
process.exit(0);
