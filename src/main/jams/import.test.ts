import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJamEntriesPage, parseJamEntriesResponse } from "main/jams/import";

const jamUrl = "https://itch.io/jam/summer-jam";

test("reads jam title and numeric entries endpoint from page bootstrap", () => {
  const html = `<h1 class="jam_title_header"><a href="/jam/summer-jam">Summer &amp; Fun</a></h1>
    <script>React.createElement(Browse, {"entries_url":"\\/jam\\/12345\\/entries.json","total_entries_count":2})</script>`;
  assert.deepEqual(parseJamEntriesPage(html, jamUrl), {
    title: "Summer & Fun",
    entriesUrl: "https://itch.io/jam/12345/entries.json",
  });
});

test("rejects embedded and malformed markup in jam titles", () => {
  for (const title of [
    "<script>alert(1)</script>",
    "<scrip<script>removed</script>t>alert(1)</script>",
    '<img src=x onerror="alert(1)">Summer Jam',
    "<em>Summer</em> Jam",
    "Summer < Jam",
  ]) {
    const html = `<h1 class="jam_title_header"><a href="/jam/summer-jam">${title}</a></h1>
      <script>{"entries_url":"/jam/12345/entries.json"}</script>`;
    assert.throws(
      () => parseJamEntriesPage(html, jamUrl),
      /Could not read the jam title/
    );
  }
});

test("preserves encoded characters as plain jam title text", () => {
  const html = `<h1 class="jam_title_header"><a href="/jam/summer-jam">雪 &lt;Summer&gt; &#x1f3ae; &#38; Fun</a></h1>
    <script>{"entries_url":"/jam/12345/entries.json"}</script>`;
  assert.equal(parseJamEntriesPage(html, jamUrl).title, "雪 <Summer> 🎮 & Fun");
});

test("rejects entries endpoints outside itch's public numeric jam route", () => {
  const html = `<h1 class="jam_title_header"><a href="/jam/summer-jam">Summer Jam</a></h1>
    <script>{"entries_url":"https://evil.example/entries.json"}</script>`;
  assert.throws(
    () => parseJamEntriesPage(html, jamUrl),
    /unsupported entries URL/
  );
});

test("maps all valid submissions, deduplicates game ids, and accepts an empty jam", () => {
  const game = {
    id: 123,
    title: "Tiny Game",
    url: "https://maker.itch.io/tiny-game",
  };
  const input = {
    jam_games: [
      {
        id: 900,
        url: "/jam/summer-jam/rate/123",
        game: {
          ...game,
          user: { id: 321, url: "https://maker.itch.io" },
        },
        contributors: [
          { name: "Daniel Graves", url: "https://nulledwine.itch.io" },
          { name: "Lichajen", url: "https://lichajen.itch.io" },
          { name: "lifes30daytrial", url: "https://lifes30daytrial.itch.io" },
          { name: "koko", url: "https://ilikeflowerssomuch.itch.io" },
          { name: "Desolo Zantas", url: "https://desolozantas.itch.io" },
          { name: "ThePatientHusky", url: "https://thepatienthusky.itch.io" },
        ],
      },
      { id: 901, url: "/jam/summer-jam/rate/123", game },
      {
        id: 902,
        url: "/jam/summer-jam/rate/456",
        game: {
          id: 456,
          title: "Another Game",
          url: "https://other.itch.io/another",
        },
      },
    ],
  };
  assert.deepEqual(parseJamEntriesResponse(input, jamUrl), [
    {
      submissionId: "123",
      submissionUrl: "https://itch.io/jam/summer-jam/rate/123",
      gameId: 123,
      title: "Tiny Game",
      gameUrl: "https://maker.itch.io/tiny-game",
      creatorId: 321,
      creatorUrl: "https://maker.itch.io/",
      contributorUrls: [
        "https://nulledwine.itch.io/",
        "https://lichajen.itch.io/",
        "https://lifes30daytrial.itch.io/",
        "https://ilikeflowerssomuch.itch.io/",
        "https://desolozantas.itch.io/",
        "https://thepatienthusky.itch.io/",
      ],
      contributorUrlsComplete: true,
      jamEntryId: 900,
      popularityRank: 0,
    },
    {
      submissionId: "456",
      submissionUrl: "https://itch.io/jam/summer-jam/rate/456",
      gameId: 456,
      title: "Another Game",
      gameUrl: "https://other.itch.io/another",
      jamEntryId: 902,
      contributorUrls: [],
      contributorUrlsComplete: true,
      popularityRank: 2,
    },
  ]);
  assert.deepEqual(parseJamEntriesResponse({ jam_games: [] }, jamUrl), []);
});

test("maps optional card metadata and ignores unsafe or malformed optional values", () => {
  const entries = parseJamEntriesResponse(
    {
      jam_games: [
        {
          url: "/jam/summer-jam/rate/789",
          game: {
            id: 789,
            title: "Metadata Game",
            cover: "https://img.itch.zone/aW1nLzE=/300x240%23c/cover.png",
            short_text: "  A short description  ",
            platforms: ["windows", "web", "unknown", 42],
            tags: [{ name: "Puzzle" }, { name: "Co-op" }],
          },
        },
        {
          url: "/jam/summer-jam/rate/790",
          game: {
            id: 790,
            title: "Legacy Game",
            cover: "https://img.itch.zone.evil.example/cover.png",
            short_text: { unexpected: true },
            platforms: "web",
          },
        },
      ],
    },
    jamUrl
  );

  assert.deepEqual(entries[0], {
    submissionId: "789",
    submissionUrl: "https://itch.io/jam/summer-jam/rate/789",
    gameId: 789,
    title: "Metadata Game",
    gameUrl: undefined,
    coverUrl: "https://img.itch.zone/aW1nLzE=/300x240%23c/cover.png",
    shortText: "A short description",
    platforms: ["windows", "web"],
    tags: ["Puzzle", "Co-op"],
    contributorUrls: [],
    contributorUrlsComplete: true,
    popularityRank: 0,
  });
  assert.deepEqual(entries[1], {
    submissionId: "790",
    submissionUrl: "https://itch.io/jam/summer-jam/rate/790",
    gameId: 790,
    title: "Legacy Game",
    gameUrl: undefined,
    contributorUrls: [],
    contributorUrlsComplete: true,
    popularityRank: 1,
  });
});

test("treats omitted contributors as a complete solo entry and malformed lists as incomplete", () => {
  const parse = (contributors?: unknown) =>
    parseJamEntriesResponse(
      {
        jam_games: [
          {
            url: "/jam/summer-jam/rate/791",
            game: {
              id: 791,
              title: "Solo Game",
            },
            ...(contributors !== undefined ? { contributors } : {}),
          },
        ],
      },
      jamUrl
    )[0];

  const solo = parse();
  assert.equal(solo.contributorUrlsComplete, true);
  assert.deepEqual(solo.contributorUrls, []);

  const malformed = parse({ unexpected: true });
  assert.equal(malformed.contributorUrlsComplete, false);
  assert.deepEqual(malformed.contributorUrls, []);
  assert.equal(parse(null).contributorUrlsComplete, false);
});

test("maps public rating counters and entry ids while omitting invalid counters", () => {
  const entries = parseJamEntriesResponse(
    {
      jam_games: [
        {
          id: 456,
          url: "/jam/summer-jam/rate/456",
          rating_count: 12,
          coolness: 9,
          game: { id: 456, title: "Rated Game" },
        },
        {
          id: -10,
          url: "/jam/summer-jam/rate/457",
          rating_count: -1,
          coolness: 1.5,
          game: { id: 457, title: "Invalid Counters" },
        },
      ],
    },
    jamUrl
  );

  assert.deepEqual(entries, [
    {
      submissionId: "456",
      submissionUrl: "https://itch.io/jam/summer-jam/rate/456",
      gameId: 456,
      title: "Rated Game",
      gameUrl: undefined,
      ratingCount: 12,
      coolness: 9,
      jamEntryId: 456,
      contributorUrls: [],
      contributorUrlsComplete: true,
      popularityRank: 0,
    },
    {
      submissionId: "457",
      submissionUrl: "https://itch.io/jam/summer-jam/rate/457",
      gameId: 457,
      title: "Invalid Counters",
      gameUrl: undefined,
      contributorUrls: [],
      contributorUrlsComplete: true,
      popularityRank: 1,
    },
  ]);
});

test("rejects malformed entries and entries belonging to another jam", () => {
  assert.throws(
    () => parseJamEntriesResponse({ jam_games: [{}] }, jamUrl),
    /missing its game data/
  );
  assert.throws(
    () =>
      parseJamEntriesResponse(
        {
          jam_games: [
            {
              url: "/jam/another-jam/rate/123",
              game: { id: 123, title: "Wrong Jam" },
            },
          ],
        },
        jamUrl
      ),
    /does not match the requested jam or game/
  );
  assert.throws(
    () =>
      parseJamEntriesResponse(
        {
          jam_games: [
            {
              url: "/jam/summer-jam/rate/124",
              game: { id: 123, title: "Mismatched Game ID" },
            },
          ],
        },
        jamUrl
      ),
    /does not match the requested jam or game/
  );
});
