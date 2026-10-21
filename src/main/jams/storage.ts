import { JamInstallOwnership } from "common/jams/model";
import { JamEntryProgress, JamSession, JamsState } from "common/jams/state";

const INDEX_KEY = "@itch/jams/v2/index";
const LEGACY_KEY = "@itch/jams/v1";
const SHARD_COUNT = 128;
const READ_BATCH_SIZE = 16;

export interface JamStorageBackend {
  get(profileId: number, key: string): Promise<string | undefined>;
  put(profileId: number, key: string, value: string): Promise<void>;
}

type StaticJam = Pick<
  JamSession,
  "id" | "url" | "title" | "entries" | "importedAt"
>;
type Shard<T> = Record<string, T>;

interface V2Index {
  version: 2;
  workspaces: Record<string, StaticJam>;
}

interface V1Snapshot {
  version: 1;
  workspaces: Record<string, JamSession>;
  installs: Record<string, JamInstallOwnership>;
}

interface ProfileCache {
  index: V2Index;
  progress: Map<string, JamEntryProgress>;
  installs: Map<string, JamInstallOwnership>;
  progressShards: Map<number, Shard<JamEntryProgress>>;
  installShards: Map<number, Shard<JamInstallOwnership>>;
  migrationPending: boolean;
}

/** Stores static jam data separately from small, independently updated shards. */
export class JamStorage {
  private readonly caches = new Map<number, ProfileCache>();
  private readonly writes = new Map<number, Promise<void>>();

  constructor(private readonly backend: JamStorageBackend) {}

  /** Returns the v1 shape expected by restoreJamState. */
  async load(profileId: number): Promise<string | undefined> {
    const indexRaw = await this.backend.get(profileId, INDEX_KEY);
    if (indexRaw === undefined) {
      const legacy = await this.backend.get(profileId, LEGACY_KEY);
      if (legacy === undefined) {
        this.caches.set(profileId, emptyCache());
        return undefined;
      }
      this.cacheLegacy(profileId, legacy);
      return legacy;
    }

    const index = parseIndex(indexRaw);
    const progressResults = await readAllShards(
      this.backend,
      profileId,
      "progress"
    );
    const installResults = await readAllShards(
      this.backend,
      profileId,
      "installs"
    );
    const progressShards = parseShards<JamEntryProgress>(
      progressResults,
      "progress"
    );
    const installShards = parseShards<JamInstallOwnership>(
      installResults,
      "install ownership"
    );
    const progress = flattenProgress(progressShards);
    const installs = flattenShards<JamInstallOwnership>(installShards);
    const workspaces = Object.fromEntries(
      Object.entries(index.workspaces).map(([jamId, jam]) => [
        jamId,
        { ...jam, progress: progressForJam(progress, jamId) },
      ])
    );
    const snapshot: V1Snapshot = { version: 1, workspaces, installs };
    this.caches.set(profileId, {
      index,
      progress,
      installs: new Map(Object.entries(installs)),
      progressShards,
      installShards,
      migrationPending: false,
    });
    return JSON.stringify(snapshot);
  }

  /** Writes only changed shards; ownership lands before progress and index. */
  async saveState(profileId: number, state: JamsState): Promise<void> {
    const previousWrite = this.writes.get(profileId) ?? Promise.resolve();
    const write = previousWrite
      .catch(() => {})
      .then(() => this.saveStateSerial(profileId, state));
    this.writes.set(profileId, write);
    try {
      await write;
    } finally {
      if (this.writes.get(profileId) === write) this.writes.delete(profileId);
    }
  }

  private async saveStateSerial(profileId: number, state: JamsState) {
    let previous = this.caches.get(profileId);
    if (!previous) {
      await this.load(profileId);
      previous = this.caches.get(profileId)!;
    }

    const next = cacheFromState(state, previous.migrationPending);
    const progressChanges = changedKeys(previous.progress, next.progress);
    const installChanges = changedKeys(previous.installs, next.installs);
    if (previous.migrationPending) {
      for (const bucket of next.progressShards.keys())
        progressChanges.add(`*${bucket}`);
      for (const bucket of next.installShards.keys())
        installChanges.add(`*${bucket}`);
    }

    const changedInstallShards = updateShards(
      previous.installShards,
      next.installs,
      installChanges,
      (id) => shardForInstall(id)
    );
    const changedProgressShards = updateShards(
      previous.progressShards,
      next.progress,
      progressChanges,
      (key) => shardForProgress(key)
    );
    const nextInstallShards = mergeShards(
      previous.installShards,
      changedInstallShards
    );
    const nextProgressShards = mergeShards(
      previous.progressShards,
      changedProgressShards
    );

    // Persist provenance first so a progress update cannot refer to an owner
    // record that failed to reach the profile store.
    await writeShards(
      this.backend,
      profileId,
      "installs",
      changedInstallShards
    );
    await writeShards(
      this.backend,
      profileId,
      "progress",
      changedProgressShards
    );

    const indexChanged = !sameStaticIndex(previous.index, next.index);
    if (indexChanged || previous.migrationPending) {
      await this.backend.put(profileId, INDEX_KEY, JSON.stringify(next.index));
    }

    // Publish the new references only after every write succeeds. If any put
    // fails, retrying compares against the old cache and safely repeats writes.
    this.caches.set(profileId, {
      ...next,
      progressShards: nextProgressShards,
      installShards: nextInstallShards,
      migrationPending: false,
    });
  }

  private cacheLegacy(profileId: number, raw: string) {
    try {
      const data = JSON.parse(raw) as Partial<V1Snapshot>;
      if (data.version !== 1 || !data.workspaces || !data.installs) {
        this.caches.set(profileId, emptyCache());
        return;
      }
      const state: JamsState = {
        ready: true,
        workspaces: data.workspaces,
        installs: data.installs,
      };
      const cache = cacheFromState(state, true);
      cache.migrationPending = true;
      this.caches.set(profileId, cache);
    } catch {
      // Preserve corrupt/unknown legacy data for the controller to report.
      this.caches.set(profileId, emptyCache());
    }
  }
}

function emptyCache(): ProfileCache {
  return {
    index: { version: 2, workspaces: {} },
    progress: new Map(),
    installs: new Map(),
    progressShards: new Map(),
    installShards: new Map(),
    migrationPending: false,
  };
}

function cacheFromState(
  state: JamsState,
  migrationPending: boolean
): ProfileCache {
  const workspaces: Record<string, StaticJam> = {};
  const progress = new Map<string, JamEntryProgress>();
  for (const [jamId, jam] of Object.entries(state.workspaces)) {
    workspaces[jamId] = {
      id: jam.id,
      url: jam.url,
      title: jam.title,
      entries: jam.entries,
      importedAt: jam.importedAt,
    };
    for (const [submissionId, value] of Object.entries(jam.progress ?? {})) {
      progress.set(progressKey(jamId, submissionId), value);
    }
  }
  const installs = new Map(Object.entries(state.installs));
  return {
    index: { version: 2, workspaces },
    progress,
    installs,
    progressShards: makeShards(progress, shardForProgress),
    installShards: makeShards(installs, shardForInstall),
    migrationPending,
  };
}

function parseIndex(raw: string): V2Index {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Stored jam index is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.workspaces)) {
    throw new Error("Stored jam index has an unsupported format.");
  }
  return value as unknown as V2Index;
}

async function readAllShards(
  backend: JamStorageBackend,
  profileId: number,
  kind: "progress" | "installs"
): Promise<Array<string | undefined>> {
  const values: Array<string | undefined> = [];
  for (let start = 0; start < SHARD_COUNT; start += READ_BATCH_SIZE) {
    const batch = Array.from(
      { length: Math.min(READ_BATCH_SIZE, SHARD_COUNT - start) },
      (_, offset) => start + offset
    );
    values.push(
      ...(await Promise.all(
        batch.map((bucket) => backend.get(profileId, shardKey(kind, bucket)))
      ))
    );
  }
  return values;
}

function parseShards<T>(
  values: Array<string | undefined>,
  label: string
): Map<number, Shard<T>> {
  const shards = new Map<number, Shard<T>>();
  values.forEach((raw, bucket) => {
    if (raw === undefined) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Stored jam ${label} shard ${bucket} is not valid JSON.`);
    }
    if (!isRecord(value)) {
      throw new Error(
        `Stored jam ${label} shard ${bucket} has an invalid shape.`
      );
    }
    shards.set(bucket, value as Shard<T>);
  });
  return shards;
}

function flattenProgress(
  shards: Map<number, Shard<JamEntryProgress>>
): Map<string, JamEntryProgress> {
  const values = new Map<string, JamEntryProgress>();
  for (const shard of shards.values()) {
    for (const [key, value] of Object.entries(shard)) values.set(key, value);
  }
  return values;
}

function flattenShards<T>(shards: Map<number, Shard<T>>): Record<string, T> {
  const values: Record<string, T> = {};
  for (const shard of shards.values()) Object.assign(values, shard);
  return values;
}

function progressForJam(
  progress: Map<string, JamEntryProgress>,
  jamId: string
): Record<string, JamEntryProgress> {
  const values: Record<string, JamEntryProgress> = {};
  for (const [key, value] of progress) {
    const [keyJamId, submissionId] = splitProgressKey(key);
    if (keyJamId === jamId) values[submissionId] = value;
  }
  return values;
}

function changedKeys<T>(
  previous: Map<string, T>,
  next: Map<string, T>
): Set<string> {
  const changed = new Set<string>();
  for (const [key, value] of next) {
    if (previous.get(key) !== value) changed.add(key);
  }
  for (const key of previous.keys()) {
    if (!next.has(key)) changed.add(key);
  }
  return changed;
}

function updateShards<T>(
  previous: Map<number, Shard<T>>,
  next: Map<string, T>,
  changed: Set<string>,
  bucketForId: (id: string) => number
): Map<number, Shard<T>> {
  const result = new Map<number, Shard<T>>();
  const buckets = new Set<number>();
  for (const id of changed) {
    if (id.startsWith("*")) buckets.add(Number(id.slice(1)));
    else buckets.add(bucketForId(id));
  }
  for (const bucket of buckets) {
    const shard: Shard<T> = { ...(previous.get(bucket) ?? {}) };
    const forceBucket = changed.has(`*${bucket}`);
    for (const [id, value] of next) {
      if (bucketForId(id) === bucket && (forceBucket || changed.has(id))) {
        shard[id] = value;
      }
    }
    for (const id of Object.keys(shard)) {
      if (
        bucketForId(id) === bucket &&
        ((forceBucket && !next.has(id)) || (changed.has(id) && !next.has(id)))
      ) {
        delete shard[id];
      }
    }
    result.set(bucket, shard);
  }
  return result;
}

function mergeShards<T>(
  previous: Map<number, Shard<T>>,
  changed: Map<number, Shard<T>>
): Map<number, Shard<T>> {
  const next = new Map(previous);
  for (const [bucket, shard] of changed) {
    if (Object.keys(shard).length) next.set(bucket, shard);
    else next.delete(bucket);
  }
  return next;
}

async function writeShards<T>(
  backend: JamStorageBackend,
  profileId: number,
  kind: "progress" | "installs",
  shards: Map<number, Shard<T>>
) {
  for (const [bucket, value] of shards) {
    await backend.put(profileId, shardKey(kind, bucket), JSON.stringify(value));
  }
}

function makeShards<T>(
  values: Map<string, T>,
  bucketForId: (id: string) => number
): Map<number, Shard<T>> {
  const shards = new Map<number, Shard<T>>();
  for (const [key, value] of values) {
    const bucket = bucketForId(key);
    const shard = shards.get(bucket) ?? {};
    shard[key] = value;
    shards.set(bucket, shard);
  }
  return shards;
}

function sameStaticIndex(a: V2Index, b: V2Index): boolean {
  const aIds = Object.keys(a.workspaces);
  const bIds = Object.keys(b.workspaces);
  if (aIds.length !== bIds.length) return false;
  for (const jamId of aIds) {
    const left = a.workspaces[jamId];
    const right = b.workspaces[jamId];
    if (
      !right ||
      left.id !== right.id ||
      left.url !== right.url ||
      left.title !== right.title ||
      left.importedAt !== right.importedAt ||
      left.entries !== right.entries
    )
      return false;
  }
  return true;
}

function progressKey(jamId: string, submissionId: string): string {
  return `${jamId}\u0000${submissionId}`;
}

function splitProgressKey(key: string): [string, string] {
  const delimiter = key.indexOf("\u0000");
  return [key.slice(0, delimiter), key.slice(delimiter + 1)];
}

function shardForProgress(key: string): number {
  return hash(key);
}

function shardForInstall(caveId: string): number {
  return hash(caveId);
}

function hash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % SHARD_COUNT;
}

function shardKey(kind: "progress" | "installs", bucket: number): string {
  return `@itch/jams/v2/${kind}/${String(bucket).padStart(3, "0")}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
