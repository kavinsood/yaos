// Decodes GET /streams/read replies (relay-wire §7.2) for the server suites.
import { strict as assert } from "node:assert";

import { STREAM_READ_BINARY_TYPE, decodeReadReply } from "../../../server/src/streams/protocol";
import type { StreamReadReplyPage } from "../../../server/src/streams/protocol";

export type ReadReply = { vaultEpoch: string; head: number; pages: StreamReadReplyPage[] };

/** A successful read or batched read: asserts 200 and the binary Content-Type, then decodes. */
export async function readReply(response: Response): Promise<ReadReply> {
	assert.equal(response.status, 200, "read status");
	assert.equal(response.headers.get("content-type"), STREAM_READ_BINARY_TYPE);
	return decodeReadReply(new Uint8Array(await response.arrayBuffer()));
}

/** A single read: its one page, with the reply's vaultEpoch and head. */
export async function readPage(response: Response): Promise<StreamReadReplyPage & { vaultEpoch: string; head: number }> {
	const reply = await readReply(response);
	assert.equal(reply.pages.length, 1, "a single read has one page");
	return { vaultEpoch: reply.vaultEpoch, head: reply.head, ...reply.pages[0]! };
}
