import assert from "node:assert/strict";
import test from "node:test";

import { getSUB, getUrl } from "../_worker.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("getUrl keeps http numeric-host URLs and strips inbound credentials", async () => {
	let capturedRequest;
	globalThis.fetch = async request => {
		capturedRequest = request;
		return new Response("vless://user@example.com:443?type=tcp#ok");
	};

	const inboundRequest = new Request("https://worker.example/sub", {
		headers: {
			"authorization": "Bearer secret",
			"cookie": "session=secret",
			"user-agent": "ClientApp/1.0",
			"x-forwarded-proto": "https"
		}
	});

	await getUrl(
		inboundRequest,
		"http://198.51.100.10:2096/sub/example?format=json",
		"v2rayn",
		"ClientApp/1.0"
	);

	assert.ok(capturedRequest instanceof Request);
	assert.equal(capturedRequest.url, "http://198.51.100.10:2096/sub/example?format=json");
	assert.equal(capturedRequest.headers.has("authorization"), false);
	assert.equal(capturedRequest.headers.has("cookie"), false);
	assert.equal(capturedRequest.headers.has("x-forwarded-proto"), false);
	assert.match(capturedRequest.headers.get("user-agent") ?? "", /CF-Workers-SUB/);
});

test("getSUB returns successful upstreams when another upstream stalls", async () => {
	globalThis.fetch = async request => {
		if (request.url === "https://good.example/sub") {
			return new Response("vless://good@example.com:443?type=tcp#good");
		}

		return new Promise((_, reject) => {
			request.signal.addEventListener("abort", () => {
				const error = new DOMException("The operation was aborted", "AbortError");
				reject(error);
			}, { once: true });
		});
	};

	const inboundRequest = new Request("https://worker.example/sub", {
		headers: { "user-agent": "ClientApp/1.0" }
	});

	const result = await Promise.race([
		getSUB([
			"https://good.example/sub",
			"https://stalled.example/sub"
		], inboundRequest, "v2rayn", "ClientApp/1.0", 20),
		new Promise((_, reject) => setTimeout(() => reject(new Error("aggregation timed out")), 150))
	]);

	assert.deepEqual(result[0], ["vless://good@example.com:443?type=tcp#good"]);
	assert.equal(result[1], "");
});
