import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMENT_PAGE_CACHE_MAX_BYTES,
  COMMENT_PAGE_CACHE_MAX_ENTRIES,
  CommentPageCache,
} from "main/jams/comment-page-cache";
import { JAM_PUBLIC_COMMENT_CACHE_TTL_MS } from "common/jams/cache-policy";

test("comment page cache uses the shared TTL and bounded defaults", () => {
  assert.equal(JAM_PUBLIC_COMMENT_CACHE_TTL_MS, 30 * 60_000);
  assert.equal(COMMENT_PAGE_CACHE_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(COMMENT_PAGE_CACHE_MAX_ENTRIES, 128);
});

test("same-URL concurrent normal and fresh requests share one load", async () => {
  const cache = new CommentPageCache();
  let calls = 0;
  let resolveLoad!: (value: string) => void;
  const load = () => {
    calls += 1;
    return new Promise<string>((resolve) => (resolveLoad = resolve));
  };
  const normal = cache.get("https://example.test/rate/1", load);
  const fresh = cache.get("https://example.test/rate/1", load, { fresh: true });
  assert.equal(normal, fresh);
  assert.equal(calls, 0); // load starts in a microtask, after registration
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveLoad("validated html");
  assert.deepEqual(await Promise.all([normal, fresh]), [
    "validated html",
    "validated html",
  ]);
});

test("fresh bypasses completed cache and replaces it after a successful load", async () => {
  const cache = new CommentPageCache();
  let calls = 0;
  const load = async () => `page ${++calls}`;
  assert.equal(await cache.get("u", load), "page 1");
  assert.equal(await cache.get("u", load), "page 1");
  assert.equal(await cache.get("u", load, { fresh: true }), "page 2");
  assert.equal(await cache.get("u", load), "page 2");
  assert.equal(calls, 2);
});

test("expired entries reload and failures are not cached", async () => {
  let now = 100;
  const cache = new CommentPageCache({ now: () => now, ttlMs: 50 });
  let calls = 0;
  const load = async () => `page ${++calls}`;
  assert.equal(await cache.get("u", load), "page 1");
  now = 149;
  assert.equal(await cache.get("u", load), "page 1");
  now = 150;
  assert.equal(await cache.get("u", load), "page 2");

  let attempts = 0;
  const retry = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network error");
    return "retry succeeded";
  };
  await assert.rejects(cache.get("retry", retry), /network error/);
  assert.equal(await cache.get("retry", retry), "retry succeeded");
  assert.equal(attempts, 2);
});

test("entry LRU evicts the least recently used page", async () => {
  const cache = new CommentPageCache({ maxEntries: 2 });
  const calls = new Map<string, number>();
  const load = (key: string) => async () => {
    const next = (calls.get(key) || 0) + 1;
    calls.set(key, next);
    return `${key}${next}`;
  };
  assert.equal(await cache.get("a", load("a")), "a1");
  assert.equal(await cache.get("b", load("b")), "b1");
  assert.equal(await cache.get("a", load("a")), "a1"); // refresh a's LRU position
  assert.equal(await cache.get("c", load("c")), "c1"); // evicts b
  assert.equal(await cache.get("a", load("a")), "a1");
  assert.equal(await cache.get("b", load("b")), "b2");
});

test("UTF-8 byte budget evicts old pages and never admits an oversized page", async () => {
  const cache = new CommentPageCache({ maxBytes: 5 });
  let callsA = 0;
  let callsB = 0;
  assert.equal(await cache.get("a", async () => `a${++callsA}`), "a1");
  assert.equal(await cache.get("b", async () => `éé${++callsB}`), "éé1");
  assert.equal(await cache.get("a", async () => `a${++callsA}`), "a2");
  assert.equal(await cache.get("oversized", async () => "ééé"), "ééé");
  assert.equal(await cache.get("oversized", async () => "ééé"), "ééé");
  assert.equal(callsA, 2);
});

test("fresh oversized result removes an older cached copy", async () => {
  const cache = new CommentPageCache({ maxBytes: 5 });
  let calls = 0;
  const load = async () => `v${++calls}`;
  assert.equal(await cache.get("u", load), "v1");
  assert.equal(
    await cache.get("u", async () => "123456", { fresh: true }),
    "123456"
  );
  assert.equal(await cache.get("u", load), "v2");
});
