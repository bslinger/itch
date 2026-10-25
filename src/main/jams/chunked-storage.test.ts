import { test } from "node:test";
import assert from "node:assert/strict";
import { ChunkedJamStorageBackend } from "main/jams/chunked-storage";
import { JamStorageBackend } from "main/jams/storage";

class MemoryBackend implements JamStorageBackend {
  values = new Map<string, string>();
  writes: Array<{ key: string; value: string }> = [];
  failKey: string | undefined;
  failNextChunk = false;

  async get(profileId: number, key: string) {
    return this.values.get(`${profileId}:${key}`);
  }
  async put(profileId: number, key: string, value: string) {
    this.writes.push({ key, value });
    if (this.failKey === key) {
      this.failKey = undefined;
      throw new Error("simulated Profile.Data.Put failure");
    }
    if (this.failNextChunk && key.includes("/chunk/")) {
      this.failNextChunk = false;
      throw new Error("simulated chunk write failure");
    }
    this.values.set(`${profileId}:${key}`, value);
  }
}

const profileId = 42;
const key = "@itch/jams/v2/index";
const wireBytes = (key: string, value: string) =>
  Buffer.byteLength(JSON.stringify({ profileId, key, value }), "utf8");

test("chunks a 10k-entry Unicode index within serialized RPC byte limit", async () => {
  const raw = JSON.stringify({
    version: 2,
    workspaces: Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `jam-${index}`,
        {
          id: `jam-${index}`,
          url: `https://itch.io/jam/${index}`,
          title: `作品 "${index}״ \\ 🎮`,
          entries: Array.from({ length: 4 }, (__, n) => ({
            submissionId: `${index}-${n}`,
            title: '雪だるま 👩‍🚀\\"',
          })),
        },
      ])
    ),
  });
  const base = new MemoryBackend();
  const storage = new ChunkedJamStorageBackend(base);
  await storage.put(profileId, key, raw);
  assert.ok(base.writes.length > 1);
  assert.ok(
    base.writes.every(
      ({ key: writeKey, value }) => wireBytes(writeKey, value) <= 32 * 1024
    )
  );
  assert.equal(await storage.get(profileId, key), raw);
});

test("a failed update leaves the old manifest readable", async () => {
  const base = new MemoryBackend();
  const storage = new ChunkedJamStorageBackend(base);
  const oldValue = 'old data 🎮 \\"'.repeat(5_000);
  const nextValue = 'new data 雪 \\"'.repeat(5_000);
  await storage.put(profileId, key, oldValue);
  base.failKey = key;
  await assert.rejects(
    storage.put(profileId, key, nextValue),
    /simulated Profile.Data.Put failure/
  );
  assert.equal(await storage.get(profileId, key), oldValue);
});

test("a failed chunk write leaves the old manifest readable", async () => {
  const base = new MemoryBackend();
  const storage = new ChunkedJamStorageBackend(base);
  const oldValue = 'old data 🎮 \\"'.repeat(5_000);
  const nextValue = 'new data 雪 \\"'.repeat(5_000);
  await storage.put(profileId, key, oldValue);
  base.failNextChunk = true;
  await assert.rejects(
    storage.put(profileId, key, nextValue),
    /simulated chunk write failure/
  );
  assert.equal(await storage.get(profileId, key), oldValue);
});

test("keeps chunked profile values isolated", async () => {
  const base = new MemoryBackend();
  const storage = new ChunkedJamStorageBackend(base);
  const first = "first profile 🎮".repeat(5_000);
  const second = "second profile 雪".repeat(5_000);
  await storage.put(profileId, key, first);
  await storage.put(profileId + 1, key, second);
  assert.equal(await storage.get(profileId, key), first);
  assert.equal(await storage.get(profileId + 1, key), second);
});

test("escapes lone UTF-16 surrogates when measuring serialized RPC bytes", async () => {
  const base = new MemoryBackend();
  const storage = new ChunkedJamStorageBackend(base);
  const value = "\ud800".repeat(20_000);
  await storage.put(profileId, key, value);
  assert.ok(
    base.writes.every(
      ({ key: writeKey, value: chunk }) =>
        wireBytes(writeKey, chunk) <= 32 * 1024
    )
  );
  assert.equal(await storage.get(profileId, key), value);
});

test("reads an existing direct value and rejects missing, corrupt, or truncated chunks", async () => {
  const base = new MemoryBackend();
  const storage = new ChunkedJamStorageBackend(base);
  base.values.set(
    `${profileId}:${key}`,
    JSON.stringify({ version: 2, workspaces: {} })
  );
  assert.equal(
    await storage.get(profileId, key),
    JSON.stringify({ version: 2, workspaces: {} })
  );

  const value = "chunk me 🎮".repeat(5_000);
  await storage.put(profileId, key, value);
  const manifest = JSON.parse(base.values.get(`${profileId}:${key}`)!);
  const firstChunkKey = `${key}/chunk/${manifest.sha256}/0`;
  const savedChunk = base.values.get(`${profileId}:${firstChunkKey}`)!;
  base.values.delete(`${profileId}:${firstChunkKey}`);
  await assert.rejects(storage.get(profileId, key), /missing chunk/);
  base.values.set(`${profileId}:${firstChunkKey}`, `${savedChunk}x`);
  await assert.rejects(storage.get(profileId, key), /size|content hash/);
  base.values.set(
    `${profileId}:${key}`,
    JSON.stringify({ ...manifest, chunkCount: 0 })
  );
  await assert.rejects(
    storage.get(profileId, key),
    /Invalid profile data manifest/
  );
});
