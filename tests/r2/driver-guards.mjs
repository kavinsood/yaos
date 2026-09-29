import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const driver = process.argv[2];
if (!driver) throw new Error('driver_path_required');
const { runProbe } = await import(pathToFileURL(resolve(driver)).href);
await mkdir(join(directory, '.local'), { recursive: true });
const temporary = await mkdtemp(join(directory, '.local/guards-'));
let checks = 0;
try {
	for (const target of ['https://production.example/', 'http://yaos-p0k-r2-probe.example.workers.dev/',
		'https://yaos-p0k-r2-probe.example.workers.dev/path', 'https://user:password@yaos-p0k-r2-probe.example.workers.dev/',
		'http://127.0.0.1:8000/']) {
		await assert.rejects(runProbe({ target, secretFile: '/nonexistent' }), /invalid_dedicated_target/);
		checks++;
	}
	const target = 'https://yaos-p0k-r2-probe.example.workers.dev/';
	const unsafe = join(temporary, 'unsafe');
	await writeFile(unsafe, randomBytes(32).toString('hex'), { mode: 0o644 });
	await assert.rejects(runProbe({ target, secretFile: unsafe }), /secret_file_mode_must_be_0600/);
	checks++;
	const symbolic = join(temporary, 'symbolic');
	await symlink(unsafe, symbolic);
	await assert.rejects(runProbe({ target, secretFile: symbolic }), /secret_must_be_regular_file/);
	checks++;
	const malformed = join(temporary, 'malformed');
	await writeFile(malformed, '!'.repeat(64), { mode: 0o600 });
	await assert.rejects(runProbe({ target, secretFile: malformed }), /secret_token_format_invalid/);
	checks++;
	console.log(JSON.stringify({ probe: 'yaos-p0k-r2-probe', driverGuards: checks, failed: 0 }));
} finally { await rm(temporary, { recursive: true, force: true }); }
