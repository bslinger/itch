import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextCommentPage,
  parseCommentAuthorIds,
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
  const post = (classes: string) =>
    `<div class="${classes}" data-post='{"id":${++id},"user_id":${id}}'></div>`;
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
      : `<div data-post="{&quot;id&quot;:${post},&quot;user_id&quot;:${author}}"></div>`;
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
  assert.deepEqual(wrongIdentity, { commenterIds: [], complete: false });
});

test("an explicit zero-count thread is a complete scan", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const result = await scanJamEntryComments(base, async () =>
    discussionPage(base, 0)
  );
  assert.deepEqual(result, { commenterIds: [], complete: true });
});

test("display count excludes replies while creator scan still checks every post ID", async () => {
  const base = "https://itch.io/jam/demo/rate/12";
  const html = `<script type="application/ld+json">{"@type":"DiscussionForumPosting","@id":"${base}","interactionStatistic":{"interactionType":"http://schema.org/CommentAction","userInteractionCount":2}}</script><div class="topic_pager"><span>Viewing comments <nobr>1 to 1 of 1</nobr></span></div><div class="community_post_list_widget"><div class="community_post" data-post='{"id":101,"user_id":42}'><div class="community_post" data-post='{"id":102,"user_id":43}'></div></div></div>`;
  assert.equal(parseJamCommentCount(html, base), 1);
  const scan = await scanJamEntryComments(base, async () => html);
  assert.deepEqual(scan, { commenterIds: [42, 43], complete: true });
});
