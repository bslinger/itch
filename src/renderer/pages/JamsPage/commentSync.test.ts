import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldDispatchVisibleCommentSync,
  visibleCommentSyncKey,
} from "renderer/pages/JamsPage/commentSync";

test("partial comment counts reordering the same entries does not start another batch", () => {
  const previousKey = visibleCommentSyncKey(1, "jam", ["a", "b", "c"]);
  const reorderedKey = visibleCommentSyncKey(1, "jam", ["b", "c", "a"]);
  assert.equal(reorderedKey, previousKey);
  assert.equal(
    shouldDispatchVisibleCommentSync({
      fresh: false,
      commentsSyncing: true,
      commentsAllSyncing: false,
      nextKey: reorderedKey,
      previousKey,
    }),
    false
  );
});

test("visible comment sync waits for an active batch but allows an explicit refresh", () => {
  assert.equal(
    shouldDispatchVisibleCommentSync({
      fresh: false,
      commentsSyncing: true,
      commentsAllSyncing: false,
      nextKey: "new-page",
      previousKey: "old-page",
    }),
    false
  );
  assert.equal(
    shouldDispatchVisibleCommentSync({
      fresh: true,
      commentsSyncing: true,
      commentsAllSyncing: false,
      nextKey: "new-page",
      previousKey: "old-page",
    }),
    true
  );
  assert.equal(
    shouldDispatchVisibleCommentSync({
      fresh: true,
      commentsSyncing: false,
      commentsAllSyncing: true,
      nextKey: "new-page",
      previousKey: "old-page",
    }),
    false
  );
});
