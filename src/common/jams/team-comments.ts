import { JamEntry } from "common/jams/model";
import { JamSession } from "common/jams/state";

/** Absence requires a complete team roster and a complete comment scan. */
export function ownTeamCommentStatus(
  jam: JamSession,
  entry: JamEntry
): boolean | undefined {
  const team = jam.creatorComments;
  if (
    !team?.ownTeamComplete ||
    !team.ownGameIds.length ||
    !team.ownTeamIds?.length ||
    team.ownGameIds.includes(entry.gameId)
  )
    return undefined;
  const authors = jam.progress[entry.submissionId]?.commentAuthors;
  if (!authors) return undefined;
  const ids = new Set(team.ownTeamIds);
  if (authors.ids.some((id) => ids.has(id))) return true;
  return authors.complete ? false : undefined;
}
