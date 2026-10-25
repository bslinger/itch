import {
  JamEntry,
  normalizeJamUrl,
  normalizeSubmissionUrl,
  normalizeJamUserUrl,
} from "common/jams/model";
import { partitionForUser } from "common/util/partition-for-user";
import { scheduleJamRequest } from "main/jams/comment-requests";
import { CommentPageCache } from "main/jams/comment-page-cache";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_AUTHOR_PROFILES = 100;
const MAX_TEAM_HOMEPAGES = 500;

export async function fetchJamCommentCount(
  submissionUrl: string,
  options?: { fresh?: boolean }
): Promise<number> {
  return publicCommentReaders.count(submissionUrl, options);
}

export function parseJamCommentCount(
  html: string,
  submissionUrl: string
): number {
  const canonical = normalizeSubmissionUrl(submissionUrl);
  if (!canonical) throw new Error("Invalid jam submission URL");
  validateCommentPageIdentity(html, canonical);
  const pager = parsePagerTotal(html);
  if (pager !== undefined) return pager;
  if (hasCommentPager(html))
    throw new Error("itch.io's comment pager could not be read");
  const topLevel = parseCommentPosts(html).topLevelPostIds;
  if (topLevel !== undefined) {
    if (topLevel.size === 0) {
      let rawTotal: number | undefined;
      try {
        rawTotal = parseRawJamCommentTotal(html, canonical);
      } catch {
        /* Empty threads omit JSON-LD. */
      }
      if (rawTotal !== undefined && rawTotal > 0)
        throw new Error(
          "The empty comment list disagreed with the comment total"
        );
    }
    return topLevel.size;
  }
  // JSON-LD includes replies, so it can establish only an explicit zero.
  // Without a reliable top-level source, a positive total remains unknown.
  if (parseRawJamCommentTotal(html, canonical) === 0) return 0;
  throw new Error("itch.io did not provide a top-level comment count");
}

function parseRawJamCommentTotal(html: string, canonical: string): number {
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

function parsePagerTotal(html: string): number | undefined {
  const pager = html.match(
    /<div\b[^>]*class=["'][^"']*\btopic_pager\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  const match = pager?.match(
    /Viewing comments[\s\S]*?\bof\s*(?:<span>\s*)?(\d+)/i
  );
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function hasCommentPager(html: string): boolean {
  return /<div\b[^>]*class=["'][^"']*\btopic_pager\b[^"']*["']/i.test(html);
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
  let hasDiscussion = false;
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      for (const value of Array.isArray(data) ? data : [data]) {
        if (value?.["@type"] === "DiscussionForumPosting") hasDiscussion = true;
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
  if (hasDiscussion)
    throw new Error("The returned page did not match the requested submission");
  // Empty threads omit JSON-LD. Verify both the jam header and the game's
  // JSON bootstrap before accepting the comment list on that page.
  const route = new URL(canonical).pathname.split("/");
  const title = html.match(
    /<h1\b[^>]*class=["'][^"']*\bjam_title_header\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']\/jam\/([a-z0-9-]+)["']/i
  );
  if (title?.[1] === route[2]) {
    try {
      const initializer =
        /\binit_JamRateGame\s*\(\s*(['"])(#jam_rate_game_[0-9]+)\1\s*,\s*/g;
      const selector = initializer.exec(html)?.[2];
      const game = assignedJson(html, initializer) as
        | { id?: unknown }
        | undefined;
      if (
        selector &&
        new RegExp(`<[^/!][^>]*\\bid=["']${selector.slice(1)}["']`, "i").test(
          html
        ) &&
        typeof game?.id === "number" &&
        Number.isSafeInteger(game.id) &&
        String(game.id) === route[4]
      )
        return;
    } catch {
      /* An unverified page remains unknown. */
    }
  }
  throw new Error("The returned page did not match the requested submission");
}

export interface CreatorCommentScan {
  ownGameIds: number[];
  commenterIds: number[];
  commenterUrls: string[];
  ownTeamIds: number[];
  ownTeamComplete: boolean;
  complete: boolean;
}

export interface JamEntryCommentAuthors {
  ids: number[];
  complete: boolean;
}

export function ownSubmissionMapIsComplete(
  entries: JamEntry[],
  userId: number,
  ownGameIds: number[]
): boolean {
  const own = new Set(ownGameIds);
  return !entries.some(
    (entry) => entry.creatorId === userId && !own.has(entry.gameId)
  );
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
    await scheduleJamRequest(() =>
      accountSession.fetch(`${canonical}/entries`, {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      })
    )
  );
  const validated = validateOwnedGames(first, canonical, userId);
  const ownGameIds = validated.gameIds;
  const commenterIds = new Set<number>();
  const commenterUrls = new Set<string>();
  const teamIds = new Set<number>([userId]);
  const teamUrlById = new Map<number, string>();
  const resolvedHomeIds = new Map<string, number | undefined>();
  const knownCreatorHomes = new Map<number, string>();
  for (const entry of knownEntries) {
    const home = normalizeJamUserUrl(entry.creatorUrl);
    if (entry.creatorId && home) knownCreatorHomes.set(entry.creatorId, home);
  }
  let teamHomeLookupCount = 0;
  let complete = true;
  let ownTeamComplete = ownSubmissionMapIsComplete(
    knownEntries,
    userId,
    ownGameIds
  );
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
      ownTeamComplete = false;
      continue;
    }
    const entry = knownEntries.find((candidate) => candidate.gameId === gameId);
    if (
      !Number.isSafeInteger(entry?.creatorId) ||
      (entry?.creatorId ?? 0) <= 0 ||
      !entry?.creatorUrl ||
      entry.contributorUrlsComplete !== true
    )
      ownTeamComplete = false;
    if (entry?.creatorId && entry.creatorUrl) {
      const home = normalizeJamUserUrl(entry.creatorUrl);
      if (home) {
        teamIds.add(entry.creatorId);
        teamUrlById.set(entry.creatorId, home);
        resolvedHomeIds.set(home, entry.creatorId);
      } else ownTeamComplete = false;
    }
    for (const creatorUrl of entry?.contributorUrls || []) {
      const home = normalizeJamUserUrl(creatorUrl);
      if (!home) {
        ownTeamComplete = false;
        continue;
      }
      try {
        let contributorId = resolvedHomeIds.get(home);
        if (contributorId === undefined && !resolvedHomeIds.has(home)) {
          if (teamHomeLookupCount >= MAX_TEAM_HOMEPAGES) {
            ownTeamComplete = false;
            continue;
          }
          teamHomeLookupCount += 1;
          contributorId = await resolveHomepageUserId(home);
          resolvedHomeIds.set(home, contributorId);
        }
        if (!contributorId) {
          ownTeamComplete = false;
          continue;
        }
        teamIds.add(contributorId);
        teamUrlById.set(contributorId, home);
      } catch {
        ownTeamComplete = false;
      }
    }
  }
  let authorLookupCount = 0;
  const resolvedCommenterHomes = new Map<number, string | undefined>();
  for (const gameId of ownGameIds) {
    const entryUrl = entriesByGame.get(gameId);
    if (!entryUrl || !entryUrl.startsWith(`${canonical}/rate/`)) continue;
    try {
      const scan = await scanJamEntryComments(entryUrl, async (pageUrl) =>
        responseText(
          await scheduleJamRequest(() =>
            accountSession.fetch(pageUrl, {
              credentials: "include",
              redirect: "error",
              signal: AbortSignal.timeout(20_000),
            })
          )
        )
      );
      scan.commenterIds.forEach((id) => commenterIds.add(id));
      for (const author of scan.authorProfiles) {
        const knownHome =
          teamUrlById.get(author.userId) ||
          knownCreatorHomes.get(author.userId);
        if (knownHome) {
          commenterUrls.add(knownHome);
          continue;
        }
        if (resolvedCommenterHomes.has(author.userId)) {
          const cachedHome = resolvedCommenterHomes.get(author.userId);
          if (cachedHome) commenterUrls.add(cachedHome);
          else complete = false;
          continue;
        }
        if (authorLookupCount >= MAX_AUTHOR_PROFILES) {
          complete = false;
          resolvedCommenterHomes.set(author.userId, undefined);
          continue;
        }
        authorLookupCount += 1;
        try {
          const home = await resolveProfileHomepage(
            author.profileUrl,
            author.userId
          );
          resolvedCommenterHomes.set(author.userId, home);
          if (home) commenterUrls.add(home);
          else complete = false;
        } catch {
          complete = false;
        }
      }
      complete &&= scan.complete;
    } catch {
      complete = false;
    }
  }
  return {
    ownGameIds,
    commenterIds: [...commenterIds],
    commenterUrls: [...commenterUrls],
    ownTeamIds: [...teamIds],
    ownTeamComplete,
    complete,
  };
}

export async function fetchJamEntryCommentAuthors(
  submissionUrl: string,
  options?: { fresh?: boolean }
): Promise<JamEntryCommentAuthors> {
  return publicCommentReaders.authors(submissionUrl, options);
}

async function resolveHomepageUserId(
  homeUrl: string
): Promise<number | undefined> {
  const home = normalizeJamUserUrl(homeUrl);
  if (!home) return undefined;
  const html = await fetchPage(home);
  const data = assignedJson(
    html,
    /\binit_User\s*\(\s*['"][^'"]+['"]\s*,\s*/g
  ) as any;
  const id = Number(data?.user_id);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function resolveProfileHomepage(
  profileUrl: string,
  expectedUserId: number
): Promise<string | undefined> {
  const profile = normalizeCommentProfileUrl(profileUrl);
  if (!profile) return undefined;
  const html = await fetchPage(profile);
  return parseProfileHomepage(html, expectedUserId);
}

export function parseProfileHomepage(
  html: string,
  expectedUserId: number
): string | undefined {
  const userId = html.match(
    /<input\b(?=[^>]*\bname=["']blocked_user_id["'])(?=[^>]*\bvalue=["']([0-9]+)["'])[^>]*>/i
  );
  if (!userId || Number(userId[1]) !== expectedUserId) return undefined;
  for (const match of html.matchAll(
    /<link\b([^>]*\brel=["']canonical["'][^>]*)>/gi
  )) {
    const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const home = normalizeJamUserUrl(href);
    if (home) return home;
  }
  for (const match of html.matchAll(
    /<a\b([^>]*\brel=["'][^"']*\bme\b[^"']*["'][^>]*)>/gi
  )) {
    const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const home = normalizeJamUserUrl(href);
    if (home) return home;
  }
  return undefined;
}

function normalizeCommentProfileUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, "https://itch.io");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "itch.io" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/profile\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    )
      return undefined;
    return `https://itch.io${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

export async function scanJamEntryComments(
  entryUrl: string,
  loadPage: (url: string) => Promise<string>
): Promise<{
  commenterIds: number[];
  authorProfiles: Array<{ userId: number; profileUrl: string }>;
  complete: boolean;
}> {
  const canonical = normalizeSubmissionUrl(entryUrl);
  if (!canonical) throw new Error("Invalid jam submission URL");
  const commenterIds = new Set<number>(),
    postIds = new Set<number>(),
    authorProfiles = new Map<number, string>(),
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
    const posts = parseCommentPosts(html);
    try {
      // JSON-LD tracks every comment, including replies. This raw total is
      // only for deciding whether the author scan visited every comment ID.
      const count = parseRawJamCommentTotal(html, canonical);
      if (expectedCount === undefined) expectedCount = count;
      else if (expectedCount !== count) complete = false;
    } catch {
      if (
        posts.topLevelPostIds?.size === 0 &&
        posts.postIds.size === 0 &&
        !posts.invalid &&
        expectedCount === undefined &&
        (!hasCommentPager(html) || parsePagerTotal(html) === 0)
      )
        expectedCount = 0;
      else complete = false;
    }
    posts.postIds.forEach((id) => postIds.add(id));
    posts.authorIds.forEach((id) => commenterIds.add(id));
    posts.authorProfiles.forEach((profile, id) =>
      authorProfiles.set(id, profile)
    );
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
  if (
    pageUrl ||
    expectedCount === undefined ||
    expectedCount !== postIds.size ||
    [...commenterIds].some((id) => !authorProfiles.has(id))
  )
    complete = false;
  return {
    commenterIds: [...commenterIds],
    authorProfiles: [...authorProfiles].map(([userId, profileUrl]) => ({
      userId,
      profileUrl,
    })),
    complete,
  };
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

export function parseCommentAuthorProfiles(
  html: string
): Array<{ userId: number; profileUrl: string }> {
  return [...parseCommentPosts(html).authorProfiles].map(
    ([userId, profileUrl]) => ({ userId, profileUrl })
  );
}

function parseCommentPosts(html: string): {
  postIds: Set<number>;
  authorIds: Set<number>;
  authorProfiles: Map<number, string>;
  topLevelPostIds: Set<number> | undefined;
  invalid: boolean;
} {
  const postIds = new Set<number>();
  const authorIds = new Set<number>();
  const authorProfiles = parseCommentAuthorProfilesInPostTree(html);
  const topLevelPostIds = new Set<number>();
  let sawCommentList = false;
  let commentListClosed = false;
  let invalid = false;
  const divStack: string[][] = [];
  for (const token of html.matchAll(/<div\b[^>]*>|<\/div\s*>/gi)) {
    const tag = token[0];
    if (/^<\//.test(tag)) {
      const closed = divStack.pop();
      if (closed?.includes("community_post_list_widget"))
        commentListClosed = true;
      continue;
    }
    const classes =
      tag.match(/\bclass=["']([^"']*)["']/i)?.[1]?.split(/\s+/) || [];
    if (classes.includes("community_post_list_widget")) sawCommentList = true;
    const inCommentList = divStack.some((ancestor) =>
      ancestor.includes("community_post_list_widget")
    );
    const nestedPost = divStack.some(
      (ancestor) =>
        ancestor.includes("community_post") ||
        ancestor.includes("community_post_replies") ||
        ancestor.includes("top_level_replies")
    );
    const postAttribute = tag.match(/\bdata-post=(?:'([^']*)'|"([^"]*)")/i);
    if (postAttribute) {
      try {
        const raw = (postAttribute[1] ?? postAttribute[2])
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&");
        const data = JSON.parse(raw);
        const postId = Number(data.id),
          author = Number(data.user_id);
        if (
          !Number.isSafeInteger(postId) ||
          postId <= 0 ||
          !Number.isSafeInteger(author) ||
          author <= 0
        ) {
          invalid = true;
        } else {
          postIds.add(postId);
          authorIds.add(author);
          if (
            inCommentList &&
            classes.includes("community_post") &&
            !classes.includes("is_reply") &&
            !nestedPost
          )
            topLevelPostIds.add(postId);
        }
      } catch {
        invalid = true;
      }
    }
    if (!/\/>$/.test(tag)) divStack.push(classes);
  }
  return {
    postIds,
    authorIds,
    authorProfiles,
    topLevelPostIds:
      sawCommentList && commentListClosed && !invalid
        ? topLevelPostIds
        : undefined,
    invalid,
  };
}

function parseCommentAuthorProfilesInPostTree(
  html: string
): Map<number, string> {
  const profiles = new Map<number, string>();
  const stack: Array<{ classes: string[]; userId?: number }> = [];
  for (const token of html.matchAll(
    /<div\b[^>]*>|<span\b[^>]*>|<a\b[^>]*>|<\/(?:div|span)\s*>/gi
  )) {
    const tag = token[0];
    if (/^<\//.test(tag)) {
      stack.pop();
      continue;
    }
    if (/^<a\b/i.test(tag)) {
      if (!stack.some((frame) => frame.classes.includes("post_author")))
        continue;
      const post = [...stack]
        .reverse()
        .find((frame) => frame.userId !== undefined);
      if (post?.userId === undefined) continue;
      const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const profile = normalizeCommentProfileUrl(href?.replace(/&amp;/g, "&"));
      if (profile) profiles.set(post.userId, profile);
      continue;
    }
    const classes =
      tag.match(/\bclass=["']([^"']*)["']/i)?.[1]?.split(/\s+/) || [];
    let userId: number | undefined;
    const postAttribute = tag.match(/\bdata-post=(?:'([^']*)'|"([^"]*)")/i);
    if (postAttribute) {
      try {
        const raw = (postAttribute[1] ?? postAttribute[2])
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&");
        const data = JSON.parse(raw);
        const id = Number(data.id),
          author = Number(data.user_id);
        if (
          Number.isSafeInteger(id) &&
          id > 0 &&
          Number.isSafeInteger(author) &&
          author > 0
        )
          userId = author;
      } catch {
        /* The author ID parser marks malformed posts incomplete. */
      }
    }
    if (!/\/>$/.test(tag)) stack.push({ classes, userId });
  }
  return profiles;
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

/** Only validated, credential-free submission pages enter the shared cache. */
export function createPublicCommentPageLoader(
  load: (url: string) => Promise<string>,
  cache = new CommentPageCache()
) {
  return async (
    input: string,
    options?: { fresh?: boolean }
  ): Promise<string> => {
    const url = new URL(input);
    const canonical = normalizeSubmissionUrl(`${url.origin}${url.pathname}`);
    const query = [...url.searchParams];
    if (
      !canonical ||
      url.username ||
      url.password ||
      url.port ||
      query.length > 1 ||
      query.some(
        ([key, value]) =>
          key !== "before" ||
          !/^[1-9][0-9]*$/.test(value) ||
          !Number.isSafeInteger(Number(value))
      )
    )
      throw new Error("Invalid public comment page URL");
    url.hash = "";
    return cache.get(
      url.href,
      async () => {
        const html = await load(url.href);
        validateCommentPageIdentity(html, canonical);
        return html;
      },
      options
    );
  };
}

/** Count and author readers share downloads, but failed parses must be retryable. */
export function createPublicCommentReaders(
  load: (url: string) => Promise<string>,
  cache = new CommentPageCache()
) {
  const page = createPublicCommentPageLoader(load, cache);
  const invalidate = (input: string) => {
    const url = new URL(input);
    url.hash = "";
    cache.invalidate(url.href);
  };
  return {
    async count(input: string, options?: { fresh?: boolean }): Promise<number> {
      const canonical = normalizeSubmissionUrl(input);
      if (!canonical) throw new Error("Invalid jam submission URL");
      try {
        return parseJamCommentCount(await page(canonical, options), canonical);
      } catch (error) {
        invalidate(canonical);
        throw error;
      }
    },
    async authors(
      input: string,
      options?: { fresh?: boolean }
    ): Promise<JamEntryCommentAuthors> {
      const pages = new Set<string>();
      const scan = await scanJamEntryComments(input, async (url) => {
        pages.add(url);
        return page(url, options);
      });
      if (!scan.complete) pages.forEach(invalidate);
      return { ids: scan.commenterIds, complete: scan.complete };
    },
  };
}

const publicCommentReaders = createPublicCommentReaders(fetchPage);

async function fetchPage(url: string): Promise<string> {
  const { session } = await import("electron");
  return responseText(
    await scheduleJamRequest(() =>
      session.defaultSession.fetch(url, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      })
    )
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
