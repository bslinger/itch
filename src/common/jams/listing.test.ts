import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, GameType } from "common/butlerd/messages";
import { JamEntry } from "common/jams/model";
import { JamSession } from "common/jams/state";
import { filterJamEntries, JamListingOptions } from "common/jams/listing";

type TestEntry = JamEntry & {
  ratingCount?: number;
  coolness?: number;
  jamEntryId?: number;
  popularityRank?: number;
};

function entry(gameId: number, overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    submissionId: String(gameId + 100),
    submissionUrl: `https://itch.io/jam/test/rate/${gameId + 100}`,
    gameId,
    title: `Game ${gameId}`,
    ...overrides,
  };
}

function jam(
  entries: TestEntry[],
  overrides: Partial<JamSession> = {}
): JamSession {
  return {
    id: "test",
    url: "https://itch.io/jam/test",
    title: "Test Jam",
    entries,
    progress: {},
    importedAt: 1,
    ...overrides,
  };
}

function options(
  overrides: Partial<JamListingOptions> = {}
): JamListingOptions {
  return {
    search: "",
    sort: "popular",
    rating: "all",
    platform: "",
    installation: "all",
    randomSeed: 1,
    ...overrides,
  };
}

function ids(result: JamEntry[]): number[] {
  return result.map((item) => item.gameId);
}

test("sorts all supported orders with unknown metrics after known values", () => {
  const games = [
    entry(1, { ratingCount: 0, coolness: 0, jamEntryId: 20 }),
    entry(2, { ratingCount: 8, coolness: 10, jamEntryId: 10 }),
    entry(3, { ratingCount: 2, coolness: 4, jamEntryId: 30 }),
    entry(4),
  ];
  const session = jam(games);

  assert.deepEqual(ids(filterJamEntries(session, options())), [1, 2, 3, 4]);
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "least_ratings" }))),
    [1, 3, 2, 4]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "most_ratings" }))),
    [2, 3, 1, 4]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "created_at_asc" }))),
    [2, 1, 3, 4]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "created_at_desc" }))),
    [3, 1, 2, 4]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "most_karma" }))),
    [2, 3, 1, 4]
  );
});

test("explicit popularity ranks supersede source order and stable ties keep source order", () => {
  const session = jam([
    entry(1, { popularityRank: 3 }),
    entry(2, { popularityRank: 1 }),
    entry(3, { popularityRank: 1 }),
  ]);
  assert.deepEqual(ids(filterJamEntries(session, options())), [2, 3, 1]);
});

test("random order is deterministic for a seed and does not mutate the feed", () => {
  const games = [entry(11), entry(12), entry(13), entry(14), entry(15)];
  const session = jam(games);
  const before = [...session.entries];
  const first = ids(
    filterJamEntries(session, options({ sort: "random", randomSeed: 42 }))
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "random", randomSeed: 42 }))),
    first
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options())),
    [11, 12, 13, 14, 15]
  );
  assert.deepEqual(session.entries, before);
});

test("rating filters require a ratings snapshot and distinguish confirmed zero ratings", () => {
  const session = jam([entry(1), entry(2)], {
    ratings: { ratedGameIds: [1], syncedAt: 2 },
  });
  assert.deepEqual(
    ids(filterJamEntries(session, options({ rating: "rated" }))),
    [1]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ rating: "unrated" }))),
    [2]
  );
  const unknown = jam([entry(1), entry(2)]);
  assert.deepEqual(
    ids(filterJamEntries(unknown, options({ rating: "rated" }))),
    []
  );
  assert.deepEqual(
    ids(filterJamEntries(unknown, options({ rating: "unrated" }))),
    []
  );
});

test("search, platform, rating, and installation filters combine", () => {
  const oldImportedGame = {
    type: GameType.HTML,
    platforms: { windows: "all" },
  } as unknown as Game;
  const session = jam(
    [
      entry(1, { title: "Amber Hollow", tags: ["puzzle"] }),
      entry(2, { title: "Amber Woods", platforms: ["linux"] }),
      entry(3, { title: "Blue Hollow", platforms: ["web"] }),
    ],
    {
      progress: {
        "101": { status: "ready" },
        "102": { status: "queued" },
        "103": { status: "attention", game: oldImportedGame },
      },
      ratings: { ratedGameIds: [3], syncedAt: 5 },
    }
  );
  assert.deepEqual(
    ids(
      filterJamEntries(
        session,
        options({
          search: "hollow",
          platform: "web",
          rating: "rated",
          installation: "attention",
        })
      )
    ),
    [3]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ installation: "not-installed" }))),
    [3]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ search: "puzzle" }))),
    [1]
  );
  assert.deepEqual(
    ids(
      filterJamEntries(
        session,
        options({ search: "https://itch.io/jam/test/rate/102" })
      )
    ),
    [2]
  );
});

test("all entries are sorted before callers paginate, and in-flight entries are not not-installed", () => {
  const session = jam(
    [
      entry(1, { ratingCount: 1 }),
      entry(2, { ratingCount: 9 }),
      entry(3, { ratingCount: 4 }),
    ],
    {
      progress: {
        "101": { status: "checking" },
        "102": { status: "queued" },
      },
    }
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ sort: "most_ratings" }))),
    [2, 3, 1]
  );
  assert.deepEqual(
    ids(filterJamEntries(session, options({ installation: "not-installed" }))),
    [3]
  );
});
