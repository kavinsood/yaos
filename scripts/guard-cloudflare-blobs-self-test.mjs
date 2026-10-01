#!/usr/bin/env node
import assert from "node:assert/strict";
import { checkCloudflareBlobs } from "./guard-cloudflare-blobs.mjs";

const sources = {
	route: `
import { blobKey } from "../vaultObjectStore";
async function handleBlobUpload() {
	const suspect = existing ? (await blobSuspects(env, vaultId, vaultGeneration, actor, [key])).includes(key) : false;
	await bucket.createOnlyVerifiedStream(blobKey(vaultId, vaultGeneration, hash), body, {
		sha256: hash,
		length,
		replaceEtag: existing && (existing.sha256 !== hash || suspect) ? existing.etag : undefined,
		contentType: "application/octet-stream",
	});
}`,
	helper: `
export async function createCloudflareVerifiedObjectStream(bucket, key, body, options) {
	if (!/^[a-f0-9]{64}$/.test(options.sha256) || !key.endsWith(\`/blobs/\${options.sha256}\`)) throw new Error("invalid blob key");
	const valid = existing?.checksums?.sha256 && Array.from(new Uint8Array(existing.checksums.sha256), (byte) => byte.toString(16).padStart(2, "0")).join("") === options.sha256;
	const output = new FixedLengthStream(options.length);
	const publication = Promise.resolve().then(async () => {
		if (existing && (options.replaceEtag !== existing.etag || (valid && !options.replaceEtag))) {
			await drain();
			return "exists";
		}
		return bucket.put(key, output.readable, {
		sha256: options.sha256,
		onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },
		httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
		});
	});
	return publication;
}`,
	ports: `
import { createCloudflareVerifiedObjectStream } from "./cloudflareVerifiedObjectStream";
export class CloudflareObjectStore {
	async createOnlyVerifiedStream(key, body, options) {
		return await createCloudflareVerifiedObjectStream(this.bucket, key, body, options);
	}
}`,
};

assert.deepEqual(checkCloudflareBlobs(sources), []);
assert.deepEqual(checkCloudflareBlobs({
	...sources,
	route: sources.route.replace("length,", "length: length,").replace("sha256: hash", "'sha256': hash"),
	helper: sources.helper.replace("throw new Error(\"invalid blob key\");", "{ throw new Error('invalid blob key'); }")
		.replace("/^[a-f0-9]{64}$/", "/^[0-9a-f]{64}$/"),
}), []);
assert.deepEqual(checkCloudflareBlobs({
	...sources,
	helper: sources.helper.replace("\n\tif (", '\n\tif (!Number.isSafeInteger(options.length) || options.length < 1) { throw new Error("invalid length"); }\n\tif ('),
}), []);

const mutations = [
	["route checksum missing", "route", "sha256: hash,", ""],
	["route checksum wrong", "route", "sha256: hash", "sha256: otherHash"],
	["route length missing", "route", "length,", ""],
	["route key wrong", "route", "blobKey(vaultId, vaultGeneration, hash)", "blobKey(vaultId, vaultGeneration, otherHash)"],
	["route generation missing", "route", "vaultId, vaultGeneration, hash", "vaultId, hash"],
	["route body wrong", "route", ", body, {", ", otherBody, {"],
	["route unconditional write", "route", "createOnlyVerifiedStream", "put"],
	["route unverified create", "route", "createOnlyVerifiedStream", "createOnly"],
	["route extra bypass", "route", "await bucket.createOnlyVerifiedStream", "bucket.put(key, body); await bucket.createOnlyVerifiedStream"],
	["route computed bypass", "route", "await bucket.createOnlyVerifiedStream", "bucket['put'](key, body); await bucket.createOnlyVerifiedStream"],
	["route aliased bypass", "route", "await bucket.createOnlyVerifiedStream", "const write = bucket.put; await bucket.createOnlyVerifiedStream"],
	["route option override", "route", "sha256: hash,", "sha256: hash, ...extra,"],
	["route duplicate checksum", "route", "sha256: hash,", "sha256: hash, sha256: otherHash,"],
	["route fake import", "route", "../vaultObjectStore", "../unverifiedKeys"],
	["route replacement unconditional", "route", "? existing.etag : undefined", "? existing.etag : existing.etag"],
	["route replacement on valid object", "route", "existing.sha256 !== hash", "existing.sha256 === hash"],
	["route replacement without suspect gate", "route", " || suspect", ""],
	["route replacement without existing", "route", "existing && (", "("],
	["route replacement omitted", "route", "replaceEtag: existing && (existing.sha256 !== hash || suspect) ? existing.etag : undefined,", ""],
	["route suspect always false", "route", "const suspect = existing ?", "const suspect = false && existing ?"],
	["route suspect wrong key", "route", "actor, [key]", "actor, [otherKey]"],
	["helper checksum missing", "helper", "sha256: options.sha256,", ""],
	["helper checksum wrong", "helper", "sha256: options.sha256,", "sha256: otherHash,"],
	["helper key wrong", "helper", "bucket.put(key,", "bucket.put(otherKey,"],
	["helper unconditional write", "helper", "onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' },", ""],
	["helper wrong precondition", "helper", "etagDoesNotMatch: '*'", "etagDoesNotMatch: 'existing'"],
	["helper extra precondition", "helper", "etagDoesNotMatch: '*'", "etagDoesNotMatch: '*', etagMatches: 'existing'"],
	["helper create-only instead of conditional", "helper", "existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' }", "{ etagDoesNotMatch: '*' }"],
	["helper inverted replacement ternary", "helper", "existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' }", "!existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' }"],
	["helper wrong replacement ternary", "helper", "existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' }", "options.replaceEtag ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' }"],
	["helper valid object always false", "helper", "const valid = existing?.checksums?.sha256", "const valid = false && existing?.checksums?.sha256"],
	["helper valid checksum not compared", "helper", "=== options.sha256", "!== options.sha256"],
	["helper valid checksum from wrong object", "helper", "new Uint8Array(existing.checksums.sha256)", "new Uint8Array(other.checksums.sha256)"],
	["helper valid gate removed", "helper", " || (valid && !options.replaceEtag)", ""],
	["helper valid gate inverted", "helper", "valid && !options.replaceEtag", "!valid && !options.replaceEtag"],
	["helper gate skips drain", "helper", "await drain();", "void drain();"],
	["helper gate skips return", "helper", 'return "exists";', 'void "exists";'],
	["helper option override", "helper", "sha256: options.sha256,", "sha256: options.sha256, ...extra,"],
	["helper additional write", "helper", "return bucket.put", "bucket.put(key, body); return bucket.put"],
	["helper aliased bypass", "helper", "return bucket.put", "const write = bucket.put; write(key, body); return bucket.put"],
	["helper DigestStream hashing", "helper", "const output =", "new crypto.DigestStream('SHA-256'); const output ="],
	["helper global DigestStream hashing", "helper", "const output =", "new DigestStream('SHA-256'); const output ="],
	["helper computed DigestStream hashing", "helper", "const output =", "new crypto['DigestStream']('SHA-256'); const output ="],
	["helper subtle hashing", "helper", "const output =", "await crypto.subtle.digest('SHA-256', body); const output ="],
	["helper computed subtle hashing", "helper", "const output =", "await crypto['subtle']['digest']('SHA-256', body); const output ="],
	["helper aliased subtle hashing", "helper", "const output =", "const hashing = crypto.subtle; await hashing.digest('SHA-256', body); const output ="],
	["helper stream verification hashing", "helper", "const output =", "await verifyObjectStream(body, options); const output ="],
	["helper imported hashing alias", "helper", "export async function", 'import { verifyObjectStream as verify } from "./verifiedObjectStream"; export async function'],
	["helper checksum only in comment", "helper", "sha256: options.sha256,", "/* sha256: options.sha256, */"],
	["helper key binding missing", "helper", " || !key.endsWith(`/blobs/${options.sha256}`)", ""],
	["helper hash validation missing", "helper", "!/^[a-f0-9]{64}$/.test(options.sha256) || ", ""],
	["helper AND instead of OR", "helper", " || ", " && "],
	["helper wrong suffix", "helper", "/blobs/", "/objects/"],
	["helper inverted suffix check", "helper", "!key.endsWith", "key.endsWith"],
	["helper weak hash pattern", "helper", "{64}", "+"],
	["helper nonthrowing rejection", "helper", "throw new Error", "return new Error"],
	["helper late binding check", "helper", "\n\tif (", "\n\tbucket.head(key);\n\tif ("],
	["helper conditional rejection", "helper", 'throw new Error("invalid blob key");', '{ if (false) throw new Error("invalid blob key"); }'],
	["ports unverified delegation", "ports", "return await createCloudflareVerifiedObjectStream(this.bucket, key, body, options);", "return await this.bucket.put(key, body);"],
	["ports wrong key", "ports", "this.bucket, key, body, options", "this.bucket, otherKey, body, options"],
	["ports extra write", "ports", "return await", "this.bucket.put(key, body); return await"],
	["syntax error", "route", "sha256: hash,", "sha256: ,"],
];

for (const [name, file, original, replacement] of mutations) {
	assert.ok(sources[file].includes(original), `${name}: mutation must alter the fixture`);
	const failures = checkCloudflareBlobs({ ...sources, [file]: sources[file].replace(original, replacement) });
	assert.ok(failures.length > 0, `${name}: guard must reject the regression`);
}

console.log(`Cloudflare blob guard self-test passed (${mutations.length} rejected mutations, 3 valid fixtures).`);
