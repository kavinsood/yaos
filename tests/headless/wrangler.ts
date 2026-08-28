import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

async function unusedPort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("could not allocate a loopback port");
	await new Promise<void>((resolvePromise, reject) => {
		server.close((error) => error ? reject(error) : resolvePromise());
	});
	return address.port;
}

function inheritedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" };
	delete env.YAOS_TOKEN;
	delete env.SYNC_TOKEN;
	return env;
}

export interface WranglerTarget {
	readonly host: string;
	readonly output: () => string;
	stop(): Promise<void>;
}

export async function launchWrangler(): Promise<WranglerTarget> {
	const port = await unusedPort();
	const host = `http://127.0.0.1:${String(port)}`;
	const persistDir = await mkdtemp(`${tmpdir()}/yaos-headless-wrangler-`);
	const executable = resolve("server/node_modules/.bin/wrangler");
	const child = spawn(executable, [
		"dev", "--ip", "127.0.0.1", "--port", String(port), "--local-protocol", "http",
		"--persist-to", persistDir, "--log-level", "error",
	], {
		cwd: resolve("server"),
		stdio: ["ignore", "pipe", "pipe"],
		env: inheritedEnv(),
		detached: true,
	});
	let output = "";
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-256 * 1024);
	};
	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);
	let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	let spawnError: Error | null = null;
	child.once("error", (error: Error) => { spawnError = error; });
	child.once("exit", (code, signal) => { exited = { code, signal }; });
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const failure = spawnError as Error | null;
		const status = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
		if (failure !== null || status !== null) {
			await rm(persistDir, { recursive: true, force: true });
			throw new Error(
				failure !== null
					? `wrangler failed to spawn: ${failure.message}`
					: `wrangler exited during startup: ${JSON.stringify(status)}\n${output}`,
			);
		}
		try {
			const response = await fetch(`${host}/api/capabilities`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) break;
		} catch {
			// Listener is not ready yet.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	if (Date.now() >= deadline) {
		killGroup(child, "SIGKILL");
		await rm(persistDir, { recursive: true, force: true });
		throw new Error(`wrangler did not accept requests within ${START_TIMEOUT_MS}ms\n${output}`);
	}
	return {
		host,
		output: () => output,
		async stop(): Promise<void> {
			if (exited === null) killGroup(child, "SIGTERM");
			const deadline = Date.now() + STOP_TIMEOUT_MS;
			while (exited === null && Date.now() < deadline) {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
			}
			if (exited === null) killGroup(child, "SIGKILL");
			await rm(persistDir, { recursive: true, force: true });
		},
	};
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try { child.kill(signal); } catch { /* already gone */ }
	}
}

export interface LossyProxy {
	readonly host: string;
	readonly droppedEnrollmentResponses: () => number;
	stop(): Promise<void>;
}

export async function launchLossyProxy(upstreamHost: string): Promise<LossyProxy> {
	const upstream = new URL(upstreamHost);
	let dropNextEnrollmentResponse = true;
	let dropped = 0;
	const sockets = new Set<Socket>();
	const server: HttpServer = createHttpServer((incoming, outgoing) => {
		const upstreamRequest = httpRequest({
			hostname: upstream.hostname,
			port: upstream.port,
			method: incoming.method,
			path: incoming.url,
			headers: incoming.headers,
		}, (upstreamResponse) => {
			if (dropNextEnrollmentResponse && incoming.method === "POST" && incoming.url === "/enroll") {
				dropNextEnrollmentResponse = false;
				dropped++;
				upstreamResponse.resume();
				upstreamResponse.once("end", () => outgoing.destroy());
				return;
			}
			outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
			upstreamResponse.pipe(outgoing);
		});
		upstreamRequest.on("error", (error) => outgoing.destroy(error));
		upstreamRequest.setTimeout(15_000, () => upstreamRequest.destroy(new Error("upstream request timed out")));
		outgoing.once("close", () => upstreamRequest.destroy());
		incoming.pipe(upstreamRequest);
	});
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (request, socket, head) => {
		const upstreamSocket = netConnect(Number(upstream.port), upstream.hostname, () => {
		sockets.add(upstreamSocket);
		upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
			const requestLine = `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n`;
			const rawHeaders: string[] = [];
			for (let index = 0; index < request.rawHeaders.length; index += 2) {
				rawHeaders.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
			}
			upstreamSocket.write(`${requestLine}${rawHeaders.join("\r\n")}\r\n\r\n`);
			if (head.length > 0) upstreamSocket.write(head);
			socket.pipe(upstreamSocket).pipe(socket);
		});
		upstreamSocket.on("error", () => socket.destroy());
		socket.on("error", () => upstreamSocket.destroy());
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("lossy proxy has no loopback address");
	return {
		host: `http://127.0.0.1:${String(address.port)}`,
		droppedEnrollmentResponses: () => dropped,
		async stop(): Promise<void> {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolvePromise, reject) => {
				server.close((error) => error ? reject(error) : resolvePromise());
			});
		},
	};
}
