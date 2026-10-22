import { JamEntry } from "common/jams/model";
import { JamSession } from "common/jams/state";

/** An incomplete scan can confirm a comment, but cannot establish its absence. */
export function creatorCommentStatus(
  entry: Pick<JamEntry, "gameId" | "creatorId">,
  snapshot: JamSession["creatorComments"]
): boolean | undefined {
  if (
    !snapshot?.ownGameIds.length ||
    !entry.creatorId ||
    snapshot.ownGameIds.includes(entry.gameId)
  )
    return undefined;
  if (snapshot.commenterIds.includes(entry.creatorId)) return true;
  return snapshot.complete ? false : undefined;
}
