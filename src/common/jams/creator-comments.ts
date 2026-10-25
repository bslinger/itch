import { JamEntry, normalizeJamUserUrl } from "common/jams/model";
import { JamSession } from "common/jams/state";

/** An incomplete scan can confirm a comment, but cannot establish its absence. */
export function creatorCommentStatus(
  entry: Pick<
    JamEntry,
    | "gameId"
    | "creatorId"
    | "creatorUrl"
    | "contributorUrls"
    | "contributorUrlsComplete"
  >,
  snapshot: JamSession["creatorComments"]
): boolean | undefined {
  if (
    !snapshot?.ownGameIds.length ||
    snapshot.ownGameIds.includes(entry.gameId)
  )
    return undefined;
  if (entry.creatorId && snapshot.commenterIds.includes(entry.creatorId))
    return true;
  const candidateUrls = [entry.creatorUrl, ...(entry.contributorUrls || [])]
    .map(normalizeJamUserUrl)
    .filter((url): url is string => url !== undefined);
  const commenterUrls = snapshot.commenterUrls
    ?.map(normalizeJamUserUrl)
    .filter((url): url is string => url !== undefined);
  if (commenterUrls && candidateUrls.some((url) => commenterUrls.includes(url)))
    return true;
  if (!snapshot.complete || entry.contributorUrlsComplete !== true)
    return undefined;
  // A negative is meaningful only when an ID or comparable profile URL was
  // available on both sides of the scan.
  if (entry.creatorId) return false;
  return candidateUrls.length && commenterUrls ? false : undefined;
}
