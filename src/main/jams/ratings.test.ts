import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJamRatedGames } from "main/jams/ratings";

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
