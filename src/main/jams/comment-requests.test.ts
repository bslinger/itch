import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommentHttpError,
  CommentRequestPacer,
  parseRetryAfter,
} from "main/jams/comment-requests";

function response(
  status: number,
  headers?: ConstructorParameters<typeof Headers>[0]
) {
  return new Response("", { status, headers });
}

test("Retry-After accepts delay seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2", 1000), 2000);
  assert.equal(
    parseRetryAfter(
      "Wed, 21 Oct 2015 07:28:00 GMT",
      Date.parse("Wed, 21 Oct 2015 07:27:58 GMT")
    ),
    2000
  );
  assert.equal(parseRetryAfter("invalid", 1000), undefined);
});

test("shared pacer spaces request starts", async () => {
  let now = 0;
  const starts: number[] = [];
  const pacer = new CommentRequestPacer({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    minimumStartIntervalMs: 1500,
  });
  await pacer.schedule(async () => {
    starts.push(now);
    return response(200);
  });
  await pacer.schedule(async () => {
    starts.push(now);
    return response(200);
  });
  assert.deepEqual(starts, [0, 1500]);
});

test("429 Retry-After establishes a shared cooldown before queued starts", async () => {
  let now = 0;
  const starts: number[] = [];
  let first = true;
  const delays: number[] = [];
  const pacer = new CommentRequestPacer({
    now: () => now,
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
    },
    minimumStartIntervalMs: 0,
    maximumInFlight: 1,
    fallbackRetryDelayMs: 15_000,
    maximumRetries: 2,
    onRateLimit: ({ delayMs }) => delays.push(delayMs),
  });
  const request = async () => {
    starts.push(now);
    if (first) {
      first = false;
      return response(429, { "retry-after": "20" });
    }
    return response(200);
  };
  const [retried, queued] = await Promise.all([
    pacer.schedule(request),
    pacer.schedule(async () => {
      starts.push(now);
      return response(200);
    }),
  ]);
  assert.equal(retried.status, 200);
  assert.equal(queued.status, 200);
  assert.ok(starts.every((start, index) => index === 0 || start >= 20_000));
  assert.ok(delays.includes(20_000));
});

test("429 retries are bounded and end in a typed HTTP error", async () => {
  let now = 0;
  let attempts = 0;
  const pacer = new CommentRequestPacer({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    minimumStartIntervalMs: 0,
    fallbackRetryDelayMs: 100,
    maximumRetries: 2,
  });
  await assert.rejects(
    pacer.schedule(async () => {
      attempts += 1;
      return response(429);
    }),
    (error: unknown) =>
      error instanceof CommentHttpError &&
      error.status === 429 &&
      error.retries === 2
  );
  assert.equal(attempts, 3);
  assert.equal(now, 300);
});

test("pacer limits concurrent requests awaiting headers", async () => {
  let now = 0;
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const pacer = new CommentRequestPacer({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    minimumStartIntervalMs: 0,
    maximumInFlight: 2,
  });
  const jobs = Array.from({ length: 3 }, () =>
    pacer.schedule(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(response(200));
          });
        })
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 2);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases.splice(0).forEach((release) => release());
  await Promise.all(jobs);
  assert.equal(maximumActive, 2);
});
