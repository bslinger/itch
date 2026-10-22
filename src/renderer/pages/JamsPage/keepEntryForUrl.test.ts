import assert from "node:assert/strict";
import { test } from "node:test";
import { JamSession } from "common/jams/state";
import { keepEntryForUrl } from "renderer/pages/JamsPage/keepEntryForUrl";

const jam = {
  entries: [
    {
      submissionId: "101",
      submissionUrl: "https://itch.io/jam/summer/rate/101",
      gameId: 42,
      gameUrl: "https://maker.itch.io/summer-game",
    },
    {
      submissionId: "102",
      submissionUrl: "https://itch.io/jam/summer/rate/102",
      gameId: 43,
      gameUrl: "https://maker.itch.io/other-game",
    },
    {
      submissionId: "103",
      submissionUrl: "https://itch.io/jam/summer/rate/103",
      gameId: 44,
    },
  ],
  progress: {
    "101": { status: "ready", caveId: "cave/one" },
    "102": { status: "ready", caveId: "cave-two" },
    "103": {
      status: "ready",
      game: { id: 44, url: "https://maker.itch.io/fallback-game" },
    },
  },
  id: "jam-id",
  url: "https://itch.io/jam/summer",
  title: "Summer Jam",
  importedAt: 1,
} as unknown as JamSession;

test("matches rating and game routes while ignoring query and hash", () => {
  assert.equal(
    keepEntryForUrl(
      "https://itch.io/jam/summer/rate/101?from=card#reviews",
      jam
    ),
    "101"
  );
  assert.equal(
    keepEntryForUrl("https://maker.itch.io/summer-game/play?x=1#top", jam),
    "101"
  );
});

test("matches internal game and cave routes to their Jam entries", () => {
  assert.equal(keepEntryForUrl("itch://games/42", jam), "101");
  assert.equal(keepEntryForUrl("itch://caves/cave%2Fone/launch", jam), "101");
  assert.equal(keepEntryForUrl("itch://games/999", jam), undefined);
});

test("does not match another game, another host, or malformed native URLs", () => {
  assert.equal(keepEntryForUrl("https://maker.itch.io/other-game", jam), "102");
  assert.equal(
    keepEntryForUrl("https://maker.itch.io/fallback-game", jam),
    "103"
  );
  assert.equal(
    keepEntryForUrl("https://maker.itch.io.evil.test/summer-game", jam),
    undefined
  );
  assert.equal(
    keepEntryForUrl("https://elsewhere.test/summer-game", jam),
    undefined
  );
  assert.equal(keepEntryForUrl("itch://caves/%E0%A4%A", jam), undefined);
});
