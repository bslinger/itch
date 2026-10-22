import { createHash } from "node:crypto";
import type { JamStorageBackend } from "main/jams/storage";

const MANIFEST_FORMAT = "@itch/chunked-profile-data/v1";
const CHUNK_BYTES = 32 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const READ_CONCURRENCY = 8;
const MAX_CHUNKS = 8192;

interface Manifest {
  format: typeof MANIFEST_FORMAT;
  bytes: number;
  sha256: string;
  chunkCount: number;
}

/** Adapts profile storage so large values never become oversized RPC writes. */
export class ChunkedJamStorageBackend implements JamStorageBackend {
  constructor(private readonly backend: JamStorageBackend) {}

  async get(profileId: number, key: string): Promise<string | undefined> {
    const value = await this.backend.get(profileId, key);
    if (value === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
    if (!parsed || typeof parsed !== "object" || !("format" in parsed))
      return value;
    if ((parsed as { format?: unknown }).format !== MANIFEST_FORMAT)
      return value;
    const manifest = validateManifest(parsed);
    let totalBytes = 0;
    const keys = Array.from({ length: manifest.chunkCount }, (_, index) =>
      chunkKey(key, manifest.sha256, index)
    );
    const parts = await mapLimit(keys, READ_CONCURRENCY, async (chunkKey) => {
      const chunk = await this.backend.get(profileId, chunkKey);
      if (chunk === undefined)
        throw new Error(
          `Profile data is missing chunk ${chunkKey} for ${key}.`
        );
      if (rpcBytes(profileId, chunkKey, chunk) > CHUNK_BYTES)
        throw new Error(
          `Profile data chunk ${chunkKey} exceeds the RPC byte limit.`
        );
      totalBytes += byteLength(chunk);
      if (totalBytes > manifest.bytes)
        throw new Error(`Profile data for ${key} exceeds its declared size.`);
      return chunk;
    });
    if (totalBytes > manifest.bytes)
      throw new Error(`Profile data for ${key} exceeds its declared size.`);
    const result = parts.join("");
    if (byteLength(result) !== manifest.bytes)
      throw new Error(`Profile data for ${key} has an invalid byte length.`);
    if (sha256(result) !== manifest.sha256)
      throw new Error(`Profile data for ${key} failed its content hash check.`);
    return result;
  }

  async put(profileId: number, key: string, value: string): Promise<void> {
    const dataBytes = byteLength(value);
    if (dataBytes > MAX_DATA_BYTES)
      throw new Error(`Profile data for ${key} exceeds the 64 MiB limit.`);
    if (rpcBytes(profileId, key, value) <= CHUNK_BYTES) {
      await this.backend.put(profileId, key, value);
      return;
    }

    const hash = sha256(value);
    let chunkCount = 0;
    let offset = 0;
    while (offset < value.length) {
      if (chunkCount >= MAX_CHUNKS)
        throw new Error(`Profile data for ${key} requires too many chunks.`);
      const keyForChunk = chunkKey(key, hash, chunkCount);
      const end = largestChunkEnd(
        profileId,
        keyForChunk,
        value,
        offset,
        CHUNK_BYTES
      );
      if (end === offset)
        throw new Error(
          `Unable to fit a profile data chunk for ${key} in the RPC limit.`
        );
      const chunk = value.slice(offset, end);
      await this.backend.put(profileId, keyForChunk, chunk);
      chunkCount++;
      offset = end;
    }

    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      bytes: dataBytes,
      sha256: hash,
      chunkCount,
    };
    const serialized = JSON.stringify(manifest);
    if (rpcBytes(profileId, key, serialized) > MAX_MANIFEST_BYTES)
      throw new Error(
        `Profile data manifest for ${key} exceeds the 32 KiB limit.`
      );
    // Publish last: until this succeeds, readers continue to see the old value.
    await this.backend.put(profileId, key, serialized);
  }
}

function validateManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object")
    throw new Error("Invalid profile data manifest.");
  const m = value as Partial<Manifest>;
  if (
    m.format !== MANIFEST_FORMAT ||
    !Number.isSafeInteger(m.bytes) ||
    m.bytes! < 0 ||
    m.bytes! > MAX_DATA_BYTES ||
    typeof m.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(m.sha256) ||
    !Number.isSafeInteger(m.chunkCount) ||
    m.chunkCount! < 1 ||
    m.chunkCount! > MAX_CHUNKS
  )
    throw new Error("Invalid profile data manifest.");
  return m as Manifest;
}

function largestChunkEnd(
  profileId: number,
  key: string,
  value: string,
  start: number,
  budget: number
): number {
  let end = start;
  let escapedBytes = 2; // quotes around the JSON string
  const fixedBytes =
    byteLength(JSON.stringify({ profileId, key, value: "" })) - 2;
  while (end < value.length) {
    const point = value.codePointAt(end)!;
    const codePoint = String.fromCodePoint(point);
    const nextEscapedBytes =
      escapedBytes + jsonStringContentBytes(codePoint, point);
    if (fixedBytes + nextEscapedBytes > budget) break;
    escapedBytes = nextEscapedBytes;
    end += codePoint.length;
  }
  return end;
}

function rpcBytes(profileId: number, key: string, value: string): number {
  return byteLength(JSON.stringify({ profileId, key, value }));
}
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function chunkKey(key: string, hash: string, index: number): string {
  return `${key}/chunk/${hash}/${index}`;
}

function jsonStringContentBytes(value: string, point: number): number {
  if (
    point === 0x22 ||
    point === 0x5c ||
    point === 0x08 ||
    point === 0x09 ||
    point === 0x0a ||
    point === 0x0c ||
    point === 0x0d
  )
    return 2;
  if (point < 0x20) return 6;
  if (point >= 0xd800 && point <= 0xdfff) return 6;
  return Buffer.byteLength(value, "utf8");
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await fn(values[index]);
      }
    })
  );
  return results;
}
