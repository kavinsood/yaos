import * as encoding from "lib0/encoding";
import YSyncProvider, { messageAwareness, messageQueryAwareness } from "y-partyserver/provider";
import { encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { clientTimer } from "../runtime/testOnlyTimers";

/**
 * y-partyserver clears y-protocols' awareness check interval (the 15 s own
 * renewal + 30 s remote timeout), so without a replacement a peer whose
 * removal was lost (abnormal close the server did not see, a runtime wake
 * without the removal) stayed "present" forever.
 *
 * The replacement is deliberately slower than upstream: every renewal is a
 * frame the server must wake for and relay. A renewal every minute keeps a
 * live cursor fresh; a remote state not renewed for 2.5 renewals (so one lost
 * or late renewal is tolerated) is dropped. Only a non-empty own state is
 * renewed: the empty `{}` every provider starts with carries no presence and
 * would wake the server once a minute for every idle socket.
 */
export const AWARENESS_RENEW_MS = 60_000;
export const AWARENESS_REMOTE_TIMEOUT_MS = 150_000;
export const AWARENESS_CHECK_MS = 15_000;

type AwarenessChange = Parameters<YSyncProvider["_awarenessUpdateHandler"]>[0];

/**
 * y-partyserver provider that only ever transmits its own awareness state.
 *
 * Upstream re-broadcasts every changed awareness client, including remote
 * clients it just learned from the server, and answers an awareness query
 * with every known state. The YAOS server binds one awareness client per
 * socket and closes a socket that speaks for another client, so relaying a
 * peer's state made two online devices disconnect each other indefinitely.
 * Remote states are still applied locally; they are just never sent back.
 */
export class OwnAwarenessProvider extends YSyncProvider {
	constructor(...args: ConstructorParameters<typeof YSyncProvider>) {
		super(...args);
		const awareness = this.awareness;
		const upstream = this._awarenessUpdateHandler;
		this.sendAwareness = upstream;
		awareness.off("change", upstream);
		// Reassigned rather than wrapped in a second listener: destroy()
		// unsubscribes whatever this field holds.
		this._awarenessUpdateHandler = ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
			const own = (clients: number[]) => clients.filter((client) => client === awareness.clientID);
			const change = { added: own(added), updated: own(updated), removed: own(removed) };
			if (change.added.length + change.updated.length + change.removed.length === 0) return;
			upstream(change, origin);
		};
		awareness.on("change", this._awarenessUpdateHandler);
		// `messageHandlers` is a per-instance copy, so this does not leak into
		// other providers.
		this.messageHandlers[messageQueryAwareness] = (encoder, _decoder, provider) => {
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				encodeAwarenessUpdate(provider.awareness, [provider.awareness.clientID]),
			);
		};
		this.awarenessCheckTimer = setInterval(() => this.checkAwareness(),
			clientTimer("awarenessCheckMs", AWARENESS_CHECK_MS));
		// Node: never keep a process alive for presence upkeep.
		(this.awarenessCheckTimer as { unref?: () => void }).unref?.();
	}

	private awarenessCheckTimer: ReturnType<typeof setInterval> | null;
	private readonly sendAwareness: YSyncProvider["_awarenessUpdateHandler"];

	/**
	 * Renews the own state and drops remote states that stopped renewing.
	 * Runs on {@link AWARENESS_CHECK_MS}; public for deterministic tests.
	 */
	checkAwareness(now = Date.now()): void {
		const awareness = this.awareness;
		const local = awareness.getLocalState();
		const ownMeta = awareness.meta.get(awareness.clientID);
		if (this.wsconnected && local !== null && Object.keys(local).length > 0
			&& ownMeta && now - ownMeta.lastUpdated >= clientTimer("awarenessRenewMs", AWARENESS_RENEW_MS)) {
			// Same state, next clock. An unchanged state emits only "update",
			// and y-partyserver transmits on "change", so send it explicitly.
			awareness.setLocalState(local);
			this.sendAwareness({ added: [], updated: [awareness.clientID], removed: [] }, "renew");
		}
		const stale: number[] = [];
		awareness.meta.forEach((meta, clientId) => {
			if (clientId !== awareness.clientID && awareness.states.has(clientId)
				&& now - meta.lastUpdated >= clientTimer("awarenessRemoteTimeoutMs", AWARENESS_REMOTE_TIMEOUT_MS)) stale.push(clientId);
		});
		// Emits change/update with origin "timeout"; the own-only handler sends
		// nothing for remote clients, so this cannot start a relay ping-pong.
		if (stale.length > 0) removeAwarenessStates(awareness, stale, "timeout");
	}

	override destroy(): void {
		if (this.awarenessCheckTimer !== null) clearInterval(this.awarenessCheckTimer);
		this.awarenessCheckTimer = null;
		super.destroy();
	}
}
