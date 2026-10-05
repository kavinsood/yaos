// YAOS day-1 spike plugin entry (throwaway). Answers:
//   OR-1  does a Blob-URL dedicated worker start on this platform, and does
//         IndexedDB open inside it? (else: inline/main-thread fallback)
//   OR-2  how does Obsidian reload an open MarkdownView when its file changes,
//         and can a per-instance setViewData wrapper intercept it?
// Built by scripts/build-spike.mjs; the worker source is injected via esbuild
// `define` as __YAOS_SPIKE_WORKER_SRC__ (no virtual module import).
import { apiVersion, normalizePath, Notice, Platform, Plugin } from "obsidian";
import { runIdbProbe } from "./idbProbe";
import { computeVerdicts, errInfo, formatReport, settle, stamp, type Or1Report, type SpikeReport } from "./report";
import { ResultsModal } from "./resultsModal";
import { runViewProbe } from "./viewProbe";
import { runWorkerProbe } from "./workerProbe";

declare const __YAOS_SPIKE_WORKER_SRC__: string;
declare const __YAOS_SPIKE_BUILD__: string;

type Part = "or1" | "or2";

export default class YaosSpikePlugin extends Plugin {
	private running = false;
	private last: { report: SpikeReport; json: string } | null = null;

	onload(): void {
		this.addRibbonIcon("flask-conical", "YAOS spike: run probes", () => {
			void this.run(["or1", "or2"]);
		});
		this.addCommand({ id: "run-probes", name: "Run probes", callback: () => void this.run(["or1", "or2"]) });
		this.addCommand({ id: "run-or1", name: "Run OR-1 only (Blob-URL worker + IndexedDB)", callback: () => void this.run(["or1"]) });
		this.addCommand({ id: "run-or2", name: "Run OR-2 only (setViewData interception)", callback: () => void this.run(["or2"]) });
		this.addCommand({ id: "show-last-report", name: "Show last report", callback: () => this.show() });
	}

	private async run(parts: Part[]): Promise<void> {
		if (this.running) {
			new Notice("YAOS spike is already running");
			return;
		}
		this.running = true;
		const notice = new Notice("YAOS spike: starting (about 45 s; do not touch the probe tab)", 0);
		const progress = (m: string): void => {
			try {
				notice.setMessage(`YAOS spike: ${m}`);
			} catch {
				/* ignore */
			}
		};
		const t0 = Date.now();
		const report: SpikeReport = {
			spike: { id: this.manifest.id, version: this.manifest.version, build: buildId(), startedAt: new Date(t0).toISOString(), ran: parts },
			env: {},
		};
		try {
			report.env = await collectEnv(this);
			if (parts.includes("or1")) {
				try {
					report.or1 = await runOr1(progress);
				} catch (e) {
					report.or1Crash = errInfo(e, true);
				}
			}
			if (parts.includes("or2")) {
				try {
					report.or2 = await runViewProbe(this.app, { onProgress: progress });
				} catch (e) {
					report.or2Crash = errInfo(e, true);
				}
			}
		} catch (e) {
			report.env.collectCrash = errInfo(e, true);
		} finally {
			report.spike.finishedAt = new Date().toISOString();
			report.spike.durationMs = Date.now() - t0;
			try {
				report.verdicts = computeVerdicts(report);
			} catch (e) {
				report.env.verdictCrash = errInfo(e, true);
			}
			notice.hide();
			this.running = false;
			const json = formatReport(report);
			this.last = { report, json };
			console.log("[yaos-spike] report\n" + json);
			this.show();
		}
	}

	private show(): void {
		const last = this.last;
		if (!last) {
			new Notice("No YAOS spike report yet: run the probes first");
			return;
		}
		new ResultsModal(this.app, {
			title: "YAOS spike results",
			summary: last.report.verdicts?.lines ?? ["(no verdicts computed; see JSON)"],
			json: last.json,
			onSave: () => this.saveReport(last),
		}).open();
	}

	private async saveReport(last: { report: SpikeReport; json: string }): Promise<string> {
		const label = (last.report.verdicts?.platform ?? "unknown").replace(/[^a-z0-9]+/gi, "-");
		const path = normalizePath(`yaos-spike-report-${label}-${stamp()}.md`);
		const lines = (last.report.verdicts?.lines ?? []).map((l) => `- ${l}`).join("\n");
		await this.app.vault.create(path, `# YAOS spike report (${label})\n\n${lines}\n\n\`\`\`json\n${last.json}\n\`\`\`\n`);
		return path;
	}
}

function buildId(): string {
	return typeof __YAOS_SPIKE_BUILD__ === "string" ? __YAOS_SPIKE_BUILD__ : "dev";
}

function workerSource(): string {
	return typeof __YAOS_SPIKE_WORKER_SRC__ === "string" ? __YAOS_SPIKE_WORKER_SRC__ : "";
}

async function runOr1(progress: (m: string) => void): Promise<Or1Report> {
	const or1: Or1Report = { worker: null, cspViolations: [], inlineIdb: null };
	const onCsp = (e: SecurityPolicyViolationEvent): void => {
		or1.cspViolations.push({
			blockedURI: e.blockedURI,
			violatedDirective: e.violatedDirective,
			effectiveDirective: e.effectiveDirective,
			disposition: e.disposition,
			sourceFile: e.sourceFile,
		});
	};
	document.addEventListener("securitypolicyviolation", onCsp);
	try {
		or1.worker = await runWorkerProbe({
			source: workerSource(),
			makeUrl: (src) => URL.createObjectURL(new Blob([src], { type: "text/javascript" })),
			makeWorker: (url) => new Worker(url),
			revokeUrl: (url) => URL.revokeObjectURL(url),
			onProgress: (m) => progress(`OR-1 ${m}`),
		});
	} catch (e) {
		or1.workerCrash = errInfo(e, true);
	} finally {
		document.removeEventListener("securitypolicyviolation", onCsp);
	}
	progress("OR-1 main-thread IndexedDB (inline fallback path)");
	try {
		or1.inlineIdb = await runIdbProbe(() => (typeof indexedDB === "undefined" ? undefined : indexedDB), { where: "main" });
	} catch (e) {
		or1.inlineCrash = errInfo(e, true);
	}
	return or1;
}

async function collectEnv(plugin: Plugin): Promise<Record<string, unknown>> {
	const env: Record<string, unknown> = {};
	const put = (k: string, read: () => unknown): void => {
		try {
			env[k] = read();
		} catch (e) {
			env[k] = `<threw ${errInfo(e).name}: ${errInfo(e).message}>`;
		}
	};
	put("apiVersion", () => apiVersion);
	put("platform", () => {
		const o: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(Platform)) o[k] = v;
		return o;
	});
	put("userAgent", () => navigator.userAgent);
	put("hardwareConcurrency", () => navigator.hardwareConcurrency);
	put("deviceMemory", () => {
		const nav: Navigator & { deviceMemory?: unknown } = navigator;
		return nav.deviceMemory ?? null;
	});
	put("language", () => navigator.language);
	put("typeofWorker", () => typeof Worker);
	put("typeofBlob", () => typeof Blob);
	put("typeofURLcreateObjectURL", () => typeof URL.createObjectURL);
	put("typeofMessageChannel", () => typeof MessageChannel);
	put("typeofRequestIdleCallback", () => typeof requestIdleCallback);
	put("typeofIndexedDB", () => typeof indexedDB);
	put("typeofStructuredClone", () => typeof structuredClone);
	put("typeofWebSocket", () => typeof WebSocket);
	put("typeofSharedArrayBuffer", () => typeof SharedArrayBuffer);
	put("crossOriginIsolated", () => crossOriginIsolated);
	put("isSecureContext", () => isSecureContext);
	put("locationOrigin", () => location.origin);
	put("locationProtocol", () => location.protocol);
	put("cspMeta", () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null);
	put("screen", () => `${screen.width}x${screen.height}@${devicePixelRatio}`);
	put("vaultAdapter", () => plugin.app.vault.adapter.constructor.name);
	put("workerSourceBytes", () => workerSource().length);
	const persisted = await settle<boolean | string>(
		() => (navigator.storage && typeof navigator.storage.persisted === "function" ? navigator.storage.persisted() : "absent"),
		2000,
	);
	env.storagePersisted = persisted.kind === "ok" ? persisted.value : persisted.kind === "hang" ? "<hang>" : `<error ${persisted.error.name}>`;
	return env;
}
