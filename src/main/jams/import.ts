import {
  JamEntry,
  JamWorkspace,
  normalizeGameUrl,
  normalizeJamUrl,
  parseJamSubmissionMetadata,
} from "common/jams/model";

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

interface JamEntriesPage {
  title: string;
  entriesUrl: string;
}

/** Import the public submissions listed by an itch.io jam. */
export async function importJam(url: string): Promise<JamWorkspace> {
  // Keep the Electron-only request module out of pure parser/test imports.
  const { request } = await import("main/net/request");
  const canonicalUrl = normalizeJamUrl(url);
  if (!canonicalUrl) {
    throw new Error(
      "Enter a public itch.io jam URL such as https://itch.io/jam/my-jam"
    );
  }

  const pageResponse = await request("get", `${canonicalUrl}/entries`, {});
  assertSuccess(pageResponse.statusCode, "jam entries page");
  const html = requireTextBody(pageResponse.body, "jam entries page");
  assertResponseSize(html, "jam entries page");
  const page = parseJamEntriesPage(html, canonicalUrl);

  // The app's main-process request session has no per-user itch.io cookies.
  // The public entries endpoint is therefore the supported import source.
  const entriesResponse = await request("get", page.entriesUrl, {});
  assertSuccess(entriesResponse.statusCode, "public jam entries");
  const json = requireJsonBody(entriesResponse.body, "public jam entries");
  assertResponseSize(json, "public jam entries");

  return {
    id: new URL(canonicalUrl).pathname.split("/")[2],
    url: canonicalUrl,
    title: page.title,
    entries: parseJamEntriesResponse(json, canonicalUrl),
  };
}

/** Extract the jam title and entries endpoint from itch's page bootstrap data. */
export function parseJamEntriesPage(
  html: string,
  jamUrl: string
): JamEntriesPage {
  const canonicalUrl = normalizeJamUrl(jamUrl);
  if (!canonicalUrl) throw new Error("Invalid itch.io jam URL");

  const titleMatch = html.match(
    /<h1\b[^>]*class="[^"]*\bjam_title_header\b[^"]*"[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>\s*<\/h1>/i
  );
  if (!titleMatch)
    throw new Error(
      "Could not read the jam title from itch.io's entries page; the jam may be private, unavailable, or require sign-in"
    );
  const title = decodeHtmlText(titleMatch[1].replace(/<[^>]*>/g, "")).trim();
  if (!title)
    throw new Error("The itch.io entries page did not contain a jam title");

  const entriesUrlMatch = html.match(/"entries_url"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (!entriesUrlMatch) {
    throw new Error(
      "The itch.io entries page did not expose its public entries list"
    );
  }

  let entriesUrl: unknown;
  try {
    entriesUrl = JSON.parse(entriesUrlMatch[1]);
  } catch {
    throw new Error("The itch.io entries page exposed an invalid entries URL");
  }

  // Restrict redirects/embedded config to the exact public JSON route on itch.io.
  // The numeric jam id is intentionally distinct from the readable jam slug.
  const endpointMatch =
    typeof entriesUrl === "string" &&
    entriesUrl.match(/^\/jam\/([1-9][0-9]*)\/entries\.json$/);
  if (!endpointMatch) {
    throw new Error(
      "The itch.io entries page exposed an unsupported entries URL"
    );
  }

  const headerSlug = html.match(
    /<h1\b[^>]*class="[^"]*\bjam_title_header\b[^"]*"[^>]*>\s*<a\b[^>]*href="\/jam\/([a-z0-9-]+)"/i
  )?.[1];
  const expectedSlug = new URL(canonicalUrl).pathname.split("/")[2];
  if (headerSlug !== expectedSlug) {
    throw new Error(
      "The returned itch.io page did not match the requested jam"
    );
  }

  return {
    title,
    entriesUrl: `https://itch.io/jam/${endpointMatch[1]}/entries.json`,
  };
}

/** Validate and map the complete array returned by itch.io's entries JSON. */
export function parseJamEntriesResponse(
  input: unknown,
  jamUrl: string
): JamEntry[] {
  const canonicalUrl = normalizeJamUrl(jamUrl);
  if (!canonicalUrl) throw new Error("Invalid itch.io jam URL");
  if (!isRecord(input) || !Array.isArray(input.jam_games)) {
    throw new Error("itch.io returned an invalid jam entries response");
  }
  if (input.jam_games.length > MAX_ENTRIES) {
    throw new Error(`itch.io returned more than ${MAX_ENTRIES} jam entries`);
  }

  const entries: JamEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.jam_games.entries()) {
    if (!isRecord(raw) || !isRecord(raw.game)) {
      throw new Error(`Jam entry ${index + 1} is missing its game data`);
    }
    const game = raw.game;
    if (
      typeof game.id !== "number" ||
      !Number.isSafeInteger(game.id) ||
      game.id <= 0 ||
      typeof game.title !== "string" ||
      game.title.trim().length === 0
    ) {
      throw new Error(`Jam entry ${index + 1} has invalid game metadata`);
    }

    const submissionUrl = normalizeSubmissionUrlIfSafe(raw.url);
    if (!submissionUrl) {
      throw new Error(`Jam entry ${index + 1} has an invalid submission URL`);
    }
    const normalizedGameUrl = normalizeGameUrl(game.url);
    const metadata = parseJamSubmissionMetadata({
      url: submissionUrl,
      gameId: game.id,
      title: game.title,
      ...(normalizedGameUrl ? { gameUrl: normalizedGameUrl } : {}),
      coverUrl: game.cover,
      shortText: game.short_text,
      platforms: game.platforms,
      tags: game.tags,
      ratingCount: raw.rating_count,
      coolness: raw.coolness,
      jamEntryId: raw.id,
      popularityRank: index,
    });
    if (
      !metadata ||
      metadata.jamUrl !== canonicalUrl ||
      metadata.submissionId !== String(game.id)
    ) {
      throw new Error(
        `Jam entry ${index + 1} does not match the requested jam or game`
      );
    }
    if (seen.has(metadata.submissionId)) continue;
    seen.add(metadata.submissionId);
    entries.push({
      submissionId: metadata.submissionId,
      submissionUrl: metadata.submissionUrl,
      gameId: metadata.gameId,
      title: metadata.title,
      gameUrl: metadata.gameUrl,
      ...(metadata.coverUrl ? { coverUrl: metadata.coverUrl } : {}),
      ...(metadata.shortText ? { shortText: metadata.shortText } : {}),
      ...(metadata.platforms ? { platforms: metadata.platforms } : {}),
      ...(metadata.tags ? { tags: metadata.tags } : {}),
      ...(metadata.ratingCount !== undefined
        ? { ratingCount: metadata.ratingCount }
        : {}),
      ...(metadata.coolness !== undefined
        ? { coolness: metadata.coolness }
        : {}),
      ...(metadata.jamEntryId !== undefined
        ? { jamEntryId: metadata.jamEntryId }
        : {}),
      popularityRank: index,
    });
  }

  return entries;
}

function normalizeSubmissionUrlIfSafe(input: unknown): string | undefined {
  if (typeof input !== "string" || !input.startsWith("/jam/")) return undefined;
  try {
    return new URL(input, "https://itch.io").href;
  } catch {
    return undefined;
  }
}

function decodeHtmlText(input: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
    nbsp: " ",
  };
  return input.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, code: string) => {
      if (code[0] === "#") {
        const hex = code[1]?.toLowerCase() === "x";
        const number = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isInteger(number) && number >= 0 && number <= 0x10ffff
          ? String.fromCodePoint(number)
          : entity;
      }
      return namedEntities[code.toLowerCase()] ?? entity;
    }
  );
}

function requireTextBody(body: unknown, label: string): string {
  if (typeof body !== "string")
    throw new Error(`itch.io returned an invalid ${label}`);
  return body;
}

function requireJsonBody(body: unknown, label: string): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`itch.io returned invalid JSON for ${label}`);
  }
}

function assertResponseSize(body: unknown, label: string) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  if (typeof serialized !== "string")
    throw new Error(`itch.io returned an invalid ${label} response`);
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > MAX_RESPONSE_BYTES) {
    throw new Error(
      `itch.io's ${label} response exceeded the ${
        MAX_RESPONSE_BYTES / 1024 / 1024
      } MB limit`
    );
  }
}

function assertSuccess(statusCode: number, label: string) {
  if (statusCode < 200 || statusCode >= 300) {
    const note =
      statusCode === 401 || statusCode === 403 || statusCode === 404
        ? " This jam may be private, unavailable, or require an itch.io sign-in."
        : "";
    throw new Error(
      `Could not fetch ${label} from itch.io (HTTP ${statusCode}).${note}`
    );
  }
}

function isRecord(input: unknown): input is Record<string, any> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
