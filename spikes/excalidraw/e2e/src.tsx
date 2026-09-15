import { Excalidraw } from "@excalidraw/excalidraw";
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface RoomElement extends ExcalidrawElement {
	version: number;
	versionNonce: number;
}

interface ReplayChange {
	sequence: number;
	elementId: string;
	element: RoomElement;
}

interface ProbeEvent {
	at: number;
	type: string;
	detail: unknown;
}

interface RoomConfiguration {
	actorId: string;
	actorRevision: number;
	backend: string;
	displayName: string;
	roomId: string;
	sessionId: string;
	vaultId: string;
}

interface ProbeMetrics {
	bootstrapApplies: number;
	onChangeCallbacks: number;
	outboundOperations: number;
	remoteApplyCallbacks: number;
	remoteApplyEchoes: number;
	remoteApplies: number;
	replayPolls: number;
	webSocketConnects: number;
}

declare global {
	interface Window {
		yaosE2E: {
			applyLocalElements: (elements: readonly RoomElement[]) => void;
			clearEvents: () => void;
			disconnect: () => void;
			getCollaborators: () => Array<[string, unknown]>;
			getElements: () => readonly RoomElement[];
			getEvents: () => readonly ProbeEvent[];
			getMetrics: () => ProbeMetrics;
			getSequence: () => number;
			getSocketState: () => number;
			reconnect: () => Promise<void>;
			sendPresence: (presence: Record<string, unknown>) => void;
		};
	}
}

const query = new URLSearchParams(window.location.search);
const configuration: RoomConfiguration = {
	actorId: query.get("actorId") ?? "actor-e2e",
	actorRevision: Number(query.get("actorRevision") ?? 1),
	backend: query.get("backend") ?? "https://yaos-excalidraw-spike-20260909.kavin.me.cloudflare.dev",
	displayName: query.get("displayName") ?? "E2E peer",
	roomId: query.get("roomId") ?? "room-e2e",
	sessionId: query.get("sessionId") ?? crypto.randomUUID(),
	vaultId: query.get("vaultId") ?? "vault-e2e",
};

const compareRevision = (left: RoomElement, right: RoomElement) =>
	left.version === right.version
		? right.versionNonce - left.versionNonce
		: left.version - right.version;

const sortElements = (elements: readonly RoomElement[]) => [...elements].sort((left, right) => {
	const byIndex = String(left.index ?? "").localeCompare(String(right.index ?? ""));
	return byIndex || left.id.localeCompare(right.id);
});

const mergeElements = (
	localElements: readonly RoomElement[],
	remoteElements: readonly RoomElement[],
) => {
	const merged = new Map(localElements.map((element) => [element.id, element]));
	let changed = false;
	for (const remote of remoteElements) {
		const local = merged.get(remote.id);
		if (!local || compareRevision(remote, local) > 0) {
			merged.set(remote.id, remote);
			changed = true;
		}
	}
	return { changed, elements: sortElements([...merged.values()]) };
};

function DrawingRoomProbe() {
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
	const configurationRef = useRef(configuration);
	const eventsRef = useRef<ProbeEvent[]>([]);
	const knownRef = useRef(new Map<string, RoomElement>());
	const metricsRef = useRef<ProbeMetrics>({
		bootstrapApplies: 0,
		onChangeCallbacks: 0,
		outboundOperations: 0,
		remoteApplyCallbacks: 0,
		remoteApplyEchoes: 0,
		remoteApplies: 0,
		replayPolls: 0,
		webSocketConnects: 0,
	});
	const operationCounterRef = useRef(0);
	const pollTimerRef = useRef<number | null>(null);
	const remoteApplyPendingRef = useRef(false);
	const runningRef = useRef(false);
	const sequenceRef = useRef(0);
	const socketRef = useRef<WebSocket | null>(null);
	const [ready, setReady] = useState(false);

	const event = useCallback((type: string, detail: unknown) => {
		eventsRef.current.push({ at: performance.now(), type, detail });
	}, []);

	const applyRemote = useCallback((elements: readonly RoomElement[], source: "bootstrap" | "replay") => {
		const api = apiRef.current;
		if (!api) return;
		const local = api.getSceneElementsIncludingDeleted() as readonly RoomElement[];
		const merged = mergeElements(local, elements);
		for (const element of elements) {
			const known = knownRef.current.get(element.id);
			if (!known || compareRevision(element, known) > 0) knownRef.current.set(element.id, element);
		}
		if (!merged.changed) return;
		metricsRef.current.remoteApplies += 1;
		if (source === "bootstrap") metricsRef.current.bootstrapApplies += 1;
		remoteApplyPendingRef.current = true;
		event("remote-apply", { source, elements: elements.map(({ id, version, versionNonce, isDeleted }) => ({ id, version, versionNonce, isDeleted })) });
		api.updateScene({ elements: merged.elements });
	}, [event]);

	const pollOnce = useCallback(async () => {
		if (!runningRef.current) return;
		metricsRef.current.replayPolls += 1;
		try {
			const response = await fetch(`/api/rooms/${encodeURIComponent(configurationRef.current.roomId)}/replay?after=${sequenceRef.current}`);
			if (!response.ok) throw new Error(`replay_${response.status}`);
			const body = await response.json() as { changes: ReplayChange[] };
			const batches = new Map<number, RoomElement[]>();
			for (const change of body.changes) {
				const batch = batches.get(change.sequence) ?? [];
				batch.push(change.element);
				batches.set(change.sequence, batch);
			}
			for (const [sequence, elements] of [...batches].sort(([left], [right]) => left - right)) {
				applyRemote(elements, "replay");
				sequenceRef.current = Math.max(sequenceRef.current, sequence);
			}
		} catch (error) {
			event("poll-error", error instanceof Error ? error.message : String(error));
		}
	}, [applyRemote, event]);

	const schedulePoll = useCallback(() => {
		if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
		pollTimerRef.current = window.setInterval(() => void pollOnce(), 75);
	}, [pollOnce]);

	const connectSocket = useCallback(async () => {
		const current = socketRef.current;
		if (current && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) return;
		const config = configurationRef.current;
		const socketBase = config.backend.replace(/^http/, "ws");
		const socketUrl = new URL(`${socketBase}/rooms/${encodeURIComponent(config.roomId)}/ws`);
		socketUrl.searchParams.set("sessionId", config.sessionId);
		socketUrl.searchParams.set("actorId", config.actorId);
		socketUrl.searchParams.set("displayName", config.displayName);
		const socket = new WebSocket(socketUrl);
		socketRef.current = socket;
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(() => reject(new Error("websocket_timeout")), 5_000);
			socket.addEventListener("open", () => {
				window.clearTimeout(timeout);
				metricsRef.current.webSocketConnects += 1;
				event("socket-open", config.sessionId);
				resolve();
			}, { once: true });
			socket.addEventListener("error", () => {
				window.clearTimeout(timeout);
				reject(new Error("websocket_error"));
			}, { once: true });
		});
		socket.addEventListener("message", (message) => {
			const presence = JSON.parse(String(message.data)) as Record<string, unknown>;
			event("presence", presence);
			const appState = apiRef.current?.getAppState();
			if (!appState) return;
			const collaborators = new Map(appState.collaborators);
			collaborators.set(String(presence.sessionId), {
				username: String(presence.displayName),
				pointer: {
					x: Number(presence.x),
					y: Number(presence.y),
					tool: presence.tool === "laser" ? "laser" : "pointer",
					...(presence.tool === "laser" ? { laserColor: "#ff0000" } : {}),
				},
				button: presence.tool === "laser" ? "down" : "up",
				actorId: presence.actorId,
			});
			apiRef.current?.updateScene({ collaborators: collaborators as AppState["collaborators"] });
		});
	}, [event]);

	const disconnect = useCallback(() => {
		runningRef.current = false;
		if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
		pollTimerRef.current = null;
		socketRef.current?.close(1000, "e2e_disconnect");
		socketRef.current = null;
		event("disconnected", sequenceRef.current);
	}, [event]);

	const reconnect = useCallback(async () => {
		runningRef.current = true;
		await connectSocket();
		await pollOnce();
		schedulePoll();
		event("reconnected", sequenceRef.current);
	}, [connectSocket, event, pollOnce, schedulePoll]);

	const capture = useCallback(async (
		elements: readonly ExcalidrawElement[],
		_appState: AppState,
		_files: BinaryFiles,
	) => {
		metricsRef.current.onChangeCallbacks += 1;
		const roomElements = elements as readonly RoomElement[];
		const changed = roomElements.filter((element) => {
			const known = knownRef.current.get(element.id);
			return !known || compareRevision(element, known) > 0;
		});
		const remoteApplyCallback = remoteApplyPendingRef.current;
		if (remoteApplyCallback) {
			metricsRef.current.remoteApplyCallbacks += 1;
			remoteApplyPendingRef.current = false;
		}
		if (remoteApplyCallback && changed.length > 0) metricsRef.current.remoteApplyEchoes += 1;
		if (changed.length === 0) {
			return;
		}
		for (const element of changed) knownRef.current.set(element.id, element);
		const config = configurationRef.current;
		const operationId = `${config.sessionId}-op-${++operationCounterRef.current}`;
		metricsRef.current.outboundOperations += 1;
		event("outbound", { operationId, elements: changed.map(({ id, version, versionNonce, isDeleted }) => ({ id, version, versionNonce, isDeleted })) });
		try {
			const response = await fetch(`/api/rooms/${encodeURIComponent(config.roomId)}/apply`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					vaultId: config.vaultId,
					operationId,
					actorId: config.actorId,
					actorRevision: config.actorRevision,
					elements: changed,
				}),
			});
			const receipt = await response.json();
			event("receipt", { status: response.status, receipt });
			if (!response.ok) throw new Error(`apply_${response.status}`);
		} catch (error) {
			event("apply-error", error instanceof Error ? error.message : String(error));
		}
	}, [event]);

	useEffect(() => {
		if (!ready) return;
		let cancelled = false;
		void (async () => {
			const response = await fetch(`/api/rooms/${encodeURIComponent(configuration.roomId)}/snapshot`);
			if (!response.ok) throw new Error(`snapshot_${response.status}`);
			const snapshot = await response.json() as { sequence: number; elements: RoomElement[] };
			if (cancelled) return;
			sequenceRef.current = snapshot.sequence;
			applyRemote(snapshot.elements, "bootstrap");
			runningRef.current = true;
			await connectSocket();
			if (cancelled) return;
			schedulePoll();
			document.querySelector("main")?.setAttribute("data-room-ready", "true");
			event("ready", { sequence: snapshot.sequence });
		})().catch((error) => event("startup-error", error instanceof Error ? error.message : String(error)));
		return () => {
			cancelled = true;
			disconnect();
		};
	}, [applyRemote, connectSocket, disconnect, event, ready, schedulePoll]);

	window.yaosE2E = {
		applyLocalElements(elements) {
			apiRef.current?.updateScene({ elements });
		},
		clearEvents() {
			eventsRef.current = [];
		},
		disconnect,
		getCollaborators() {
			return [...(apiRef.current?.getAppState().collaborators.entries() ?? [])];
		},
		getElements() {
			return (apiRef.current?.getSceneElementsIncludingDeleted() ?? []) as readonly RoomElement[];
		},
		getEvents() {
			return eventsRef.current;
		},
		getMetrics() {
			return { ...metricsRef.current };
		},
		getSequence() {
			return sequenceRef.current;
		},
		getSocketState() {
			return socketRef.current?.readyState ?? WebSocket.CLOSED;
		},
		reconnect,
		sendPresence(presence) {
			socketRef.current?.send(JSON.stringify({
				type: "presence",
				sessionId: "spoofed-session",
				actorId: "spoofed-actor",
				...presence,
			}));
		},
	};

	return <main style={{ height: "100vh" }} data-component-ready={ready} data-room-ready="false">
		<Excalidraw
			excalidrawAPI={(api) => {
				apiRef.current = api;
				setReady(true);
			}}
			onChange={capture}
		/>
	</main>;
}

createRoot(document.getElementById("root")!).render(<DrawingRoomProbe />);
