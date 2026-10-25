export function visibleCommentSyncKey(
  profileId: number,
  jamId: string,
  submissionIds: string[]
): string {
  return `${profileId}:${jamId}:${[...submissionIds].sort().join(",")}`;
}

export function shouldDispatchVisibleCommentSync(options: {
  fresh: boolean;
  commentsSyncing: boolean;
  commentsAllSyncing: boolean;
  nextKey: string;
  previousKey?: string;
}): boolean {
  return (
    !options.commentsAllSyncing &&
    (options.fresh ||
      (!options.commentsSyncing && options.nextKey !== options.previousKey))
  );
}
