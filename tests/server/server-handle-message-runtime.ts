import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type { Connection, WSMessage } from "partyserver";
import { VaultSyncServer } from "../../server/src/server";
import type { Env } from "../../server/src/routes/types";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";

const s = suite("server-handle-message-runtime");
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const CUSTOM_PREFIX = "__YPS:";

interface RuntimeUpdateStats {
	messages: number;
	changed: number;
	unchanged: number;
}

interface SentConnection {
	readonly connection: Connection;
	readonly sent: WSMessage[];
}
interface ParentMessagePrototype {
	handleMessage(connection: Connection, message: WSMessage): void;
}

// Patch the actual immediate superclass used by VaultSyncServer. Importing
// YServer separately can resolve through another module instance under JITI.
const parentPrototype = Object.getPrototypeOf(VaultSyncServer.prototype) as ParentMessagePrototype;


function makeServer(): VaultSyncServer {
	return new VaultSyncServer(
		partialOf<DurableObjectState>({
			storage: partialOf<DurableObjectStorage>({}),
		}),
		partialOf<Env>({}),
	);
}

function makeConnection(onSend?: (message: WSMessage) => void): SentConnection {
	const sent: WSMessage[] = [];
	const connection = partialOf<Connection>({
		id: "runtime-connection",
		readyState: 1,
		state: null,
		tags: ["runtime-connection"],
		server: "runtime-room",
		send(message: WSMessage) {
			onSend?.(message);
			sent.push(message);
		},
		setState() {
			return null;
		},
	});
	return { connection, sent };
}

function frameUpdate(update: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	syncProtocol.writeUpdate(encoder, update);
	return encoding.toUint8Array(encoder);
}

function frameAwareness(update: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
	encoding.writeVarUint8Array(encoder, update);
	return encoding.toUint8Array(encoder);
}

function postApplyEchoes(sent: readonly WSMessage[]): string[] {
	return sent.filter((message): message is string =>
		typeof message === "string"
		&& message.startsWith(CUSTOM_PREFIX)
		&& message.includes('"type":"yaos/sv-echo"'),
	);
}

function runtimeStats(server: VaultSyncServer): RuntimeUpdateStats {
	const value: unknown = Object.getOwnPropertyDescriptor(server, "updateStats")?.value;
	if (
		typeof value !== "object"
		|| value === null
		|| !("messages" in value)
		|| !("changed" in value)
		|| !("unchanged" in value)
		|| typeof value.messages !== "number"
		|| typeof value.changed !== "number"
		|| typeof value.unchanged !== "number"
	) {
		throw new Error("VaultSyncServer updateStats runtime shape is unavailable");
	}
	return {
		messages: value.messages,
		changed: value.changed,
		unchanged: value.unchanged,
	};
}
s.section("classification is captured before the parent and echo follows parent completion");
{
	const server = makeServer();
	const events: string[] = [];
	const { connection, sent } = makeConnection(() => { events.push("echo"); });
	const source = new Y.Doc();
	source.getText("note").insert(0, "classified update");
	const frame = frameUpdate(Y.encodeStateAsUpdate(source));
	const parentHandleMessage = parentPrototype.handleMessage;

	try {
		parentPrototype.handleMessage = function (_connection: Connection, message: WSMessage): void {
			events.push("parent");
			// If VaultSyncServer classified after delegating, this mutation would turn
			// the frame into a non-update and suppress the post-apply echo.
			if (message instanceof Uint8Array) message[0] = MESSAGE_AWARENESS;
		} as typeof parentHandleMessage;

		server.handleMessage(connection, frame);
	} finally {
		parentPrototype.handleMessage = parentHandleMessage;
	}

	s.check(postApplyEchoes(sent).length === 1, "update classification survives parent mutation of the frame");
	s.check(events.join(" -> ") === "parent -> echo", `postApply echo occurs after parent returns (${events.join(" -> ")})`);
	source.destroy();
	server.document.destroy();
}

s.section("a throwing parent propagates and never emits postApply");
{
	const server = makeServer();
	const { connection, sent } = makeConnection();
	const source = new Y.Doc();
	source.getText("note").insert(0, "throwing update");
	const frame = frameUpdate(Y.encodeStateAsUpdate(source));
	const parentHandleMessage = parentPrototype.handleMessage;
	let thrown: unknown = null;

	try {
		parentPrototype.handleMessage = function (): void {
			throw new Error("injected parent failure");
		} as typeof parentHandleMessage;
		try {
			server.handleMessage(connection, frame);
		} catch (error) {
			thrown = error;
		}
	} finally {
		parentPrototype.handleMessage = parentHandleMessage;
	}

	s.check(thrown instanceof Error && thrown.message === "injected parent failure", "parent failure is observable by the caller");
	s.check(postApplyEchoes(sent).length === 0, "parent failure emits no postApply echo");
	source.destroy();
	server.document.destroy();
}


s.section("awareness and malformed frames emit no postApply");
{
	const server = makeServer();
	const { connection, sent } = makeConnection();
	const awarenessDoc = new Y.Doc();
	const awareness = new awarenessProtocol.Awareness(awarenessDoc);
	awareness.setLocalState({ user: { name: "runtime" } });
	const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [awarenessDoc.clientID]);

	server.handleMessage(connection, frameAwareness(update));
	const originalError = console.error;
	try {
		console.error = () => {};
		server.handleMessage(connection, new Uint8Array([MESSAGE_SYNC]));
	} finally {
		console.error = originalError;
	}

	s.check(postApplyEchoes(sent).length === 0, "awareness and malformed frames emit no postApply echo");
	awareness.destroy();
	awarenessDoc.destroy();
	server.document.destroy();
}

s.section("delete-only apply is counted as changed even when the state vector is equal");
{
	const server = makeServer();
	const { connection, sent } = makeConnection();
	const source = new Y.Doc();
	const text = source.getText("note");
	text.insert(0, "delete-only payload");
	Y.applyUpdate(server.document, Y.encodeStateAsUpdate(source));
	const stateVectorBefore = Buffer.from(Y.encodeStateVector(server.document)).toString("hex");
	text.delete(0, text.length);
	const stateVectorAfter = Buffer.from(Y.encodeStateVector(source)).toString("hex");
	const deletion = Y.encodeStateAsUpdate(source, Y.encodeStateVector(server.document));
	const before = { ...runtimeStats(server) };

	server.handleMessage(connection, frameUpdate(deletion));
	const after = runtimeStats(server);

	s.check(stateVectorBefore === stateVectorAfter, "delete-only update leaves the state vector byte-identical (precondition)");
	s.check(server.document.getText("note").toString() === "", "production parent applied the deletion");
	s.check(after.messages === before.messages + 1, "delete-only frame increments update message count");
	s.check(after.changed === before.changed + 1, "docUpdateCount classifies delete-only apply as changed");
	s.check(after.unchanged === before.unchanged, "delete-only apply is not misclassified as unchanged");
	s.check(postApplyEchoes(sent).length === 1, "delete-only update emits one postApply echo");
	source.destroy();
	server.document.destroy();
}

await s.done();
