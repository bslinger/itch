import assert from "node:assert/strict";
import { test } from "node:test";
import { creatorCommentStatus } from "common/jams/creator-comments";

const snapshot = {
  ownGameIds: [10],
  commenterIds: [101],
  commenterUrls: ["https://maker.itch.io/"],
  syncedAt: 123,
  complete: true,
};

test("creator comment status requires an own entry and a known creator", () => {
  assert.equal(
    creatorCommentStatus({ gameId: 20, creatorId: 101 }, undefined),
    undefined
  );
  assert.equal(creatorCommentStatus({ gameId: 20 }, snapshot), undefined);
  assert.equal(
    creatorCommentStatus({ gameId: 10, creatorId: 101 }, snapshot),
    undefined
  );
  assert.equal(
    creatorCommentStatus(
      { gameId: 20, creatorId: 101 },
      { ...snapshot, ownGameIds: [] }
    ),
    undefined
  );
});

test("only complete scans establish that no creator comment was found", () => {
  assert.equal(
    creatorCommentStatus({ gameId: 20, creatorId: 101 }, snapshot),
    true
  );
  assert.equal(
    creatorCommentStatus(
      { gameId: 20, creatorId: 102, contributorUrlsComplete: true },
      snapshot
    ),
    false
  );
  assert.equal(
    creatorCommentStatus(
      { gameId: 20, creatorId: 101 },
      { ...snapshot, complete: false }
    ),
    true
  );
  assert.equal(
    creatorCommentStatus(
      { gameId: 20, creatorId: 102, contributorUrlsComplete: true },
      { ...snapshot, complete: false }
    ),
    undefined
  );
});

test("matches verified contributor homepages without relying on display names", () => {
  const entry = {
    gameId: 20,
    creatorUrl: "https://primary.itch.io",
    contributorUrls: ["https://maker.itch.io"],
    contributorUrlsComplete: true,
  };
  assert.equal(creatorCommentStatus(entry, snapshot), true);
  assert.equal(
    creatorCommentStatus(entry, {
      ...snapshot,
      commenterUrls: undefined,
      complete: false,
    }),
    undefined
  );
  assert.equal(
    creatorCommentStatus(entry, {
      ...snapshot,
      commenterUrls: [],
      complete: true,
    }),
    false
  );
  assert.equal(
    creatorCommentStatus(
      { ...entry, contributorUrlsComplete: false },
      { ...snapshot, commenterUrls: [], complete: true }
    ),
    undefined
  );
});
