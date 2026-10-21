import { test } from "node:test";
import assert from "node:assert/strict";
import { JamInstallOwnership } from "common/jams/model";
import { JamEntryProgress, JamSession, JamsState } from "common/jams/state";
import { JamStorage, JamStorageBackend } from "main/jams/storage";

const INDEX_KEY = "@itch/jams/v2/index";
const LEGACY_KEY = "@itch/jams/v1";

class MemoryBackend implements JamStorageBackend {
  values = new Map<string, string>();
  writes: Array<{ profileId: number; key: string; value: string }> = [];
  reads = 0;
  activeReads = 0;
  maxActiveReads = 0;
  failKey: string | undefined;
  failNextProgress = false;

  async get(profileId: number, key: string) {
    this.reads++;
    this.activeReads++;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    await Promise.resolve();
    this.activeReads--;
    return this.values.get(`${profileId}:${key}`);
  }

  async put(profileId: number, key: string, value: string) {
    this.writes.push({ profileId, key, value });
    if (
      this.failKey === key ||
      (this.failNextProgress && key.includes("/progress/"))
    ) {
      this.failKey = undefined;
      this.failNextProgress = false;
      throw new Error("simulated profile store failure");
    }
    this.values.set(`${profileId}:${key}`, value);
  }

  resetWrites() {
    this.writes = [];
  }
}

function entry(submissionId: string, gameId: number) {
  return {
    submissionId,
    submissionUrl: `https://itch.io/jam/${JAM_ID}/rate/${gameId}`,
    gameId,
    title: `Game ${gameId}`,
  };
}

const JAM_ID = "summer-jam";
function session(
  entries = [entry("101", 101), entry("102", 102)],
  progress: Record<string, JamEntryProgress> = {
    101: { status: "ready", caveId: "cave-a" },
    102: { status: "new" },
  },
  importedAt = 10
): JamSession {
  return {
    id: JAM_ID,
    url: `https://itch.io/jam/${JAM_ID}`,
    title: "Summer Jam",
    entries,
    progress,
    importedAt,
  };
}

function ownership(overrides: Partial<JamInstallOwnership> = {}) {
  return {
    caveId: "cave-a",
    gameId: 101,
    uploadId: 1001,
    jamIds: [JAM_ID],
    createdByJam: true,
    preexisting: false,
    kept: false,
    ...overrides,
  };
}

function state(
  jam = session(),
  installs: Record<string, JamInstallOwnership> = {
    "cave-a": ownership(),
  }
): JamsState {
  return {
    profileId: 7,
    ready: true,
    workspaces: { [JAM_ID]: jam },
    installs,
  };
}

test("updates one progress and owner shard without rewriting the manifest or other shards", async () => {
  const backend = new MemoryBackend();
  const storage = new JamStorage(backend);
  const initial = state();
  await storage.saveState(7, initial);

  backend.resetWrites();
  const nextProgress = {
    ...initial.workspaces[JAM_ID].progress,
    101: { status: "attention" as const, message: "needs review" },
  };
  const nextJam = { ...initial.workspaces[JAM_ID], progress: nextProgress };
  const nextOwnership = ownership({ kept: true });
  await storage.saveState(7, state(nextJam, { "cave-a": nextOwnership }));

  assert.equal(
    backend.writes.some((write) => write.key === INDEX_KEY),
    false
  );
  assert.equal(
    backend.writes.filter((write) => write.key.includes("/progress/")).length,
    1
  );
  assert.equal(
    backend.writes.filter((write) => write.key.includes("/installs/")).length,
    1
  );
  assert.equal(backend.writes.length, 2);
  assert.ok(backend.writes[0].key.includes("/installs/"));
});

test("round trips v1 snapshots and reads shards in batches of sixteen", async () => {
  const backend = new MemoryBackend();
  const original = state();
  const writer = new JamStorage(backend);
  await writer.saveState(7, original);

  backend.reads = 0;
  backend.maxActiveReads = 0;
  const reader = new JamStorage(backend);
  const raw = await reader.load(7);
  assert.ok(raw);
  const snapshot = JSON.parse(raw!);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(
    snapshot.workspaces[JAM_ID].entries,
    original.workspaces[JAM_ID].entries
  );
  assert.deepEqual(
    snapshot.workspaces[JAM_ID].progress,
    original.workspaces[JAM_ID].progress
  );
  assert.deepEqual(snapshot.installs, original.installs);
  assert.equal(backend.reads, 257);
  assert.ok(backend.maxActiveReads <= 16);
});

test("isolates profiles and migrates legacy data on the first save", async () => {
  const backend = new MemoryBackend();
  const original = state();
  const legacyRaw = JSON.stringify({
    version: 1,
    workspaces: original.workspaces,
    installs: original.installs,
  });
  backend.values.set(`7:${LEGACY_KEY}`, legacyRaw);
  const storage = new JamStorage(backend);
  assert.equal(await storage.load(7), legacyRaw);

  await storage.saveState(7, original);
  assert.ok(backend.values.has(`7:${INDEX_KEY}`));
  assert.ok(
    [...backend.values.keys()].some((key) =>
      key.startsWith("7:@itch/jams/v2/progress/")
    )
  );
  assert.equal(backend.values.has(`7:${LEGACY_KEY}`), true);

  const profileTwo = state(
    session([entry("201", 201)], { 201: { status: "new" } }),
    {}
  );
  await storage.saveState(8, profileTwo);
  const profileOneRaw = await storage.load(7);
  const profileTwoRaw = await storage.load(8);
  assert.equal(
    JSON.parse(profileOneRaw!).workspaces[JAM_ID].entries[0].gameId,
    101
  );
  assert.equal(
    JSON.parse(profileTwoRaw!).workspaces[JAM_ID].entries[0].gameId,
    201
  );
});

test("keeps the old cache after a partial failed write so retry persists provenance first", async () => {
  const backend = new MemoryBackend();
  const storage = new JamStorage(backend);
  const initial = state(session([], {}), {});
  await storage.saveState(7, initial);

  const updated = state(
    session([entry("101", 101)], {
      101: { status: "ready", caveId: "cave-b" },
    }),
    { "cave-b": ownership({ caveId: "cave-b", kept: true }) }
  );
  backend.resetWrites();
  backend.failNextProgress = true;
  const operation = storage.saveState(7, updated);
  await assert.rejects(operation, /simulated profile store failure/);
  assert.ok(backend.writes[0].key.includes("/installs/"));
  const failedProgressKey = backend.writes[1].key;
  backend.failKey = undefined;
  backend.resetWrites();

  await storage.saveState(7, updated);
  assert.ok(backend.writes[0].key.includes("/installs/"));
  assert.ok(backend.writes.some((write) => write.key === failedProgressKey));
  const loaded = JSON.parse((await new JamStorage(backend).load(7))!);
  assert.equal(loaded.installs["cave-b"].kept, true);
  assert.equal(loaded.workspaces[JAM_ID].progress["101"].status, "ready");
});
