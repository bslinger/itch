import { GameType } from "common/butlerd/messages";
import { JamEntry } from "common/jams/model";
import { JamSession } from "common/jams/state";

export type JamSort =
  | "popular"
  | "random"
  | "most_karma"
  | "least_ratings"
  | "most_ratings"
  | "most_comments"
  | "least_comments"
  | "created_at_asc"
  | "created_at_desc";
export type JamRatingFilter = "all" | "unrated" | "rated";
export type JamPlatformFilter = "" | "web" | "windows" | "osx" | "linux";
export type JamInstallFilter =
  | "all"
  | "ready"
  | "not-installed"
  | "kept"
  | "attention";

export interface JamListingOptions {
  search: string;
  sort: JamSort;
  rating: JamRatingFilter;
  platform: JamPlatformFilter;
  installation: JamInstallFilter;
  /** Seed for stable random ordering, generally changed only by an explicit shuffle. */
  randomSeed: number;
}

function knownNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function jamKarma(entry: JamEntry): number | undefined {
  if (
    !knownNonNegative(entry.coolness) ||
    !knownNonNegative(entry.ratingCount)
  ) {
    return undefined;
  }
  return (
    Math.log(1 + entry.coolness) - Math.log(1 + entry.ratingCount) / Math.log(5)
  );
}

/** Current counts exclude nested replies and sibling reply groups. */
export function jamCommentCount(
  jam: JamSession,
  entry: JamEntry
): number | undefined {
  const progress = jam.progress[entry.submissionId];
  return progress?.commentCountVersion === 3 &&
    knownNonNegative(progress.commentCount)
    ? progress.commentCount
    : undefined;
}

function seededHash(gameId: number, seed: number): number {
  // FNV-1a over the textual pair gives a cheap, stable order across runtimes.
  const value = `${Number.isFinite(seed) ? seed : 0}:${gameId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function entryPlatforms(entry: JamEntry, jam: JamSession): Set<string> {
  const platforms = new Set(entry.platforms || []);
  const game = jam.progress[entry.submissionId]?.game;
  if (game?.type === GameType.HTML) platforms.add("web");
  if (game?.platforms) {
    for (const platform of ["windows", "osx", "linux"] as const) {
      if (game.platforms[platform]) platforms.add(platform);
    }
  }
  return platforms;
}

function matchesInstallation(
  entry: JamEntry,
  jam: JamSession,
  filter: JamInstallFilter
): boolean {
  if (filter === "all") return true;
  const progress = jam.progress[entry.submissionId];
  switch (filter) {
    case "ready":
      return progress?.status === "ready";
    case "kept":
      return progress?.kept === true;
    case "attention":
      return progress?.status === "attention";
    case "not-installed":
      // Queued/checking entries are in flight, so they are not reported as
      // not installed while their local state is still being determined.
      return (
        !progress || !["ready", "queued", "checking"].includes(progress.status)
      );
  }
}

function compareKnown(
  a: number | undefined,
  b: number | undefined,
  direction: 1 | -1
): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  if (a < b) return -direction;
  if (a > b) return direction;
  return 0;
}

/** Filters and sorts a jam without changing its saved entry order. */
export function filterJamEntries(
  jam: JamSession,
  options: JamListingOptions
): JamEntry[] {
  const source = jam.entries;
  const search = options.search.trim().toLocaleLowerCase();
  const ratedIds = jam.ratings ? new Set(jam.ratings.ratedGameIds) : undefined;

  const filtered = source
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (search) {
        const searchable = [
          entry.title,
          entry.shortText,
          entry.gameUrl,
          entry.submissionId,
          entry.submissionUrl,
          ...(entry.tags || []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        if (!searchable.includes(search)) return false;
      }
      if (
        options.platform &&
        !entryPlatforms(entry, jam).has(options.platform)
      ) {
        return false;
      }
      if (!matchesInstallation(entry, jam, options.installation)) return false;
      if (options.rating === "rated") {
        if (!ratedIds?.has(entry.gameId)) return false;
      } else if (options.rating === "unrated") {
        // Without a successful ratings snapshot we cannot infer that a game
        // has not been rated from local play or installation state.
        if (!ratedIds || ratedIds.has(entry.gameId)) return false;
      }
      return true;
    });

  const sorted = [...filtered];
  sorted.sort((left, right) => {
    const a = left.entry;
    const b = right.entry;
    let order = 0;
    switch (options.sort) {
      case "popular":
        // An explicit feed rank wins; otherwise the original feed order is
        // the popularity rank supplied by itch's jam endpoint.
        order = compareKnown(
          a.popularityRank ?? left.index,
          b.popularityRank ?? right.index,
          1
        );
        break;
      case "random":
        order = compareKnown(
          seededHash(a.gameId, options.randomSeed),
          seededHash(b.gameId, options.randomSeed),
          1
        );
        break;
      case "most_karma":
        order = compareKnown(jamKarma(a), jamKarma(b), -1);
        break;
      case "least_ratings":
        order = compareKnown(a.ratingCount, b.ratingCount, 1);
        break;
      case "most_ratings":
        order = compareKnown(a.ratingCount, b.ratingCount, -1);
        break;
      case "most_comments":
      case "least_comments":
        order = compareKnown(
          jamCommentCount(jam, a),
          jamCommentCount(jam, b),
          options.sort === "most_comments" ? -1 : 1
        );
        break;
      case "created_at_asc":
        order = compareKnown(a.jamEntryId, b.jamEntryId, 1);
        break;
      case "created_at_desc":
        order = compareKnown(a.jamEntryId, b.jamEntryId, -1);
        break;
    }
    return order || left.index - right.index;
  });
  return sorted.map(({ entry }) => entry);
}
