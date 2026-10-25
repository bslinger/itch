import { JamSession } from "common/jams/state";

/** Finds the selected Jam entry represented by the current browser/internal URL. */
export function keepEntryForUrl(
  input: string | undefined,
  jam: JamSession | undefined
): string | undefined {
  if (!input || !jam) return undefined;

  if (input.startsWith("itch://")) {
    const game = input.match(/^itch:\/\/games\/([1-9][0-9]*)\/?(?:[?#].*)?$/);
    if (game) {
      const id = Number(game[1]);
      return jam.entries.find((entry) => entry.gameId === id)?.submissionId;
    }
    const cave = input.match(
      /^itch:\/\/caves\/([^/?#]+)(?:\/[^?#]*)?(?:[?#].*)?$/
    );
    if (cave) {
      let caveId: string;
      try {
        caveId = decodeURIComponent(cave[1]);
      } catch {
        return undefined;
      }
      return jam.entries.find(
        (entry) => jam.progress[entry.submissionId]?.caveId === caveId
      )?.submissionId;
    }
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return undefined;
  }

  for (const entry of jam.entries) {
    const submission = parseJamPath(entry.submissionUrl);
    if (submission && sameOriginPath(url, submission, false)) {
      return entry.submissionId;
    }
    const gameUrl =
      entry.gameUrl ?? jam.progress[entry.submissionId]?.game?.url;
    if (!gameUrl) continue;
    const game = parseGamePath(gameUrl);
    if (game && sameOriginPath(url, game, true)) return entry.submissionId;
  }
  return undefined;
}

function parseJamPath(
  input: string
): { origin: string; path: string } | undefined {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "itch.io" ||
      url.port ||
      url.username ||
      url.password
    )
      return undefined;
    return { origin: url.origin, path: trimSlash(url.pathname) };
  } catch {
    return undefined;
  }
}

function parseGamePath(
  input: string
): { origin: string; path: string } | undefined {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.itch\.io$/.test(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return undefined;
    return { origin: url.origin, path: trimSlash(url.pathname) };
  } catch {
    return undefined;
  }
}

function sameOriginPath(
  current: URL,
  target: { origin: string; path: string },
  allowSubpath: boolean
) {
  if (current.origin !== target.origin) return false;
  const path = trimSlash(current.pathname);
  return (
    path === target.path || (allowSubpath && path.startsWith(`${target.path}/`))
  );
}

function trimSlash(path: string) {
  return path.replace(/\/+$/, "") || "/";
}
