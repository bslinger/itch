import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Cave,
  Download,
  DownloadReason,
  Game,
  GameClassification,
  GameType,
  Upload,
  UploadStorage,
  UploadType,
} from "common/butlerd/messages";
import { actions } from "common/actions";
import { JamWorkspace } from "common/jams/model";
import { emptyJamsState, JamsState } from "common/jams/state";
import jamsReducer from "common/reducers/jams";
import { RootState, Store } from "common/types";
import {
  JamController,
  JamServices,
  restoreJamState,
} from "main/jams/controller";

const PROFILE_ID = 7;
const JAM_ID = "test-jam";

function game(id: number, type = GameType.Default): Game {
  return {
    id,
    url: `https://maker.itch.io/game-${id}`,
    title: `Game ${id}`,
    type,
    classification: GameClassification.Game,
    platforms: {},
    userId: 1,
  };
}

function upload(id: number, type = UploadType.Default): Upload {
  return {
    id,
    storage: UploadStorage.Hosted,
    filename: `game-${id}.zip`,
    displayName: `Build ${id}`,
    size: 100,
    channelName: "",
    type,
    preorder: false,
    demo: false,
    platforms: {},
  };
}

function entry(
  submissionId: number,
  gameId = submissionId
): JamWorkspace["entries"][number] {
  return {
    submissionId: String(submissionId),
    submissionUrl: `https://itch.io/jam/${JAM_ID}/rate/${submissionId}`,
    gameId,
    title: `Game ${gameId}`,
    gameUrl: `https://maker.itch.io/game-${gameId}`,
  };
}

function cave(gameValue: Game, uploadValue: Upload, caveId: string): Cave {
  return {
    id: caveId,
    game: gameValue,
    upload: uploadValue,
    stats: { installedAt: "2026-01-01T00:00:00Z", secondsRun: 0 },
    installInfo: {
      installedSize: 100,
      installLocation: "Default",
      installFolder: `/${caveId}`,
    },
  };
}

function workspace(
  entries: JamWorkspace["entries"]
): JamsState["workspaces"][string] {
  return {
    id: JAM_ID,
    url: `https://itch.io/jam/${JAM_ID}`,
    title: "Test Jam",
    entries,
    progress: Object.fromEntries(
      entries.map((e) => [e.submissionId, { status: "new" as const }])
    ),
    importedAt: 1,
  };
}

interface HarnessOptions {
  entries?: JamWorkspace["entries"];
  uploads?: Record<number, Upload[]>;
  caves?: Cave[];
  gameTypes?: Record<number, GameType>;
  failUninstall?: boolean;
  beforeGame?: (gameId: number, saves: string[]) => void;
  queueGate?: Promise<void>;
  onQueueStart?: () => void;
  initialDownloads?: Download[];
  uninstallGate?: Promise<void>;
  onUninstallStart?: () => void;
  caveProvider?: (gameId: number, call: number, caves: Cave[]) => Cave[];
  onLoad?: (profileId: number) => string | undefined;
  ratedGames?: JamServices["ratedGames"];
  commentCount?: JamServices["commentCount"];
}

function harness(options: HarnessOptions = {}) {
  const entries = options.entries ?? [entry(101)];
  let rootState = {
    profile: { profile: { id: PROFILE_ID } },
    preferences: { defaultInstallLocation: "default-location" },
    tasks: { tasksByGameId: {} },
    jams: {
      ...emptyJamsState(),
      profileId: PROFILE_ID,
      ready: true,
      workspaces: { [JAM_ID]: workspace(entries) },
    },
  } as unknown as RootState;
  const dispatched: any[] = [];
  const store = {
    getState: () => rootState,
    dispatch: (action: any) => {
      dispatched.push(action);
      rootState = {
        ...rootState,
        jams: jamsReducer(rootState.jams, action),
      };
      return action;
    },
  } as unknown as Store;

  const uploadMap = options.uploads ?? {};
  const caveMap = new Map((options.caves ?? []).map((c) => [c.id, c]));
  const caveCalls: Record<number, number> = {};
  const loadedProfiles: number[] = [];
  const pending: Download[] = [...(options.initialDownloads ?? [])];
  const queued: Array<{ game: Game; upload: Upload }> = [];
  const retried: string[] = [];
  const uninstalled: string[] = [];
  const discarded: string[] = [];
  const saves: string[] = [];
  let activeSaves = 0;
  let maxActiveSaves = 0;
  let nextCaveId = 1;
  let nextDownloadId = 1;

  const api: JamServices = {
    load: async (profileId) => {
      loadedProfiles.push(profileId);
      return options.onLoad?.(profileId);
    },
    save: async (_profileId, value) => {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      await Promise.resolve();
      saves.push(value);
      activeSaves -= 1;
    },
    importJam: async (url) => ({
      id: url.split("/").pop()!,
      url,
      title: url,
      entries: [],
    }),
    ...(options.ratedGames ? { ratedGames: options.ratedGames } : {}),
    ...(options.commentCount ? { commentCount: options.commentCount } : {}),
    game: async (id) => {
      options.beforeGame?.(id, saves);
      return game(id, options.gameTypes?.[id]);
    },
    uploads: async (id) => uploadMap[id] ?? [upload(id * 10)],
    caves: async (id) => {
      const found = [...caveMap.values()].filter((c) => c.game.id === id);
      const call = (caveCalls[id] ?? 0) + 1;
      caveCalls[id] = call;
      return options.caveProvider?.(id, call, found) ?? found;
    },
    downloads: async () => [...pending],
    queue: async (gameValue, uploadValue) => {
      queued.push({ game: gameValue, upload: uploadValue });
      options.onQueueStart?.();
      const caveId = `new-cave-${nextCaveId++}`;
      const id = `download-${nextDownloadId++}`;
      pending.push({
        id,
        reason: DownloadReason.Install,
        position: pending.length,
        caveId,
        game: gameValue,
        upload: uploadValue,
        startedAt: "2026-01-01T00:00:00Z",
        stagingFolder: `/staging/${id}`,
      });
      const result = {
        id,
        reason: DownloadReason.Install,
        caveId,
        game: gameValue,
        upload: uploadValue,
        installFolder: `/${caveId}`,
        stagingFolder: `/staging/${id}`,
        installLocationId: "default-location",
      };
      if (options.queueGate) await options.queueGate;
      return result;
    },
    discard: async (downloadId) => {
      discarded.push(downloadId);
    },
    retry: async (downloadId) => {
      retried.push(downloadId);
      const download = pending.find((d) => d.id === downloadId);
      if (download) {
        download.error = undefined;
        download.errorMessage = undefined;
        download.finishedAt = undefined;
      }
    },
    uninstall: async (caveId) => {
      options.onUninstallStart?.();
      if (options.uninstallGate) await options.uninstallGate;
      if (options.failUninstall) throw new Error("uninstall failed");
      uninstalled.push(caveId);
      caveMap.delete(caveId);
    },
  };
  const controller = new JamController(store, api);
  return {
    controller,
    state: () => rootState,
    setProfile: (id: number | undefined) => {
      rootState = {
        ...rootState,
        profile: { profile: id ? { id } : null },
      } as RootState;
    },
    setJams: (jams: JamsState) => {
      rootState = { ...rootState, jams } as RootState;
    },
    queued,
    retried,
    uninstalled,
    discarded,
    pending,
    saves,
    loadedProfiles,
    dispatched,
    get maxActiveSaves() {
      return maxActiveSaves;
    },
  };
}

test("repeated downloads queue a new install only once and persist ownership before advancing", async () => {
  const entries = [entry(101), entry(102)];
  let harnessRef: ReturnType<typeof harness>;
  harnessRef = harness({
    entries,
    beforeGame: (gameId, saves) => {
      if (gameId === 102) {
        const snapshots = saves.map((save) => JSON.parse(save));
        assert.ok(
          snapshots.some((s) => s.installs["new-cave-1"]?.createdByJam)
        );
      }
    },
  });
  await harnessRef.controller.download(JAM_ID);
  await harnessRef.controller.download(JAM_ID, "101");

  assert.equal(
    harnessRef.queued.length,
    2,
    "one install per entry, no repeat queue"
  );
  assert.equal(harnessRef.queued[0].upload.id, 1010);
  assert.equal(harnessRef.queued[1].upload.id, 1020);
  assert.equal(
    harnessRef.state().jams.installs["new-cave-1"].createdByJam,
    true
  );
  assert.equal(
    harnessRef.state().jams.workspaces[JAM_ID].progress["101"].status,
    "queued"
  );
  assert.equal(harnessRef.maxActiveSaves, 1);
});

test("an existing native cave is preserved and never queued as jam-created", async () => {
  const g = game(101);
  const native = upload(11);
  const existing = cave(g, native, "existing-native");
  const h = harness({ uploads: { 101: [native] }, caves: [existing] });

  await h.controller.download(JAM_ID);

  assert.equal(h.queued.length, 0);
  assert.deepEqual(h.state().jams.installs[existing.id], {
    caveId: existing.id,
    gameId: 101,
    uploadId: native.id,
    jamIds: [JAM_ID],
    createdByJam: false,
    preexisting: true,
    kept: false,
  });
  assert.equal(
    h.state().jams.workspaces[JAM_ID].progress["101"].status,
    "ready"
  );
});

test("retrying an errored download retries it without queueing a duplicate", async () => {
  const g = game(101);
  const native = upload(11);
  const errored: Download = {
    id: "failed-download",
    error: "network",
    errorMessage: "Connection lost",
    reason: DownloadReason.Install,
    position: 0,
    caveId: "pending-cave",
    game: g,
    upload: native,
    startedAt: "2026-01-01T00:00:00Z",
    stagingFolder: "/staging/failed-download",
  };
  const h = harness({
    uploads: { 101: [native] },
    initialDownloads: [errored],
  });

  await h.controller.download(JAM_ID);

  assert.deepEqual(h.retried, [errored.id]);
  assert.equal(h.queued.length, 0);
  assert.equal(h.state().jams.installs[errored.caveId].preexisting, true);
  assert.equal(
    h.state().jams.workspaces[JAM_ID].progress["101"].status,
    "queued"
  );
});

test("native upload is preferred over an installed HTML cave", async () => {
  const g = game(101);
  const html = upload(10, UploadType.HTML);
  const native = upload(11, UploadType.Default);
  const oldHtml = cave(g, html, "existing-html");
  const h = harness({ uploads: { 101: [html, native] }, caves: [oldHtml] });

  await h.controller.download(JAM_ID);

  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].upload.id, native.id);
  assert.equal(h.state().jams.installs["new-cave-1"].createdByJam, true);
});

test("ambiguous native candidates require a manual selection", async () => {
  const options = [upload(11), upload(12)];
  const h = harness({ uploads: { 101: options } });

  await h.controller.download(JAM_ID);
  let progress = h.state().jams.workspaces[JAM_ID].progress["101"];
  assert.equal(progress.status, "attention");
  assert.deepEqual(
    progress.candidates?.map((u) => u.id),
    [11, 12]
  );
  assert.equal(h.queued.length, 0);

  await h.controller.download(JAM_ID, "101", 12);
  progress = h.state().jams.workspaces[JAM_ID].progress["101"];
  assert.equal(h.queued[0].upload.id, 12);
  assert.equal(progress.status, "queued");
});

test("an HTML page with no accessible HTML upload falls back to web without purchase", async () => {
  const h = harness({
    gameTypes: { 101: GameType.HTML },
    uploads: { 101: [] },
  });

  await h.controller.download(JAM_ID);

  assert.equal(h.queued.length, 0);
  assert.equal(h.state().jams.workspaces[JAM_ID].progress["101"].status, "web");
  assert.equal(h.state().jams.installs["new-cave-1"], undefined);
});

test("remove deletes only exclusive jam-created installs and releases shared or preexisting ownership", async () => {
  const entries = [entry(101), entry(102), entry(103), entry(104)];
  const jam = workspace(entries);
  const installs = {
    "created-cave": {
      caveId: "created-cave",
      gameId: 101,
      uploadId: 1010,
      jamIds: [JAM_ID],
      createdByJam: true,
      preexisting: false,
      kept: false,
    },
    "shared-cave": {
      caveId: "shared-cave",
      gameId: 102,
      uploadId: 1020,
      jamIds: [JAM_ID, "other-jam"],
      createdByJam: true,
      preexisting: false,
      kept: false,
    },
    "old-cave": {
      caveId: "old-cave",
      gameId: 103,
      uploadId: 1030,
      jamIds: [JAM_ID],
      createdByJam: false,
      preexisting: true,
      kept: false,
    },
    "kept-cave": {
      caveId: "kept-cave",
      gameId: 104,
      uploadId: 1040,
      jamIds: [JAM_ID],
      createdByJam: true,
      preexisting: false,
      kept: true,
    },
  };
  for (const [i, e] of entries.entries()) {
    jam.progress[e.submissionId] = {
      status: "ready",
      caveId: Object.keys(installs)[i],
      kept: i === 3,
    };
  }
  const caves = Object.values(installs).map((r) =>
    cave(game(r.gameId), upload(r.uploadId), r.caveId)
  );
  const h = harness({ entries, caves });
  h.setJams({ ...h.state().jams, workspaces: { [JAM_ID]: jam }, installs });

  await h.controller.remove(JAM_ID);

  assert.deepEqual(h.uninstalled, ["created-cave"]);
  assert.equal(h.state().jams.installs["created-cave"], undefined);
  assert.deepEqual(h.state().jams.installs["shared-cave"].jamIds, [
    "other-jam",
  ]);
  assert.equal(h.state().jams.installs["old-cave"], undefined);
  assert.ok(h.state().jams.installs["kept-cave"]);
});

test("failed uninstall retains ownership and records an actionable error", async () => {
  const e = entry(101);
  const record = {
    caveId: "created-cave",
    gameId: 101,
    uploadId: 1010,
    jamIds: [JAM_ID],
    createdByJam: true,
    preexisting: false,
    kept: false,
  };
  const jam = workspace([e]);
  jam.progress[e.submissionId] = { status: "ready", caveId: record.caveId };
  const h = harness({
    entries: [e],
    caves: [cave(game(101), upload(1010), record.caveId)],
    failUninstall: true,
  });
  h.setJams({
    ...h.state().jams,
    workspaces: { [JAM_ID]: jam },
    installs: { [record.caveId]: record },
  });

  await h.controller.remove(JAM_ID);

  assert.deepEqual(h.state().jams.installs[record.caveId], record);
  assert.match(
    h.state().jams.workspaces[JAM_ID].progress[e.submissionId].message ?? "",
    /uninstall failed/
  );
  assert.equal(
    h.state().jams.workspaces[JAM_ID].progress[e.submissionId].status,
    "ready"
  );
});

test("cancelling while uninstall is in flight still records the completed uninstall", async () => {
  let releaseUninstall!: () => void;
  let uninstallStarted!: () => void;
  const uninstallGate = new Promise<void>((resolve) => {
    releaseUninstall = resolve;
  });
  const started = new Promise<void>((resolve) => {
    uninstallStarted = resolve;
  });
  const e = entry(101);
  const record = {
    caveId: "created-cave",
    gameId: 101,
    uploadId: 1010,
    jamIds: [JAM_ID],
    createdByJam: true,
    preexisting: false,
    kept: false,
  };
  const jam = workspace([e]);
  jam.progress[e.submissionId] = { status: "ready", caveId: record.caveId };
  const h = harness({
    entries: [e],
    caves: [cave(game(101), upload(1010), record.caveId)],
    uninstallGate,
    onUninstallStart: uninstallStarted,
  });
  h.setJams({
    ...h.state().jams,
    workspaces: { [JAM_ID]: jam },
    installs: { [record.caveId]: record },
  });

  const removal = h.controller.remove(JAM_ID);
  await started;
  h.controller.cancel();
  releaseUninstall();
  await removal;

  assert.deepEqual(h.uninstalled, [record.caveId]);
  assert.equal(h.state().jams.installs[record.caveId], undefined);
  assert.equal(
    h.state().jams.workspaces[JAM_ID].progress[e.submissionId].status,
    "removed"
  );
});

test("reconcile marks a ready row for attention when its cave is gone", async () => {
  const e = entry(101);
  const jam = workspace([e]);
  jam.progress[e.submissionId] = {
    status: "ready",
    caveId: "missing-cave",
    uploadId: 1010,
  };
  const h = harness({ entries: [e], caves: [] });
  h.setJams({
    ...h.state().jams,
    workspaces: { [JAM_ID]: jam },
  });

  await h.controller.reconcile();

  assert.equal(
    h.state().jams.workspaces[JAM_ID].progress[e.submissionId].status,
    "attention"
  );
  assert.match(
    h.state().jams.workspaces[JAM_ID].progress[e.submissionId].message ?? "",
    /missing or incomplete/
  );
});

test("a queue result arriving after logout is never attached to the next profile", async () => {
  let releaseQueue!: () => void;
  let queueStarted!: () => void;
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const started = new Promise<void>((resolve) => {
    queueStarted = resolve;
  });
  const h = harness({
    uploads: { 101: [upload(1010)] },
    queueGate,
    onQueueStart: queueStarted,
  });
  const operation = h.controller.download(JAM_ID);
  await started;
  h.setProfile(undefined);
  h.setJams({ ...emptyJamsState(), ready: false });
  releaseQueue();
  await operation;

  assert.deepEqual(h.state().jams.workspaces, {});
  assert.deepEqual(h.state().jams.installs, {});
  assert.ok(h.saves.length >= 1);
  assert.ok(
    JSON.parse(h.saves[h.saves.length - 1]).installs["new-cave-1"]?.createdByJam
  );
});

test("a queue finishing after switching profiles loads clean state for the new profile", async () => {
  let releaseQueue!: () => void;
  let queueStarted!: () => void;
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const started = new Promise<void>((resolve) => {
    queueStarted = resolve;
  });
  const h = harness({
    uploads: { 101: [upload(1010)] },
    queueGate,
    onQueueStart: queueStarted,
  });
  const operation = h.controller.download(JAM_ID);
  await started;
  h.setProfile(8);
  h.setJams(emptyJamsState());
  releaseQueue();
  await operation;

  assert.deepEqual(h.loadedProfiles, [8]);
  assert.equal(h.state().jams.profileId, 8);
  assert.equal(h.state().jams.ready, true);
  assert.deepEqual(h.state().jams.workspaces, {});
  assert.ok(
    JSON.parse(h.saves[h.saves.length - 1]).installs["new-cave-1"]?.createdByJam
  );
});

test("the keep choice made before a slow queue returns is inherited by its install", async () => {
  let releaseQueue!: () => void;
  let queueStarted!: () => void;
  const queueGate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const started = new Promise<void>((resolve) => {
    queueStarted = resolve;
  });
  const h = harness({
    uploads: { 101: [upload(1010)] },
    queueGate,
    onQueueStart: queueStarted,
  });
  h.state().jams.workspaces[JAM_ID].progress["101"].kept = true;
  const operation = h.controller.download(JAM_ID);
  await started;
  releaseQueue();
  await operation;

  assert.equal(h.state().jams.installs["new-cave-1"].kept, true);
  assert.equal(h.state().jams.workspaces[JAM_ID].progress["101"].kept, true);
});

test("a cave whose upload changed before uninstall is preserved", async () => {
  const e = entry(101);
  const original = upload(1010);
  const changed = upload(2020);
  const originalCave = cave(game(101), original, "changed-cave");
  const jam = workspace([e]);
  jam.progress[e.submissionId] = {
    status: "ready",
    caveId: originalCave.id,
    uploadId: original.id,
  };
  const record = {
    caveId: originalCave.id,
    gameId: 101,
    uploadId: original.id,
    jamIds: [JAM_ID],
    createdByJam: true,
    preexisting: false,
    kept: false,
  };
  const h = harness({
    entries: [e],
    caves: [originalCave],
    caveProvider: (_gameId, call, caves) =>
      call === 1 ? caves : [cave(game(101), changed, originalCave.id)],
  });
  h.setJams({
    ...h.state().jams,
    workspaces: { [JAM_ID]: jam },
    installs: { [record.caveId]: record },
  });

  await h.controller.remove(JAM_ID);

  assert.deepEqual(h.uninstalled, []);
  assert.deepEqual(h.state().jams.installs[record.caveId], record);
  assert.equal(
    h.state().jams.workspaces[JAM_ID].progress[e.submissionId].status,
    "attention"
  );
});

test("rating sync stores only the account's confirmed rated game ids", async () => {
  const h = harness({
    entries: [entry(101), entry(102), entry(103)],
    ratedGames: async (url, profileId) => {
      assert.equal(url, `https://itch.io/jam/${JAM_ID}`);
      assert.equal(profileId, PROFILE_ID);
      return [102];
    },
  });

  await h.controller.syncRatings(JAM_ID);

  const ratings = h.state().jams.workspaces[JAM_ID].ratings;
  assert.deepEqual(ratings?.ratedGameIds, [102]);
  assert.ok((ratings?.syncedAt ?? 0) > 0);
  assert.ok(
    h.saves.some(
      (saved) =>
        JSON.parse(saved).workspaces[JAM_ID].ratings.ratedGameIds[0] === 102
    )
  );
});

test("comment sync stores explicit zeroes, limits concurrency, and reuses its TTL cache", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const h = harness({
    entries: [entry(101), entry(102), entry(103), entry(104), entry(105)],
    commentCount: async () => {
      calls += 1;
      const call = calls;
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return call === 1 ? 0 : call;
    },
  });
  const ids = ["101", "102", "103", "104", "105"];
  await h.controller.syncComments(JAM_ID, ids);
  const progress = h.state().jams.workspaces[JAM_ID].progress;
  assert.equal(progress["101"].commentCount, 0);
  assert.equal(progress["101"].commentsCheckedAt !== undefined, true);
  assert.equal(maximum <= 4, true);
  assert.equal(calls, 5);
  await h.controller.syncComments(JAM_ID, ids);
  assert.equal(calls, 5);
});

test("an authenticated empty rating list replaces the prior list successfully", async () => {
  const h = harness({
    ratedGames: async () => [],
  });

  await h.controller.syncRatings(JAM_ID);

  const ratings = h.state().jams.workspaces[JAM_ID].ratings;
  assert.deepEqual(ratings?.ratedGameIds, []);
  assert.ok((ratings?.syncedAt ?? 0) > 0);
  assert.equal(h.state().jams.workspaces[JAM_ID].ratingsError, undefined);
});

test("a failed ratings sync keeps the last snapshot and records an error", async () => {
  const h = harness({
    ratedGames: async () => {
      throw new Error("session expired");
    },
  });
  const previous = { ratedGameIds: [101], syncedAt: 123 };
  h.setJams({
    ...h.state().jams,
    workspaces: {
      [JAM_ID]: { ...h.state().jams.workspaces[JAM_ID], ratings: previous },
    },
  });

  await h.controller.syncRatings(JAM_ID);

  assert.deepEqual(h.state().jams.workspaces[JAM_ID].ratings, previous);
  assert.match(
    h.state().jams.workspaces[JAM_ID].ratingsError ?? "",
    /session expired/
  );
  assert.equal(h.state().jams.workspaces[JAM_ID].ratingsSyncing, false);
});

test("a ratings response from the previous profile cannot update the active profile", async () => {
  let finishRatings!: (ids: number[]) => void;
  const ratingsResponse = new Promise<number[]>((resolve) => {
    finishRatings = resolve;
  });
  const h = harness({ ratedGames: async () => ratingsResponse });
  const syncing = h.controller.syncRatings(JAM_ID);
  assert.equal(h.state().jams.workspaces[JAM_ID].ratingsSyncing, true);

  const otherProfileJam = {
    ...workspace([entry(101)]),
    ratings: { ratedGameIds: [101], syncedAt: 999 },
    ratingsSyncing: false,
  };
  h.setProfile(PROFILE_ID + 1);
  h.setJams({
    ...emptyJamsState(),
    profileId: PROFILE_ID + 1,
    ready: true,
    workspaces: { [JAM_ID]: otherProfileJam },
  });
  finishRatings([102]);
  await syncing;

  assert.deepEqual(h.state().jams.workspaces[JAM_ID], otherProfileJam);
});

test("reimporting a jam preserves its last ratings snapshot", async () => {
  const h = harness();
  const previous = { ratedGameIds: [101], syncedAt: 123 };
  h.setJams({
    ...h.state().jams,
    workspaces: {
      [JAM_ID]: { ...h.state().jams.workspaces[JAM_ID], ratings: previous },
    },
  });

  await h.controller.import(`https://itch.io/jam/${JAM_ID}`);

  assert.deepEqual(h.state().jams.workspaces[JAM_ID].ratings, previous);
});

test("corrupt null workspace rows are skipped while valid saved jams restore", () => {
  const validJam = {
    id: "valid-jam",
    url: "https://itch.io/jam/valid-jam",
    title: "Valid Jam",
    entries: [],
    progress: {},
    importedAt: 10,
  };

  const restored = restoreJamState(
    JSON.stringify({
      version: 1,
      workspaces: { broken: null, "valid-jam": validJam },
      installs: {},
    }),
    PROFILE_ID
  );

  assert.deepEqual(Object.keys(restored.workspaces), ["valid-jam"]);
  assert.equal(restored.workspaces["valid-jam"].title, "Valid Jam");
  assert.equal(restored.ready, true);
});
