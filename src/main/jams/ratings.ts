import { normalizeJamUrl } from "common/jams/model";
import { partitionForUser } from "common/util/partition-for-user";

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * Reads the authenticated user's jam ratings from itch's server-rendered
 * JamBrowseEntries props, using the same per-account session as the browser.
 */
export async function fetchJamRatedGames(
  jamUrl: string,
  userId: number
): Promise<number[]> {
  const canonicalUrl = normalizeJamUrl(jamUrl);
  if (!canonicalUrl) throw new Error("Enter a valid itch.io jam URL");
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Sign in to itch.io before syncing jam ratings");
  }

  const { session } = await import("electron");
  const accountSession = session.fromPartition(
    partitionForUser(String(userId)),
    { cache: true }
  );
  let response: Response;
  try {
    response = await accountSession.fetch(`${canonicalUrl}/entries`, {
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(
      "Could not load this jam with your itch.io account. Check your connection and sign-in, then try again."
    );
  }
  if (!response.ok) {
    throw new Error(
      `itch.io returned HTTP ${response.status} while loading your jam ratings. Check your sign-in and try again.`
    );
  }

  const html = await readResponseText(response);
  return parseJamRatedGames(html, canonicalUrl, userId);
}

/** Parses only JSON bootstrap data; it never evaluates page-provided code. */
export function parseJamRatedGames(
  html: string,
  jamUrl: string,
  userId: number
): number[] {
  const canonicalUrl = normalizeJamUrl(jamUrl);
  if (!canonicalUrl) throw new Error("Invalid itch.io jam URL");
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Invalid itch.io account id");
  }

  const titleMatch = html.match(
    /<h1\b[^>]*class="[^"]*\bjam_title_header\b[^"]*"[^>]*>\s*<a\b[^>]*href="\/jam\/([a-z0-9-]+)"/i
  );
  const expectedSlug = new URL(canonicalUrl).pathname.split("/")[2];
  if (!titleMatch || titleMatch[1] !== expectedSlug) {
    throw new Error(
      "The returned itch.io page did not match the requested jam"
    );
  }

  const currentUser = readAssignedJson(html, /\bI\.current_user\s*=\s*/g);
  if (!isRecord(currentUser) || currentUser.id !== userId) {
    throw new Error(
      "itch.io did not confirm the signed-in account for this jam. Sign in again and retry the ratings sync."
    );
  }

  const props = readAssignedJson(html, /\bR\.Jam\.BrowseEntries\s*\(\s*/g);
  if (!isRecord(props) || !isRecord(props.rated_games)) {
    throw new Error(
      "itch.io did not include your rated-game list for this jam. Open the jam in itch.io and try syncing again."
    );
  }

  const ratedGames: number[] = [];
  for (const [rawGameId, rated] of Object.entries(props.rated_games)) {
    const gameId = Number(rawGameId);
    if (!/^[1-9][0-9]*$/.test(rawGameId) || !Number.isSafeInteger(gameId)) {
      throw new Error("itch.io returned an invalid rated-game list");
    }
    if (rated) ratedGames.push(gameId);
  }
  return ratedGames;
}

function readAssignedJson(html: string, assignment: RegExp): unknown {
  assignment.lastIndex = 0;
  const match = assignment.exec(html);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const first = html[start];
  if (first !== "{" && first !== "[" && !html.startsWith("null", start)) {
    throw new Error("itch.io returned an unsupported jam bootstrap format");
  }

  let end: number;
  if (first === "{") end = findJsonEnd(html, start, "{", "}");
  else if (first === "[") end = findJsonEnd(html, start, "[", "]");
  else end = start + 4;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    throw new Error("itch.io returned malformed jam bootstrap data");
  }
}

function findJsonEnd(
  input: string,
  start: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index + 1;
  }
  throw new Error("itch.io returned incomplete jam bootstrap data");
}

async function readResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("The itch.io jam page exceeded the 25 MB size limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The itch.io jam page exceeded the 25 MB size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
