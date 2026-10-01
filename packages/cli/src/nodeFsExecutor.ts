import { spawn, type ChildProcess } from "node:child_process";
import { NODE_FS_HELPER_SOURCE, type NodeFsRequest } from "./nodeFsHelper";

export class NodeFsHostFailure extends Error {
	retainedTemporaryPath?: string;
	constructor(message: string, readonly publicationUncertain: boolean) {
		super(message);
		this.name = "NodeFsHostFailure";
	}
}

export interface NodeFsExecutorOptions {
	readonly deadlineMs?: number;
	readonly helperSource?: string;
	readonly onSpawn?: (child: ChildProcess, request: NodeFsRequest) => void;
}

export class NodeFsExecutor {
	readonly failure: Promise<never>;
	private rejectFailure!: (error: NodeFsHostFailure) => void;
	private failed: NodeFsHostFailure | undefined;
	private active = false;
	private readonly deadlineMs: number;

	constructor(private readonly options: NodeFsExecutorOptions = {}) {
		this.deadlineMs = options.deadlineMs ?? 29_000;
		if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0) throw new Error("Invalid filesystem deadline");
		this.failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject; });
		void this.failure.catch(() => undefined);
	}

	get failureError(): NodeFsHostFailure | undefined {
		return this.failed;
	}

	async execute<Result>(request: NodeFsRequest): Promise<Result> {
		if (this.failed) throw this.failed;
		if (this.active) throw new Error("Filesystem helper already active");
		const serialized = JSON.stringify(request);
		const snapshot = JSON.parse(serialized) as NodeFsRequest;
		if (snapshot.kind === "replace") Object.freeze(snapshot.expected);
		if (snapshot.kind === "read" || snapshot.kind === "rename") Object.freeze(snapshot.identity);
		Object.freeze(snapshot);
		this.active = true;
		try {
			return await this.run<Result>(serialized, snapshot);
		} catch (error) {
			if (error instanceof NodeFsHostFailure) {
				this.reportFailure(error, snapshot);
			}
			throw error;
		} finally {
			this.active = false;
		}
	}

	private reportFailure(error: NodeFsHostFailure, request: NodeFsRequest): void {
		if (this.failed) return;
		if (request.kind === "replace") {
			error.retainedTemporaryPath = request.temporary;
			error.message += `; temporary may remain at ${request.temporary}; inspect before removal (no automatic deletion after interruption)`;
		}
		this.failed = error;
		this.rejectFailure(error);
	}

	private run<Result>(serialized: string, request: NodeFsRequest): Promise<Result> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=commonjs", "--eval", this.options.helperSource ?? NODE_FS_HELPER_SOURCE], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, NODE_OPTIONS: "" },
			});
			let output = "";
			let outputBytes = 0;
			const maximumOutputBytes = request.kind === "read" ? request.maximumBytes * 8 + 65_536 : 65_536;
			let failure: NodeFsHostFailure | undefined;
			const uncertain = request.kind === "replace" || request.kind === "rename";
			const interrupt = (message: string): void => {
				failure ??= new NodeFsHostFailure(message, uncertain);
				this.reportFailure(failure, request);
				child.kill("SIGKILL");
			};
			const deadline = setTimeout(() => interrupt(`Filesystem ${request.kind} deadline exceeded`), this.deadlineMs);
			child.on("error", (error) => {
				failure ??= new NodeFsHostFailure(`Filesystem helper failed: ${error.message}`, uncertain);
				this.reportFailure(failure, request);
			});
			child.stdin.on("error", (error) => interrupt(`Filesystem helper input failed: ${error.message}`));
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				outputBytes += Buffer.byteLength(chunk, "utf8");
				if (outputBytes > maximumOutputBytes) interrupt("Filesystem helper response exceeded bound");
				else output += chunk;
			});
			child.stderr.resume();
			child.on("close", (code, signal) => {
				clearTimeout(deadline);
				if (failure) { reject(failure); return; }
				if (code !== 0 || signal) {
					reject(new NodeFsHostFailure(`Filesystem helper exited (${String(code)}, ${String(signal)})`, uncertain));
					return;
				}
				try {
					const response = JSON.parse(output) as { ok: boolean; result: Result; message: string; code?: string; published?: boolean };
					if (typeof response.ok !== "boolean" || (!response.ok && typeof response.message !== "string")) throw new Error("Invalid response");
					if (!response.ok) {
						if (typeof response.published !== "boolean") throw new Error("Invalid publication status");
						const message = response.message.slice(0, 1024);
						if (response.published) reject(new NodeFsHostFailure(`Filesystem publication uncertain: ${message}`, true));
						else reject(Object.assign(new Error(message), { code: response.code }));
					} else {
						const result = response.result as unknown;
						if (request.kind === "read" || request.kind === "replace") {
							if (typeof result !== "object" || result === null || !("dev" in result) || !("ino" in result) ||
								!Number.isFinite(result.dev) || !Number.isFinite(result.ino)) throw new Error("Invalid file identity");
							if (request.kind === "read" && (!("content" in result) || typeof result.content !== "string" ||
								!("bytes" in result) || typeof result.bytes !== "string" ||
								!("mode" in result) || !Number.isFinite(result.mode) ||
								!("mtimeMs" in result) || !Number.isFinite(result.mtimeMs) ||
								!("ctimeMs" in result) || !Number.isFinite(result.ctimeMs))) throw new Error("Invalid file snapshot");
							if (request.kind === "replace" && (!("size" in result) || !Number.isFinite(result.size) ||
								!("mtimeMs" in result) || !Number.isFinite(result.mtimeMs))) throw new Error("Invalid publication snapshot");
						} else if (result !== null) throw new Error("Invalid filesystem result");
						resolve(response.result);
					}
				} catch {
					reject(new NodeFsHostFailure("Invalid filesystem helper response", uncertain));
				}
			});
			try {
				this.options.onSpawn?.(child, request);
				child.stdin.end(serialized);
			} catch (error) {
				interrupt(`Filesystem helper dispatch failed: ${String(error)}`);
			}
		});
	}
}
