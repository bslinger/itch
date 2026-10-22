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

test("parses itch.io's real DiscussionForumPosting JSON-LD shape", () => {
  const html = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"DiscussionForumPosting","@id":"https://itch.io/jam/demo/rate/12","interactionStatistic":{"@type":"InteractionCounter","userInteractionCount":92,"interactionType":"http://schema.org/CommentAction"}}</script>`;
  assert.equal(
    parseJamCommentCount(html, "https://itch.io/jam/demo/rate/12"),
    92
  );
  assert.throws(() =>
    parseJamCommentCount(html, "https://itch.io/jam/demo/rate/13")
  );
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
