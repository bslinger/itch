import assert from "node:assert/strict";
import { test } from "node:test";
import { creatorCommentStatus } from "common/jams/creator-comments";

const snapshot = {
  ownGameIds: [10],
  commenterIds: [101],
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
    creatorCommentStatus({ gameId: 20, creatorId: 102 }, snapshot),
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
      { gameId: 20, creatorId: 102 },
      { ...snapshot, complete: false }
    ),
    undefined
  );
});
