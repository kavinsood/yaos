const assert = require("node:assert/strict");
const bindings = require(process.argv[2]);
const doc = new bindings.YDoc({ guid: "yaos-build-census" });
const text = doc.getText("body");
try {
	text.insert(0, "hello 世界 🌍", undefined, undefined);
	text.delete(5, 1, undefined);
	const stats = doc.documentStats();
	assert.ok(stats.totalStructs >= 2);
	assert.ok(stats.deletedStructs >= 1);
	assert.ok(stats.deletedStructs <= stats.totalStructs);
} finally {
	text.free();
	doc.destroy(undefined);
	doc.free();
}

// A repeated full lifecycle catches forgotten wrapper/transaction frees. The
// allocator may reserve a few pages while warming, but must settle rather than
// grow with the number of requests handled by one isolate.
const fixtureDoc = new bindings.YDoc({ guid: "yaos-build-soak-fixture" });
const fixtureText = fixtureDoc.getText("body");
let fixture;
try {
	fixtureText.insert(0, "中文😀é".repeat(42_000), undefined, undefined);
	fixture = bindings.encodeStateAsUpdate(fixtureDoc);
} finally {
	fixtureText.free();
	fixtureDoc.destroy(undefined);
	fixtureDoc.free();
}
let settledBytes = 0;
for (let index = 0; index < 10_000; index++) {
	const cycle = new bindings.YDoc({ guid: `yaos-build-soak-${index}` });
	try {
		bindings.applyUpdate(cycle, fixture, "soak");
		assert.ok(bindings.encodeStateAsUpdate(cycle).byteLength > 0);
	} finally {
		cycle.destroy(undefined);
		cycle.free();
	}
	if (index === 1_999) settledBytes = bindings.wasmMemoryByteLength();
}
const finalBytes = bindings.wasmMemoryByteLength();
const pageBytes = 65_536;
assert.ok(finalBytes - settledBytes <= 4 * pageBytes,
	`linear memory did not settle: ${settledBytes} -> ${finalBytes}`);
assert.equal(finalBytes % pageBytes, 0);
assert.throws(() => bindings.wasmMemoryGrow(1_536), RangeError,
	"linker maximum must reject memory growth beyond 96 MiB");
console.log(JSON.stringify({ cycles: 10_000, fixtureBytes: fixture.byteLength,
	settledBytes, finalBytes, lateGrowthPages: (finalBytes - settledBytes) / pageBytes }));
