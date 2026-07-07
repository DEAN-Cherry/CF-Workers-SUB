import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = (algorithm, data) => {
	if (algorithm === "MD5") {
		const hash = createHash("md5").update(new Uint8Array(data)).digest();
		return Promise.resolve(hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength));
	}
	return originalDigest(algorithm, data);
};

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

function createFakeKV() {
	const store = new Map();
	return {
		store,
		async get(key) {
			return store.get(key)?.value ?? null;
		},
		async getWithMetadata(key) {
			const entry = store.get(key);
			return entry ? { value: entry.value, metadata: entry.metadata } : { value: null, metadata: null };
		},
		async put(key, value, options = {}) {
			store.set(key, { value, metadata: options.metadata ?? null });
		}
	};
}

const inboundRequest = () => new Request("https://worker.example/sub", {
	headers: { "user-agent": "ClientApp/1.0" }
});

test("getSUB serves fresh cache without hitting upstream", async () => {
	const kv = createFakeKV();
	let fetchCount = 0;
	globalThis.fetch = async () => {
		fetchCount++;
		return new Response("vless://live@example.com:443#live");
	};

	const cache = { kv, ctx: null, ttlMs: 15 * 60 * 1000, nocache: false };
	const first = await getSUB(["https://a.example/sub"], inboundRequest(), "v2rayn", "ClientApp/1.0", 5000, cache);
	assert.equal(fetchCount, 1);
	assert.deepEqual(first[0], ["vless://live@example.com:443#live"]);

	const second = await getSUB(["https://a.example/sub"], inboundRequest(), "v2rayn", "ClientApp/1.0", 5000, cache);
	assert.equal(fetchCount, 1);
	assert.deepEqual(second[0], ["vless://live@example.com:443#live"]);
});

test("getSUB returns stale cache immediately and refreshes in background", async () => {
	const kv = createFakeKV();
	let fetchCount = 0;
	globalThis.fetch = async () => {
		fetchCount++;
		return new Response("vless://new@example.com:443#new");
	};

	const waited = [];
	const ctx = { waitUntil(promise) { waited.push(promise); } };
	const cache = { kv, ctx, ttlMs: 15 * 60 * 1000, nocache: false };

	const key = [...kv.store.keys()];
	await kv.put(await cacheKeyFor("https://a.example/sub"), "vless://old@example.com:443#old", {
		metadata: { ts: Date.now() - 16 * 60 * 1000 }
	});
	assert.equal(key.length, 0);

	const result = await getSUB(["https://a.example/sub"], inboundRequest(), "v2rayn", "ClientApp/1.0", 5000, cache);
	assert.deepEqual(result[0], ["vless://old@example.com:443#old"]);
	assert.equal(waited.length, 1);

	await Promise.all(waited);
	assert.equal(fetchCount, 1);
	const refreshed = await kv.get(await cacheKeyFor("https://a.example/sub"));
	assert.equal(refreshed, "vless://new@example.com:443#new");
});

test("getSUB falls back to cached content when upstream fails", async () => {
	const kv = createFakeKV();
	globalThis.fetch = async () => new Response("boom", { status: 502 });

	const cache = { kv, ctx: null, ttlMs: 15 * 60 * 1000, nocache: true };
	await kv.put(await cacheKeyFor("https://a.example/sub"), "vless://old@example.com:443#old", {
		metadata: { ts: Date.now() - 60 * 60 * 1000 }
	});

	const result = await getSUB(["https://a.example/sub"], inboundRequest(), "v2rayn", "ClientApp/1.0", 5000, cache);
	assert.deepEqual(result[0], ["vless://old@example.com:443#old"]);
});

async function cacheKeyFor(url) {
	const md5 = text => createHash("md5").update(text).digest("hex");
	return "SUBCACHE:" + md5(md5(url).slice(7, 27));
}
