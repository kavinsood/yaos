import { requestUrl } from "obsidian";

export interface HttpRequest {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text: string;
}

export type HttpRequester = (request: HttpRequest) => Promise<HttpResponse>;

export type FetchCompatible = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const utf8 = new TextDecoder();

/**
 * Adapt the standard fetch contract to the eager response shape used by the
 * Obsidian client. The response body is consumed once and byte responses retain
 * fetch's original ArrayBuffer.
 */
export function createFetchRequester(fetchImpl: FetchCompatible): HttpRequester {
	return async (request) => {
		const headers = request.contentType === undefined
			? request.headers
			: { "Content-Type": request.contentType, ...request.headers };
		const response = await fetchImpl(request.url, {
			method: request.method,
			headers,
			body: request.body,
		});
		const arrayBuffer = await response.arrayBuffer();
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			responseHeaders[name] = value;
		});
		const contentType = response.headers.get("content-type") ?? "";
		let decodedText: string | undefined;
		let parsedJson = false;
		let json: unknown;
		return {
			status: response.status,
			headers: responseHeaders,
			arrayBuffer,
			get text() {
				return decodedText ??= utf8.decode(arrayBuffer);
			},
			get json() {
				if (!parsedJson) {
					parsedJson = true;
					if (contentType.includes("json")) {
						const text = decodedText ??= utf8.decode(arrayBuffer);
						json = text.length === 0 ? undefined : JSON.parse(text) as unknown;
					}
				}
				return json;
			},
		};
	};
}

export const obsidianRequest: HttpRequester = async (request) =>
	await requestUrl({
		...request,
		throw: false,
	});
