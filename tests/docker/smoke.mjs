import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const suppliedImage = process.argv[2];
const image = suppliedImage ?? `yaos-server:smoke-${process.pid}`;
const container = `yaos-server-smoke-${process.pid}`;
const volume = `yaos-server-smoke-${process.pid}`;
let builtImage = false;

function docker(args, options = {}) {
	const result = spawnSync("docker", args, {
		cwd: new URL("../..", import.meta.url),
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(`docker ${args.join(" ")} failed (${String(result.status)})\n${result.stdout}${result.stderr}`);
	}
	return result;
}

async function waitForReady(baseUrl) {
	const deadline = Date.now() + 30_000;
	let last = "not attempted";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/health/ready`);
			last = `${response.status} ${await response.text()}`;
			if (response.status === 200) return;
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`container did not become ready: ${last}`);
}

function publishedBaseUrl() {
	const mapping = docker(["port", container, "8787/tcp"]).stdout.trim().split("\n")[0];
	const match = mapping?.match(/:(\d+)$/);
	if (!match) throw new Error(`unexpected Docker port mapping: ${mapping}`);
	return `http://127.0.0.1:${match[1]}`;
}

try {
	docker(["info", "--format", "{{.ServerVersion}}"]).stdout.trim();
	if (!suppliedImage) {
		docker(["build", "--pull", "--tag", image, "."], { stdio: "inherit" });
		builtImage = true;
	}
	docker(["volume", "create", volume]);
	docker([
		"run", "--detach", "--name", container,
		"--env", "YAOS_NODE_PUBLIC_ORIGIN=https://sync.example.test",
		"--publish", "127.0.0.1::8787",
		"--mount", `type=volume,source=${volume},target=/data`,
		"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
		image,
	]);
	const baseUrl = publishedBaseUrl();
	await waitForReady(baseUrl);

	const health = await fetch(`${baseUrl}/health`);
	if (health.status !== 200 || JSON.stringify(await health.json()) !== JSON.stringify({ status: "ok" })) {
		throw new Error("container liveness response did not match the contract");
	}
	const imageUser = docker(["inspect", "--format", "{{.Config.User}}", container]).stdout.trim();
	if (imageUser !== "node") throw new Error(`container runs as unexpected user ${JSON.stringify(imageUser)}`);
	const readOnly = docker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", container]).stdout.trim();
	if (readOnly !== "true") throw new Error("container root filesystem is writable");

	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const claim = await fetch(`${baseUrl}/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const claimBody = await claim.json();
	if (!claim.ok || claimBody.host !== "https://sync.example.test"
		|| typeof claimBody.vaultId !== "string" || typeof claimBody.pairingCode !== "string") {
		throw new Error(`container claim failed (${claim.status}): ${JSON.stringify(claimBody)}`);
	}

	const duplicate = docker([
		"run", "--rm",
		"--mount", `type=volume,source=${volume},target=/data`,
		"--env", "YAOS_NODE_PORT=8788",
		image,
	], { allowFailure: true });
	const duplicateOutput = `${duplicate.stdout}${duplicate.stderr}`;
	if (duplicate.status !== 17 || !duplicateOutput.includes("owns /data/runtime.lock")) {
		throw new Error(`second data owner did not fail with lock exit 17 (exit ${String(duplicate.status)})\n${duplicateOutput}`);
	}

	docker(["stop", "--time", "30", container]);
	const firstExit = docker(["inspect", "--format", "{{.State.ExitCode}}", container]).stdout.trim();
	if (firstExit !== "0") throw new Error(`graceful stop exited ${firstExit}`);
	docker(["start", container]);
	const restartedBaseUrl = publishedBaseUrl();
	await waitForReady(restartedBaseUrl);

	const secondClaim = await fetch(`${restartedBaseUrl}/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const secondClaimBody = await secondClaim.json();
	if (secondClaim.status !== 403 || secondClaimBody.error !== "already_claimed") {
		throw new Error(`claim state did not survive restart (${secondClaim.status}): ${JSON.stringify(secondClaimBody)}`);
	}

	console.log("Docker smoke passed: non-root/read-only runtime, health, claim, exclusive volume, graceful stop, and restart persistence.");
} catch (error) {
	const logs = docker(["logs", container], { allowFailure: true });
	if (logs.stdout || logs.stderr) console.error(`\nContainer logs:\n${logs.stdout}${logs.stderr}`);
	throw error;
} finally {
	docker(["rm", "--force", container], { allowFailure: true });
	docker(["volume", "rm", "--force", volume], { allowFailure: true });
	if (builtImage) docker(["image", "rm", "--force", image], { allowFailure: true });
}
