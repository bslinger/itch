import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextCommentPage,
  ownSubmissionMapIsComplete,
  parseCommentAuthorIds,
  parseCommentAuthorProfiles,
  parseProfileHomepage,
  parseJamCommentCount,
  scanJamEntryComments,
} from "main/jams/comments";

test("reads an explicit zero comment count from JSON-LD", () => {
  const html = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"DiscussionForumPosting","@id":"https://itch.io/jam/demo/rate/12","interactionStatistic":{"@type":"InteractionCounter","interactionType":"http://schema.org/CommentAction","userInteractionCount":0}}</script>`;
  assert.equal(
    parseJamCommentCount(html, "https://itch.io/jam/demo/rate/12"),
    0
  );
});

function emptyThreadPage(id = 12, jam = "demo", closed = true) {
  return `<h1 class="jam_title_header"><a href="/jam/${jam}">Demo</a></h1><div id="jam_rate_game_100"><div class="community_post_list_widget base_widget">${
    closed ? "</div></div>" : ""
  }<script>init_JamRateGame('#jam_rate_game_100', {"id":${id},"slug":"demo"});</script>`;
}

test("empty threads without discussion JSON-LD count as zero after verifying the jam and game", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const html = emptyThreadPage();
  assert.equal(parseJamCommentCount(html, base), 0);
  assert.deepEqual(await scanJamEntryComments(base, async () => html), {
    commenterIds: [],
    authorProfiles: [],
    complete: true,
  });
  for (const page of [
    emptyThreadPage(13),
    emptyThreadPage(12, "other"),
    emptyThreadPage(12, "demo", false),
    html.replace('id="jam_rate_game_100"', 'id="other"'),
    html.replace('{"id":12,"slug":"demo"}', "notJSON"),
  ]) {
    assert.throws(() => parseJamCommentCount(page, base));
    assert.equal(
      (await scanJamEntryComments(base, async () => page)).complete,
      false
    );
  }
});

test("an empty comment list cannot override positive totals", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const positiveTotal = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":2}}</script>`;
  assert.throws(
    () => parseJamCommentCount(emptyThreadPage() + positiveTotal, base),
    /disagreed/
  );
  const positivePager =
    emptyThreadPage() +
    `<div class="topic_pager">Viewing comments 2 to 1 of 2</div>`;
  assert.equal(
    (await scanJamEntryComments(base, async () => positivePager)).complete,
    false
  );
  const malformedPager =
    emptyThreadPage() +
    `<div class="topic_pager">Viewing comments ??? to 1 of ???</div>`;
  assert.throws(
    () => parseJamCommentCount(malformedPager, base),
    /pager could not be read/
  );
  assert.equal(
    (await scanJamEntryComments(base, async () => malformedPager)).complete,
    false
  );
});

test("does not mistake itch.io's reply-inclusive JSON-LD total for top-level comments", () => {
  const html = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"DiscussionForumPosting","@id":"https://itch.io/jam/demo/rate/12","interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":92,"interactionType":"http://schema.org/CommentAction"}}</script>`;
  assert.throws(
    () => parseJamCommentCount(html, "https://itch.io/jam/demo/rate/12"),
    /top-level comment count/
  );
  assert.throws(() =>
    parseJamCommentCount(html, "https://itch.io/jam/demo/rate/13")
  );
});

test("uses the public pager's top-level total instead of JSON-LD reply total", () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const html = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":92}}</script><div class="community_topic_posts_widget"><div class="topic_pager "><span class="page_label">Viewing comments <nobr><span>87</span> to <span>68</span> of 87</nobr></span><a>Next page</a></div><div class="community_post_list_widget"><div class="community_post" data-post='{"id":1,"user_id":10}'></div></div></div>`;
  assert.equal(parseJamCommentCount(html, base), 87);
});

test("counts top-level post nodes from the comment list when no pager exists", () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const html = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":3}}</script><div class="community_post_list_widget"><div class="community_post" data-post='{"id":1,"user_id":10}'><div class="community_post" data-post='{"id":2,"user_id":11}'></div></div><div class="community_post" data-post='{"id":3,"user_id":12}'></div></div>`;
  assert.equal(parseJamCommentCount(html, base), 2);
  assert.deepEqual(parseCommentAuthorIds(html), [10, 11, 12]);
});

test("counts four root comments and excludes five sibling replies in itch's Knife layout", async () => {
  const base = "https://itch.io/jam/synty-spooky-jam-oct26/rate/5159912";
  // itch renders each replies container after the parent's closing div.
  let id = 0;
  const post = (classes: string) => {
    const author = ++id;
    return `<div class="${classes}" data-post='{"id":${author},"user_id":${author}}'><div class="post_header"><span class="post_author"><a href="/profile/user-${author}">Author</a></span></div></div>`;
  };
  const threads = [1, 1, 2, 1]
    .map(
      (replies) =>
        post("community_post sidebar_avatar has_replies") +
        `<div class="community_post_replies top_level_replies">${Array.from(
          { length: replies },
          () => post("community_post is_reply")
        ).join("")}</div>`
    )
    .join("");
  const html = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":9}}</script><div class="community_post_list_widget base_widget">${threads}</div>`;
  assert.equal(parseJamCommentCount(html, base), 4);
  assert.equal(parseCommentAuthorIds(html).length, 9);
  assert.equal(
    (await scanJamEntryComments(base, async () => html)).complete,
    true
  );
});

test("does not treat a reply-inclusive total or truncated DOM as top-level count", () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const jsonLd = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":3}}</script>`;
  assert.throws(
    () => parseJamCommentCount(jsonLd, base),
    /top-level comment count/
  );
  assert.throws(
    () =>
      parseJamCommentCount(
        `${jsonLd}<div class="community_post_list_widget"><div class="community_post" data-post='{"id":1,"user_id":10}'>`,
        base
      ),
    /top-level comment count/
  );
});

test("the pager's explicit zero is a known top-level count", () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const html = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":0}}</script><div class="topic_pager"><span>Viewing comments <nobr>0 to 0 of 0</nobr></span></div><div class="community_post_list_widget"></div>`;
  assert.equal(parseJamCommentCount(html, base), 0);
});

test("keeps missing and malformed comment counts unknown", () => {
  assert.throws(() =>
    parseJamCommentCount(
      `<script type="application/ld+json">{}</script>`,
      "https://itch.io/jam/demo/rate/12"
    )
  );
  assert.throws(() =>
    parseJamCommentCount(
      `<script type="application/ld+json">{broken</script>`,
      "https://itch.io/jam/demo/rate/12"
    )
  );
});

test("collects only valid numeric comment authors", () => {
  const html = `<div data-post='{"id":1,"user_id":42}'></div><div data-post='{"id":2,"user_id":"bad"}'></div><div data-post='not-json'></div>`;
  assert.deepEqual(parseCommentAuthorIds(html), [42]);
});

test("own submitted-game map is incomplete when it omits a known owned entry", () => {
  const entry = {
    submissionId: "12",
    submissionUrl: "https://itch.io/jam/demo/rate/12",
    gameId: 500,
    title: "Owned game",
    creatorId: 77,
  };
  assert.equal(ownSubmissionMapIsComplete([entry], 77, [500]), true);
  assert.equal(ownSubmissionMapIsComplete([entry], 77, []), false);
  assert.equal(ownSubmissionMapIsComplete([entry], 88, []), true);
});

test("binds profile links only from each post's author header", () => {
  const html = `<div class="community_post" data-post='{"id":1,"user_id":42}'><div class="post_header"><div class="post_author"><a href="/profile/maker">Maker</a></div></div><div class="post_body"><a href="/profile/wrong">body link</a></div></div>`;
  assert.deepEqual(parseCommentAuthorProfiles(html), [
    { userId: 42, profileUrl: "https://itch.io/profile/maker" },
  ]);
});

test("maps a verified itch profile ID to its canonical creator homepage", () => {
  const profile = `<head><link rel="canonical" href="https://lichajen.itch.io"><meta name="itch:path" content="users/6364506"></head><input name="blocked_user_id" value="6364506">`;
  assert.equal(
    parseProfileHomepage(profile, 6364506),
    "https://lichajen.itch.io/"
  );
  assert.equal(parseProfileHomepage(profile, 2), undefined);
});

test("follows only a decreasing older-comment cursor on the same entry", () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const pager = `<div class="topic_pager"><a class="page_link" href="${base}?after=0">Last page</a><a class="page_link" href="${base}?before=68">Next page</a></div>`;
  assert.equal(nextCommentPage(pager, base, base), `${base}?before=68`);
  assert.equal(nextCommentPage(pager, `${base}?before=68`, base), undefined);
  const bad = `<div class="topic_pager"><a class="page_link" href="/jam/other/rate/13?before=20">Next page</a></div>`;
  assert.equal(nextCommentPage(bad, base, base), undefined);
});

function discussionPage(
  id: string,
  count: number,
  post?: number,
  author = 42,
  pager = ""
) {
  const data =
    post === undefined
      ? ""
      : `<div class="community_post" data-post="{&quot;id&quot;:${post},&quot;user_id&quot;:${author}}"><div class="post_header"><div class="post_author"><a href="/profile/user-${author}">Author</a></div></div></div>`;
  return `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${id}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":${count}}}</script>${pager}${data}`;
}

test("scans every older page and completes only after IDs and pages are complete", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const pages = new Map([
    [
      base,
      discussionPage(
        base,
        2,
        102,
        43,
        `<div class="topic_pager"><span>Viewing comments <nobr><span>2</span> to <span>2</span> of 2</nobr></span><a class="page_link" href="${base}?before=2">Next page</a></div>`
      ),
    ],
    [
      `${base}?before=2`,
      discussionPage(
        base,
        2,
        101,
        42,
        `<div class="topic_pager"><span>Viewing comments <nobr><span>1</span> to <span>1</span> of 2</nobr></span><a class="page_link" href="${base}?after=0">Last page</a></div>`
      ),
    ],
  ]);
  const result = await scanJamEntryComments(
    base,
    async (url) => pages.get(url)!
  );
  assert.deepEqual(result.commenterIds.sort(), [42, 43]);
  assert.equal(result.complete, true);
});

test("a missing older-page link or mismatched response identity cannot establish a negative", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const truncated = discussionPage(
    base,
    2,
    102,
    43,
    `<div class="topic_pager"><span>Viewing comments <nobr><span>2</span> to <span>2</span> of 2</nobr></span></div>`
  );
  const incomplete = await scanJamEntryComments(base, async () => truncated);
  assert.equal(incomplete.complete, false);
  const wrongIdentity = await scanJamEntryComments(base, async () =>
    discussionPage("https://itch.io/jam/demo/rate/13", 1, 1)
  );
  assert.deepEqual(wrongIdentity, {
    commenterIds: [],
    authorProfiles: [],
    complete: false,
  });
});

test("an explicit zero-count thread is a complete scan", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const result = await scanJamEntryComments(base, async () =>
    discussionPage(base, 0)
  );
  assert.deepEqual(result, {
    commenterIds: [],
    authorProfiles: [],
    complete: true,
  });
});

test("display count excludes replies while creator scan still checks every post ID", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const html = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":2}}</script><div class="topic_pager"><span>Viewing comments <nobr>1 to 1 of 1</nobr></span></div><div class="community_post_list_widget"><div class="community_post" data-post='{"id":101,"user_id":42}'><div class="post_header"><div class="post_author"><a href="/profile/one">A</a></div></div><div class="community_post is_reply" data-post='{"id":102,"user_id":43}'><div class="post_header"><div class="post_author"><a href="/profile/two">B</a></div></div></div></div></div>`;
  assert.equal(parseJamCommentCount(html, base), 1);
  const scan = await scanJamEntryComments(base, async () => html);
  assert.deepEqual(scan, {
    commenterIds: [42, 43],
    authorProfiles: [
      { userId: 42, profileUrl: "https://itch.io/profile/one" },
      { userId: 43, profileUrl: "https://itch.io/profile/two" },
    ],
    complete: true,
  });
});
