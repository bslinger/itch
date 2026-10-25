import { JAM_PUBLIC_COMMENT_CACHE_TTL_MS } from "common/jams/cache-policy";

export const COMMENT_PAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const COMMENT_PAGE_CACHE_MAX_ENTRIES = 128;

export interface CommentPageCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxBytes?: number;
  maxEntries?: number;
}

interface CacheEntry {
  html: string;
  bytes: number;
  expiresAt: number;
}

/** Bounded in-memory cache for validated public jam comment pages. */
export class CommentPageCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<string>>();
  private bytes = 0;

  constructor(options: CommentPageCacheOptions = {}) {
    this.now = options.now || Date.now;
    this.ttlMs = options.ttlMs ?? JAM_PUBLIC_COMMENT_CACHE_TTL_MS;
    this.maxBytes = options.maxBytes ?? COMMENT_PAGE_CACHE_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? COMMENT_PAGE_CACHE_MAX_ENTRIES;
  }

  invalidate(url: string): void {
    this.remove(url);
  }

  get(
    url: string,
    load: () => Promise<string>,
    options: { fresh?: boolean } = {}
  ): Promise<string> {
    const pending = this.inFlight.get(url);
    if (pending) return pending;

    if (!options.fresh) {
      const cached = this.entries.get(url);
      if (cached && cached.expiresAt > this.now()) {
        // Map insertion order is the LRU order, least-recently-used first.
        this.entries.delete(url);
        this.entries.set(url, cached);
        return Promise.resolve(cached.html);
      }
      if (cached) this.remove(url);
    }

    let request: Promise<string>;
    request = Promise.resolve()
      .then(load)
      .then((html) => {
        if (typeof html !== "string")
          throw new Error("The comment page loader returned non-text data");
        const size = Buffer.byteLength(html, "utf8");
        // A successful fresh load supersedes any older cached page, even when
        // it is too large to admit into this bounded cache.
        this.remove(url);
        if (size <= this.maxBytes && this.maxBytes > 0 && this.maxEntries > 0) {
          this.evictExpired();
          while (
            this.entries.size >= this.maxEntries ||
            this.bytes + size > this.maxBytes
          ) {
            const oldest = this.entries.keys().next().value as
              | string
              | undefined;
            if (oldest === undefined) break;
            this.remove(oldest);
          }
          this.entries.set(url, {
            html,
            bytes: size,
            expiresAt: this.now() + this.ttlMs,
          });
          this.bytes += size;
        }
        return html;
      })
      .finally(() => {
        if (this.inFlight.get(url) === request) this.inFlight.delete(url);
      });
    this.inFlight.set(url, request);
    return request;
  }

  private remove(url: string) {
    const cached = this.entries.get(url);
    if (!cached) return;
    this.entries.delete(url);
    this.bytes -= cached.bytes;
  }

  private evictExpired() {
    const now = this.now();
    for (const [url, cached] of this.entries) {
      if (cached.expiresAt <= now) this.remove(url);
    }
  }
}
