export type CommentFetcher = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export interface CommentRequestPacerOptions {
  fetch?: CommentFetcher;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  minimumStartIntervalMs?: number;
  maximumInFlight?: number;
  maximumRetries?: number;
  fallbackRetryDelayMs?: number;
  onRateLimit?: (details: {
    status: number;
    retry: number;
    delayMs: number;
  }) => void;
}

export class CommentHttpError extends Error {
  constructor(readonly status: number, readonly retries: number) {
    super(`itch.io returned HTTP ${status} after ${retries} retries`);
    this.name = "CommentHttpError";
  }
}

/** Paces public jam-comment requests and coordinates Retry-After cooldowns. */
export class CommentRequestPacer {
  private readonly fetcher: CommentFetcher;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly interval: number;
  private readonly maxInFlight: number;
  private readonly maxRetries: number;
  private readonly fallbackDelay: number;
  private readonly onRateLimit?: CommentRequestPacerOptions["onRateLimit"];
  private active = 0;
  private nextStartAt = 0;
  private cooldownUntil = 0;
  private waiters: Array<() => void> = [];

  constructor(options: CommentRequestPacerOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60_000))));
    this.interval = Math.max(0, options.minimumStartIntervalMs ?? 1500);
    this.maxInFlight = Math.max(1, Math.floor(options.maximumInFlight ?? 2));
    this.maxRetries = Math.max(0, Math.floor(options.maximumRetries ?? 2));
    this.fallbackDelay = Math.max(0, options.fallbackRetryDelayMs ?? 15000);
    this.onRateLimit = options.onRateLimit;
  }

  async fetch(
    url: string,
    init?: RequestInit,
    fetcher?: CommentFetcher
  ): Promise<Response> {
    return this.schedule(() => (fetcher ?? this.fetcher)(url, init));
  }

  async schedule(request: () => Promise<Response>): Promise<Response> {
    let retries = 0;
    while (true) {
      await this.acquire();
      let response: Response;
      try {
        response = await request();
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const delay =
            parseRetryAfter(retryAfter, this.now()) ??
            this.fallbackDelay * 2 ** retries;
          // Publish cooldown before releasing the slot, so a queued request cannot slip through.
          this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + delay);
          try {
            this.onRateLimit?.({
              status: response.status,
              retry: retries + 1,
              delayMs: delay,
            });
          } catch {
            /* Diagnostics must not interfere with retry handling. */
          }
          try {
            await response.body?.cancel();
          } catch {
            /* Retry does not depend on the error body. */
          }
        }
      } finally {
        this.release();
      }
      if (response.status !== 429) return response;
      if (retries >= this.maxRetries) throw new CommentHttpError(429, retries);
      retries += 1;
    }
  }

  private async acquire() {
    while (true) {
      const now = this.now();
      const waitFor = Math.max(
        this.nextStartAt - now,
        this.cooldownUntil - now,
        0
      );
      if (waitFor > 0) {
        await this.sleep(waitFor);
        continue;
      }
      if (this.active >= this.maxInFlight) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        continue;
      }
      this.active += 1;
      this.nextStartAt = Math.max(this.nextStartAt, now) + this.interval;
      return;
    }
  }

  private release() {
    const next = this.waiters.shift();
    this.active -= 1;
    if (next) next();
  }
}

let rateLimitHandler: (info: { delayMs: number; retry: number }) => void = () =>
  undefined;
const sharedJamRequestPacer = new CommentRequestPacer({
  onRateLimit: ({ delayMs, retry }) => rateLimitHandler({ delayMs, retry }),
});

/** Register a URL-free callback for shared 429 cooldowns. */
export function setJamRateLimitHandler(
  handler: (info: { delayMs: number; retry: number }) => void
) {
  rateLimitHandler = handler;
}

/** Queue any itch.io HTML request behind the shared process-wide pacing and cooldown. */
export function scheduleJamRequest(
  request: () => Promise<Response>
): Promise<Response> {
  return sharedJamRequestPacer.schedule(request);
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds)
      ? Math.max(0, Math.ceil(seconds * 1000))
      : undefined;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
