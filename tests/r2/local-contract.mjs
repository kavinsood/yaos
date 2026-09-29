import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const driver = process.argv[2];
let child;
let temporary;
try {
	if (!driver) throw new Error('driver_path_required');
	const { runProbe } = await import(pathToFileURL(resolve(driver)).href);
	await mkdir(join(directory, '.local'), { recursive: true });
	temporary = await mkdtemp(join(directory, '.local/contract-'));
	const token = randomBytes(32).toString('hex');
	const secretFile = join(temporary, 'secret');
	await writeFile(secretFile, `${token}\n`, { mode: 0o600 });
	await writeFile(join(temporary, '.dev.vars'), `R2_PROBE_TOKEN=${token}\n`, { mode: 0o600 });
	const config = join(temporary, 'wrangler.json');
	await writeFile(config, JSON.stringify({ name: 'yaos-p0k-r2-probe', main: join(directory, 'probe.ts'),
		compatibility_date: '2026-03-02', alias: { '@yaos/crdt-engine': join(root, 'server/src/crdt/ywasmWorkerCrdtEngine.ts') },
		durable_objects: { bindings: [{ name: 'PROBE_VAULTS', class_name: 'R2ProbeVault' }, { name: 'PROBE_CONFIG', class_name: 'R2ProbeConfig' }] },
		migrations: [{ tag: 'v1', new_sqlite_classes: ['R2ProbeVault', 'R2ProbeConfig'] }], observability: { enabled: false } }));
	const listener = createServer();
	listener.listen(0, '127.0.0.1');
	await once(listener, 'listening');
	const port = listener.address().port;
	const closed = once(listener, 'close');
	listener.close();
	await closed;
	child = spawn(join(root, 'server/node_modules/.bin/wrangler'), ['dev', '--config', config,
		'--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(temporary, 'state'), '--log-level', 'error'],
	{ cwd: root, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false',
		CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } });
	let spawnFailed = false;
	child.on('error', () => { spawnFailed = true; });
	const target = `http://127.0.0.1:${port}`;
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (spawnFailed || child.exitCode !== null) throw new Error('local_worker_start_failed');
		try {
			const health = await fetch(`${target}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
			ready = health.status === 200;
			await health.body?.cancel();
		} catch {}
		if (ready) break;
		await delay(200);
	}
	if (!ready) throw new Error('local_worker_start_timeout');
	console.log(JSON.stringify(await runProbe({ target, secretFile, repoRoot: root, allowLocal: true })));
} catch (error) {
	const safe = /^[a-z_]+$/.test(error.message) ? error.message : 'local_contract_failed';
	console.error(JSON.stringify({ probe: 'yaos-p0k-r2-probe', error: safe }));
	process.exitCode = 1;
} finally {
	if (child && child.exitCode === null) {
		const exit = once(child, 'exit').catch(() => {});
		child.kill('SIGTERM');
		await Promise.race([exit, delay(3000)]);
		if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
	}
	if (temporary) await rm(temporary, { recursive: true, force: true });
}
