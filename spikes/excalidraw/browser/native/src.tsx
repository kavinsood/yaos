import { Excalidraw } from "@excalidraw/excalidraw";
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

interface ProbeEvent {
	type: string;
	detail: unknown;
}

declare global {
	interface Window {
		yaosProbe: {
			applyElements: (elements: readonly ExcalidrawElement[]) => void;
			applyCollaborators: (collaborators: AppState["collaborators"]) => void;
			clearEvents: () => void;
			getAppState: () => AppState | null;
			getEvents: () => readonly ProbeEvent[];
			getElements: () => readonly ExcalidrawElement[];
		};
	}
}

function Probe() {
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
	const eventsRef = useRef<ProbeEvent[]>([]);
	const [ready, setReady] = useState(false);

	const capture = useCallback((
		elements: readonly ExcalidrawElement[],
		_appState: AppState,
		_files: BinaryFiles,
	) => {
		eventsRef.current.push({
			type: "change",
			detail: elements.map((element) => ({
				id: element.id,
				version: element.version,
				versionNonce: element.versionNonce,
				isDeleted: element.isDeleted,
				index: element.index,
			})),
		});
	}, []);

	window.yaosProbe = {
		applyElements(elements) {
			apiRef.current?.updateScene({ elements });
		},
		applyCollaborators(collaborators) {
			apiRef.current?.updateScene({ collaborators });
		},
		clearEvents() {
			eventsRef.current = [];
		},
		getAppState() {
			return apiRef.current?.getAppState() ?? null;
		},
		getEvents() {
			return eventsRef.current;
		},
		getElements() {
			return apiRef.current?.getSceneElementsIncludingDeleted() ?? [];
		},
	};

	return <main style={{ height: "100vh" }} data-probe-ready={ready}>
		<Excalidraw
			excalidrawAPI={(api) => {
				apiRef.current = api;
				setReady(true);
			}}
			onChange={capture}
			onPointerUpdate={(payload) => {
				eventsRef.current.push({ type: "pointer", detail: payload });
			}}
			onPointerUp={() => {
				eventsRef.current.push({ type: "pointer-up", detail: null });
			}}
		/>
	</main>;
}

createRoot(document.getElementById("root")!).render(<Probe />);
