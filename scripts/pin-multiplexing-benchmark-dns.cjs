const dns = require("node:dns");

const hostname = process.env.YAOS_MULTIPLEX_BENCH_HOSTNAME;
const address = process.env.YAOS_MULTIPLEX_BENCH_ADDRESS;

if (hostname && address) {
	const originalLookup = dns.lookup.bind(dns);
	dns.lookup = (target, options, callback) => {
		if (target !== hostname) return originalLookup(target, options, callback);
		if (typeof options === "function") return options(null, address, 4);
		if (options?.all) return callback(null, [{ address, family: 4 }]);
		return callback(null, address, 4);
	};
}
