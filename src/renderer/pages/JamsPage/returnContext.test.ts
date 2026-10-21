import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearJamReturnContext,
  isJamReturnContextValid,
  readJamReturnContext,
  saveJamReturnContext,
  JamReturnContext,
} from "renderer/pages/JamsPage/returnContext";

const context: JamReturnContext = {
  jamId: "jam-a",
  search: "pixel",
  sort: "random",
  rating: "unrated",
  platform: "web",
  installation: "ready",
  page: 2,
  randomSeed: 123456,
  scrollTop: 918,
};

test("jam return context keeps independent tab and profile snapshots", () => {
  saveJamReturnContext("tab-a", 7, context);
  saveJamReturnContext("tab-b", 7, { ...context, jamId: "jam-b" });
  saveJamReturnContext("tab-a", 8, { ...context, jamId: "jam-c" });

  assert.deepEqual(readJamReturnContext("tab-a", 7), context);
  assert.equal(readJamReturnContext("tab-b", 7)?.jamId, "jam-b");
  assert.equal(readJamReturnContext("tab-a", 8)?.jamId, "jam-c");
  clearJamReturnContext("tab-a", 7);
  assert.equal(readJamReturnContext("tab-a", 7), undefined);
  assert.equal(readJamReturnContext("tab-b", 7)?.jamId, "jam-b");
});

test("jam return context rejects invalid controls and deleted jams", () => {
  saveJamReturnContext("tab-a", 9, { ...context, sort: "bogus" as any });
  assert.equal(readJamReturnContext("tab-a", 9), undefined);
  assert.equal(isJamReturnContextValid(context, {}), false);
  assert.equal(isJamReturnContextValid(context, { "jam-a": {} as any }), true);
});
