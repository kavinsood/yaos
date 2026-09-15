import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PublicShareBrowserClient } from "../../src/sync/excalidraw/browserClient";
import type { BrowserExcalidrawApi } from "../../src/sync/excalidraw/browserHost";
import {
	PublicShareExcalidrawTransport,
	PublicShareSessionClient,
	type PublicShareSession,
} from "../../src/sync/excalidraw/browserTransport";
import { PublicShareExcalidrawResources } from "../../src/sync/excalidraw/browserResources";
import { MemoryExcalidrawPersistence } from "../../src/sync/excalidraw/persistence";

const SESSION_KEY = "yaos.excalidraw.public-session.v1";

function storedSession(): PublicShareSession | null {
	try {
		const value = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "null") as Partial<PublicShareSession> | null;
		if (!value || typeof value.publicDrawingId !== "string" || !Number.isSafeInteger(value.drawingEpoch)
			|| (value.permission !== "read-only" && value.permission !== "read-write")
			|| !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.grantRevision)) return null;
		return value as PublicShareSession;
	} catch {
		return null;
	}
}

function browserApi(api: ExcalidrawImperativeAPI): BrowserExcalidrawApi {
	return {
		getSceneElementsIncludingDeleted: () => api.getSceneElementsIncludingDeleted(),
		getFiles: () => api.getFiles() as unknown as Record<string, unknown>,
		getAppState: () => api.getAppState() as unknown as Record<string, unknown>,
		addFiles: (files) => api.addFiles(files as never),
		updateScene: (scene) => api.updateScene(scene as never),
	};
}

function ShareApp(): React.ReactElement {
	const [session, setSession] = useState<PublicShareSession | null>(null);
	const [message, setMessage] = useState("Opening shared drawing…");
	const [error, setError] = useState<string | null>(null);
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
	const [elementCount, setElementCount] = useState(0);
	const clientRef = useRef<PublicShareBrowserClient | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				let current: PublicShareSession | null;
				if (window.location.hash) {
					const secret = PublicShareSessionClient.consumeFragment(window.location, window.history,
						window.location.pathname, window.location.search);
					current = await new PublicShareSessionClient(window.location.origin).exchange(secret);
					window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(current));
				} else current = storedSession();
				if (!current) throw new Error("This share link is missing or has already been removed from this tab.");
				if (current.expiresAt <= Date.now()) throw new Error("This share session has expired. Open the original link again.");
				if (!cancelled) setSession(current);
			} catch (reason) {
				window.sessionStorage.removeItem(SESSION_KEY);
				if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not open this shared drawing.");
			}
		})();
		return () => { cancelled = true; };
	}, []);

	const start = useCallback((api: ExcalidrawImperativeAPI): void => {
		setApi(api);
	}, []);

	useEffect(() => {
		if (!session || !api) return;
		const transport = new PublicShareExcalidrawTransport(window.location.origin, session);
		const resources = new PublicShareExcalidrawResources(window.location.origin, () => session.permission);
		const client = new PublicShareBrowserClient({
			session,
			transport,
			resources,
			persistence: new MemoryExcalidrawPersistence(),
			onStatus: (status) => {
				if (status.phase === "live") setMessage("Live · read-only");
				else if (status.phase === "recovering") setMessage("Catching up…");
				else if (status.phase === "degraded") setMessage(status.reason ?? "Connection degraded");
				else setMessage("Disconnected");
			},
			onDegraded: (reason) => setMessage(reason),
		});
		clientRef.current = client;
		void client.start(browserApi(api)).catch((reason) => {
			setError(reason instanceof Error ? reason.message : "Could not synchronize this drawing.");
		});
		return () => {
			client.stop();
			if (clientRef.current === client) clientRef.current = null;
		};
	}, [api, session]);

	if (error) {
		return React.createElement("main", { className: "share-state share-error" },
			React.createElement("div", { className: "share-card" },
				React.createElement("p", { className: "share-kicker" }, "YAOS · Excalidraw"),
				React.createElement("h1", null, "Shared drawing unavailable"),
				React.createElement("p", null, error)));
	}
	if (!session) {
		return React.createElement("main", { className: "share-state" },
			React.createElement("div", { className: "share-spinner", "aria-hidden": "true" }),
			React.createElement("p", null, message));
	}

	return React.createElement("main", { className: "share-shell", "data-yaos-element-count": elementCount },
		React.createElement("div", { className: "share-status", role: "status", "data-yaos-share-status": message }, message),
		React.createElement("div", { className: "share-canvas" }, React.createElement(Excalidraw, {
			excalidrawAPI: start,
			viewModeEnabled: true,
			zenModeEnabled: true,
			gridModeEnabled: false,
			isCollaborating: true,
			onChange: (elements, appState, files) => {
				setElementCount(elements.filter((element) => !element.isDeleted).length);
				clientRef.current?.handleSceneChange(elements, appState as unknown as Record<string, unknown>,
					files as unknown as Record<string, unknown>);
			},
			onPointerUpdate: (payload) => clientRef.current?.handlePointerUpdate(payload),
		})),
	);
}

const container = document.getElementById("root");
if (!container) throw new Error("YAOS share application root is missing");
createRoot(container).render(React.createElement(ShareApp));
