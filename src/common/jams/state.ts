import { Game, Upload } from "common/butlerd/messages";
import { JamWorkspace, JamInstallOwnership } from "common/jams/model";

export type JamEntryStatus =
  | "new"
  | "checking"
  | "queued"
  | "ready"
  | "web"
  | "attention"
  | "removed";
export interface JamEntryProgress {
  status: JamEntryStatus;
  message?: string;
  game?: Game;
  uploadId?: number;
  caveId?: string;
  downloadId?: string;
  kept?: boolean;
  candidates?: Upload[];
  commentCount?: number;
  commentsCheckedAt?: number;
}
export interface JamCreatorComments {
  ownGameIds: number[];
  commenterIds: number[];
  syncedAt: number;
  complete: boolean;
}
export interface JamSession extends JamWorkspace {
  progress: { [submissionId: string]: JamEntryProgress };
  importedAt: number;
  ratings?: { ratedGameIds: number[]; syncedAt: number };
  ratingsSyncing?: boolean;
  ratingsError?: string;
  creatorComments?: JamCreatorComments;
  commentsSyncing?: boolean;
  commentsError?: string;
  creatorCommentsSyncing?: boolean;
  creatorCommentsError?: string;
}
export interface JamsState {
  profileId?: number;
  ready: boolean;
  workspaces: { [jamId: string]: JamSession };
  installs: { [caveId: string]: JamInstallOwnership };
  busy?: {
    kind: "import" | "download" | "remove";
    jamId?: string;
    completed: number;
    total: number;
  };
  error?: string;
}
export const emptyJamsState = (): JamsState => ({
  ready: false,
  workspaces: {},
  installs: {},
});
