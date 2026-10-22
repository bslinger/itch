import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJamPersonalRating, parseJamRatedGames } from "main/jams/ratings";

const jamUrl = "https://itch.io/jam/summer-jam";
const userId = 1234;

function authenticatedPage(
  ratedGames: Record<string, boolean>,
  currentUserId = userId,
  jamSlug = "summer-jam"
) {
  return `<h1 class="jam_title_header"><a href="/jam/${jamSlug}">Summer Jam</a></h1>
    <script>I.current_user = {"id":${currentUserId},"name":"tester"};
    ReactDOM.render(R.Jam.BrowseEntries({"rated_games":${JSON.stringify(
      ratedGames
    )},"jam_games":[]}), document.getElementById("entries"));</script>`;
}

test("reads this account's truthy rated-game ids from jam bootstrap props", () => {
  const html = authenticatedPage({ "42": true, "43": false, "9001": 1 as any });
  assert.deepEqual(parseJamRatedGames(html, jamUrl, userId), [42, 9001]);
});

test("accepts an authenticated empty ratings map", () => {
  assert.deepEqual(
    parseJamRatedGames(authenticatedPage({}), jamUrl, userId),
    []
  );
});

test("rejects another account, another jam, and missing rated data", () => {
  assert.throws(
    () => parseJamRatedGames(authenticatedPage({}, userId + 1), jamUrl, userId),
    /did not confirm the signed-in account/
  );
  assert.throws(
    () =>
      parseJamRatedGames(
        authenticatedPage({}, userId, "other-jam"),
        jamUrl,
        userId
      ),
    /did not match the requested jam/
  );
  const missingData = `<h1 class="jam_title_header"><a href="/jam/summer-jam">Summer Jam</a></h1>
    <script>I.current_user = {"id":${userId}}; R.Jam.BrowseEntries({"jam_games":[]});</script>`;
  assert.throws(
    () => parseJamRatedGames(missingData, jamUrl, userId),
    /did not include your rated-game list/
  );
});

test("rejects malformed ids and malformed bootstrap data", () => {
  assert.throws(
    () => parseJamRatedGames(authenticatedPage({ "0": true }), jamUrl, userId),
    /invalid rated-game list/
  );
  assert.throws(
    () =>
      parseJamRatedGames(
        `<h1 class="jam_title_header"><a href="/jam/summer-jam">Summer Jam</a></h1>
        <script>I.current_user = {"id":${userId}}; R.Jam.BrowseEntries({"rated_games":);</script>`,
        jamUrl,
        userId
      ),
    /incomplete jam bootstrap data/
  );
});

const submissionUrl = `${jamUrl}/rate/42`;
function authenticatedSavedRating(
  criteria: unknown,
  currentUserId = userId,
  pageUrl = submissionUrl,
  typeUpvote = false
) {
  return `<script>I.current_user = {"id":${currentUserId}}; ReactDOM.render(R.Jam.JamGameVoter({"criteria":${JSON.stringify(
    criteria
  )},"type_upvote":${typeUpvote}}), document.body);</script>
    <script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${pageUrl}"}</script>`;
}

test("parses authenticated saved criteria and uses the verified five-star scale", () => {
  const value = parseJamPersonalRating(
    authenticatedSavedRating([
      { id: 1, name: "Gameplay", existing_rating: { score: 3 } },
      { id: 2, name: "Art", existing_rating: { score: 5 } },
    ]),
    submissionUrl,
    userId
  );
  assert.equal(value.average, 4);
  assert.deepEqual(value.categories, [
    { name: "Gameplay", value: 3, max: 5 },
    { name: "Art", value: 5, max: 5 },
  ]);
});

test("saved ratings can be read when an empty comment thread omits JSON-LD", () => {
  const html =
    authenticatedSavedRating([
      { id: 1, name: "Overall", existing_rating: { score: 4 } },
    ]).replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "") +
    `<h1 class="jam_title_header"><a href="/jam/summer-jam">Summer Jam</a></h1><div id="jam_rate_game_1"></div><script>init_JamRateGame('#jam_rate_game_1', {"id":42});</script>`;
  assert.equal(parseJamPersonalRating(html, submissionUrl, userId).average, 4);
  assert.throws(
    () =>
      parseJamPersonalRating(
        html.replace('{"id":42}', '{"id":43}'),
        submissionUrl,
        userId
      ),
    /did not match/
  );
});

test("parses binary upvotes and rejects missing, wrong-account, or wrong-entry payloads", () => {
  const value = parseJamPersonalRating(
    authenticatedSavedRating(
      [{ id: 1, name: "Worth a vote", existing_rating: { score: true } }],
      userId,
      submissionUrl,
      true
    ),
    submissionUrl,
    userId
  );
  assert.deepEqual(value.categories, [
    { name: "Worth a vote", value: 1, max: 1 },
  ]);
  assert.throws(
    () =>
      parseJamPersonalRating(
        authenticatedSavedRating([], userId),
        submissionUrl,
        userId
      ),
    /did not include any saved category ratings/
  );
  assert.throws(
    () =>
      parseJamPersonalRating(
        authenticatedSavedRating([], userId + 1),
        submissionUrl,
        userId
      ),
    /did not confirm the signed-in account/
  );
  assert.throws(
    () =>
      parseJamPersonalRating(
        authenticatedSavedRating(
          [{ id: 1, name: "Art", existing_rating: { score: 5 } }],
          userId,
          `${jamUrl}/rate/43`
        ),
        submissionUrl,
        userId
      ),
    /did not match the requested jam entry/
  );
});
