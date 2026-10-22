import {
  JamEntry,
  normalizeJamUrl,
  normalizeSubmissionUrl,
} from "common/jams/model";
import { partitionForUser } from "common/util/partition-for-user";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;

export async function fetchJamCommentCount(
  submissionUrl: string
): Promise<number> {
  const canonical = normalizeSubmissionUrl(submissionUrl);
  if (!canonical) throw new Error("Invalid jam submission URL");
  const html = await fetchPage(canonical);
  return parseJamCommentCount(html, canonical);
}

export function parseJamCommentCount(
  html: string,
  submissionUrl: string
): number {
  const canonical = normalizeSubmissionUrl(submissionUrl);
  if (!canonical) throw new Error("Invalid jam submission URL");
  validateCommentPageIdentity(html, canonical);
  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      const values = Array.isArray(data) ? data : [data];
      for (const value of values) {
        if (
          !value ||
          typeof value !== "object" ||
          value["@type"] !== "DiscussionForumPosting" ||
          normalizeSubmissionUrl(value["@id"]) !== canonical
        )
          continue;
        const stats = (value as any).interactionStatistic;
        for (const stat of Array.isArray(stats)
          ? stats
          : stats
          ? [stats]
          : []) {
          const action =
            typeof stat?.interactionType === "string"
              ? stat.interactionType
              : stat?.interactionType?.["@type"];
          if (
            (action === "http://schema.org/CommentAction" ||
              action === "CommentAction") &&
            Number.isSafeInteger(stat.userInteractionCount) &&
            stat.userInteractionCount >= 0
          )
            return stat.userInteractionCount;
        }
      }
    } catch {
      /* Ignore unrelated or malformed JSON-LD blocks. */
    }
  }
  throw new Error(
    "itch.io did not provide a comment count for this submission"
  );
}

export function validateCommentPageIdentity(
  html: string,
  submissionUrl: string
): void {
  const canonical = normalizeSubmissionUrl(submissionUrl);
  if (!canonical) throw new Error("Invalid jam submission URL");
  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      for (const value of Array.isArray(data) ? data : [data]) {
        if (
          value?.["@type"] === "DiscussionForumPosting" &&
          normalizeSubmissionUrl(value["@id"]) === canonical
        )
          return;
      }
    } catch {
      /* Ignore unrelated JSON-LD blocks. */
    }
  }
  throw new Error("The returned page did not match the requested submission");
}

export interface CreatorCommentScan {
  ownGameIds: number[];
  commenterIds: number[];
  complete: boolean;
}

export async function fetchJamCreatorComments(
  jamUrl: string,
  userId: number,
  knownEntries: JamEntry[]
): Promise<CreatorCommentScan> {
  const canonical = normalizeJamUrl(jamUrl);
  if (!canonical || !Number.isSafeInteger(userId) || userId <= 0)
    throw new Error("Invalid jam or account");
  const { session } = await import("electron");
  const accountSession = session.fromPartition(
    partitionForUser(String(userId)),
    { cache: true }
  );
  const first = await responseText(
    await accountSession.fetch(`${canonical}/entries`, {
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
  );
  const validated = validateOwnedGames(first, canonical, userId);
  const ownGameIds = validated.gameIds;
  const commenterIds = new Set<number>();
  let complete = true;
  const entriesByGame = new Map(
    knownEntries.map((entry) => [
      entry.gameId,
      normalizeSubmissionUrl(entry.submissionUrl),
    ])
  );
  for (const gameId of ownGameIds) {
    const entryUrl = entriesByGame.get(gameId);
    if (!entryUrl || !entryUrl.startsWith(`${canonical}/rate/`)) {
      complete = false;
      continue;
    }
    try {
      const scan = await scanJamEntryComments(entryUrl, async (pageUrl) =>
        responseText(
          await accountSession.fetch(pageUrl, {
            credentials: "include",
            redirect: "error",
            signal: AbortSignal.timeout(20_000),
          })
        )
      );
      scan.commenterIds.forEach((id) => commenterIds.add(id));
      complete &&= scan.complete;
    } catch {
      complete = false;
    }
  }
  return { ownGameIds, commenterIds: [...commenterIds], complete };
}

export async function scanJamEntryComments(
  entryUrl: string,
  loadPage: (url: string) => Promise<string>
): Promise<{ commenterIds: number[]; complete: boolean }> {
  const canonical = normalizeSubmissionUrl(entryUrl);
  if (!canonical) throw new Error("Invalid jam submission URL");
  const commenterIds = new Set<number>(),
    postIds = new Set<number>(),
    visited = new Set<string>();
  let expectedCount: number | undefined,
    complete = true,
    pageUrl: string | undefined = canonical;
  for (let page = 0; page < MAX_PAGES && pageUrl; page += 1) {
    if (visited.has(pageUrl)) {
      complete = false;
      break;
    }
    visited.add(pageUrl);
    let html: string;
    try {
      html = await loadPage(pageUrl);
      validateCommentPageIdentity(html, canonical);
    } catch {
      complete = false;
      break;
    }
    try {
      const count = parseJamCommentCount(html, canonical);
      if (expectedCount === undefined) expectedCount = count;
      else if (expectedCount !== count) complete = false;
    } catch {
      complete = false;
    }
    const posts = parseCommentPosts(html);
    posts.postIds.forEach((id) => postIds.add(id));
    posts.authorIds.forEach((id) => commenterIds.add(id));
    if (posts.invalid) complete = false;
    const pager = html.match(
      /<div\b[^>]*class="[^"]*topic_pager[^"]*"[^>]*>([\s\S]*?)<\/div>/i
    )?.[1];
    const hasNext = /<a\b[^>]*>\s*Next page\s*<\/a>/i.test(pager || "");
    const next = nextCommentPage(html, pageUrl, canonical);
    if (hasNext && !next) {
      complete = false;
      pageUrl = undefined;
      break;
    }
    if (!next) {
      if (pager && parsePagerRangeEnd(pager) !== 1) complete = false;
      pageUrl = undefined;
    } else pageUrl = next;
  }
  if (pageUrl || expectedCount === undefined || expectedCount !== postIds.size)
    complete = false;
  return { commenterIds: [...commenterIds], complete };
}

function validateOwnedGames(
  html: string,
  jamUrl: string,
  userId: number
): { gameIds: number[] } {
  const slug = new URL(jamUrl).pathname.split("/")[2];
  const titleMatch = html.match(
    /<h1\b[^>]*class="[^"]*\bjam_title_header\b[^"]*"[^>]*>\s*<a\b[^>]*href="\/jam\/([a-z0-9-]+)"/i
  );
  if (!titleMatch || titleMatch[1] !== slug)
    throw new Error("The returned page did not match the requested jam");
  const user = assignedJson(html, /\bI\.current_user\s*=\s*/g) as any;
  if (!user || user.id !== userId)
    throw new Error("itch.io did not confirm the signed-in account");
  const props = assignedJson(html, /\bR\.Jam\.BrowseEntries\s*\(\s*/g) as any;
  if (
    !props ||
    !props.submitted_games ||
    typeof props.submitted_games !== "object" ||
    Array.isArray(props.submitted_games)
  )
    throw new Error("itch.io did not include your submitted-game list");
  const ids = Object.keys(props.submitted_games).map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new Error("itch.io returned an invalid submitted-game list");
  return { gameIds: ids.filter((id) => props.submitted_games[String(id)]) };
}

export function parseCommentAuthorIds(html: string): number[] {
  return [...parseCommentPosts(html).authorIds];
}

function parseCommentPosts(html: string): {
  postIds: Set<number>;
  authorIds: Set<number>;
  invalid: boolean;
} {
  const postIds = new Set<number>();
  const authorIds = new Set<number>();
  let invalid = false;
  for (const m of html.matchAll(/data-post='([^']*)'|data-post="([^"]*)"/gi)) {
    try {
      const raw = (m[1] ?? m[2])
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
      const data = JSON.parse(raw);
      const post = Number(data.id),
        author = Number(data.user_id);
      if (
        !Number.isSafeInteger(post) ||
        post <= 0 ||
        !Number.isSafeInteger(author) ||
        author <= 0
      ) {
        invalid = true;
        continue;
      }
      postIds.add(post);
      authorIds.add(author);
    } catch {
      invalid = true;
    }
  }
  return { postIds, authorIds, invalid };
}

export function nextCommentPage(
  html: string,
  current: string,
  first: string
): string | undefined {
  const pager = html.match(
    /<div\b[^>]*class="[^"]*topic_pager[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  const match = pager?.match(
    /<a\b[^>]*class="[^"]*page_link[^"]*"[^>]*href="([^"]+)"[^>]*>\s*Next page\s*<\/a>/i
  );
  if (!match) return undefined;
  try {
    const url = new URL(match[1], current),
      base = new URL(first);
    if (
      url.origin !== "https://itch.io" ||
      url.pathname !== base.pathname ||
      normalizeSubmissionUrl(base.href) !== first
    )
      return undefined;
    const before = Number(url.searchParams.get("before"));
    const previous = new URL(current).searchParams.get("before");
    if (
      !Number.isSafeInteger(before) ||
      before <= 0 ||
      (previous && before >= Number(previous))
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function parsePagerRangeEnd(pager: string): number | undefined {
  const match = pager.match(
    /Viewing comments\s*(?:<nobr>)?\s*(?:<span>\s*)?[0-9]+(?:\s*<\/span>)?\s*to\s*(?:<span>\s*)?([0-9]+)/i
  );
  const end = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(end) && end > 0 ? end : undefined;
}

function assignedJson(html: string, re: RegExp): unknown {
  re.lastIndex = 0;
  const match = re.exec(html);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let depth = 0,
    string = false,
    escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (string) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') string = false;
      continue;
    }
    if (c === '"') string = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error("itch.io returned incomplete jam data");
}

async function fetchPage(url: string): Promise<string> {
  const { session } = await import("electron");
  return responseText(
    await session.defaultSession.fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
  );
}

async function responseText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`itch.io returned HTTP ${response.status}`);
  const len = Number(response.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BYTES)
    throw new Error("itch.io page exceeded size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("itch.io page exceeded size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
