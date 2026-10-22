import {
  JamSort,
  JamRatingFilter,
  JamPlatformFilter,
  JamInstallFilter,
} from "common/jams/listing";
import { JamSession } from "common/jams/state";

export interface JamReturnContext {
  jamId: string;
  search: string;
  sort: JamSort;
  rating: JamRatingFilter;
  platform: JamPlatformFilter;
  installation: JamInstallFilter;
  page: number;
  randomSeed: number;
  scrollTop: number;
}

const keyFor = (tab: string, profileId: number) =>
  `itch:jam-return:${encodeURIComponent(tab)}:${profileId}`;
const memoryContexts = new Map<string, JamReturnContext>();

export function saveJamReturnContext(
  tab: string,
  profileId: number,
  context: JamReturnContext
) {
  const key = keyFor(tab, profileId);
  memoryContexts.set(key, context);
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(key, JSON.stringify(context));
    }
  } catch (_) {
    // Storage can be disabled or full; the listing remains usable without it.
  }
}

export function readJamReturnContext(
  tab: string,
  profileId: number | null | undefined
): JamReturnContext | undefined {
  if (profileId == null) return undefined;
  const key = keyFor(tab, profileId);
  let value: any;
  try {
    if (typeof sessionStorage !== "undefined") {
      const serialized = sessionStorage.getItem(key);
      if (serialized) value = JSON.parse(serialized);
    }
  } catch (_) {
    // Fall back to this renderer session if storage is unavailable or corrupt.
  }
  value ??= memoryContexts.get(key);
  if (!value) return undefined;
  const validSort = [
    "popular",
    "random",
    "most_karma",
    "least_ratings",
    "most_ratings",
    "most_comments",
    "least_comments",
    "created_at_asc",
    "created_at_desc",
  ];
  const valid =
    typeof value?.jamId === "string" &&
    typeof value.search === "string" &&
    validSort.includes(value.sort) &&
    ["all", "unrated", "rated"].includes(value.rating) &&
    ["", "web", "windows", "osx", "linux"].includes(value.platform) &&
    ["all", "ready", "not-installed", "kept", "attention"].includes(
      value.installation
    ) &&
    Number.isSafeInteger(value.page) &&
    value.page >= 0 &&
    Number.isInteger(value.randomSeed) &&
    value.randomSeed >= 0 &&
    value.randomSeed <= 0xffffffff &&
    Number.isFinite(value.scrollTop) &&
    value.scrollTop >= 0;
  if (!valid) {
    clearJamReturnContext(tab, profileId);
    return undefined;
  }
  return value as JamReturnContext;
}

export function clearJamReturnContext(
  tab: string,
  profileId: number | null | undefined
) {
  if (profileId == null) return;
  const key = keyFor(tab, profileId);
  memoryContexts.delete(key);
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(key);
  } catch (_) {
    // Best effort cleanup.
  }
}

export function isJamReturnContextValid(
  context: JamReturnContext | undefined,
  workspaces: Record<string, JamSession>
): context is JamReturnContext {
  return (
    !!context && Object.prototype.hasOwnProperty.call(workspaces, context.jamId)
  );
}
