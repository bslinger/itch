import {
  Cave,
  Download,
  Game,
  GameType,
  InstallQueueResult,
  Upload,
  UploadType,
} from "common/butlerd/messages";
import { actions } from "common/actions";
import {
  canRemoveJamInstall,
  chooseHtmlFallback,
  chooseNativeUpload,
  JamEntry,
  JamWorkspace,
  parseJamSubmissionMetadata,
  normalizeJamUrl,
} from "common/jams/model";
import {
  emptyJamsState,
  JamEntryProgress,
  JamPersonalRating,
  JamsState,
} from "common/jams/state";
import { Store } from "common/types";

export interface JamServices {
  load(profileId: number): Promise<string | undefined>;
  save(profileId: number, value: string): Promise<void>;
  saveState?(profileId: number, state: JamsState): Promise<void>;
  importJam(url: string): Promise<JamWorkspace>;
  ratedGames?(url: string, profileId: number): Promise<number[]>;
  commentCount?(submissionUrl: string): Promise<number>;
  creatorComments?(
    url: string,
    profileId: number,
    entries: JamWorkspace["entries"]
  ): Promise<{
    ownGameIds: number[];
    commenterIds: number[];
    complete: boolean;
  }>;
  personalRating?(
    submissionUrl: string,
    profileId: number
  ): Promise<Omit<JamPersonalRating, "checkedAt">>;
  game(gameId: number): Promise<Game>;
  uploads(gameId: number): Promise<Upload[]>;
  caves(gameId: number): Promise<Cave[]>;
  downloads(): Promise<Download[]>;
  queue(
    game: Game,
    upload: Upload,
    profileId: number,
    locationId: string
  ): Promise<InstallQueueResult>;
  discard(downloadId: string): Promise<void>;
  uninstall(caveId: string): Promise<void>;
  retry(downloadId: string): Promise<void>;
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One controller serializes bulk work; provenance is saved before advancing. */
export class JamController {
  private cancelled = false;
  private running = false;
  private loadGeneration = 0;
  private ratingsEpoch = 0;
  private ratingsRequests = new Map<string, number>();
  private commentRequests = new Map<string, number>();
  private commentCache = new Map<string, { count: number; at: number }>();
  private commentInFlight = new Map<string, Promise<number>>();
  private commentGeneration = new Map<string, number>();
  private commentActive = 0;
  private commentWaiters: Array<() => void> = [];
  private creatorCommentRequests = new Map<string, number>();
  private myRatingRequests = new Map<string, number>();
  private myRatingCache = new Map<
    string,
    { value: Omit<JamPersonalRating, "checkedAt">; at: number }
  >();
  private myRatingInFlight = new Map<
    string,
    Promise<Omit<JamPersonalRating, "checkedAt">>
  >();
  private allCommentRequests = new Map<string, number>();
  private writeTail: Promise<void> = Promise.resolve();
  constructor(private store: Store, private api: JamServices) {}

  private active(profileId: number) {
    return (
      this.store.getState().profile.profile?.id === profileId &&
      this.store.getState().jams.profileId === profileId
    );
  }
  private check(profileId: number) {
    if (!this.active(profileId) || (this.cancelled && this.running))
      throw new Error("Jam operation stopped.");
  }
  private replace(state: JamsState) {
    this.store.dispatch(actions.jamsReplace({ state }));
  }
  private persist(profileId: number, state: JamsState) {
    const write = this.writeTail
      .catch(() => {})
      .then(() =>
        this.api.saveState
          ? this.api.saveState(profileId, state)
          : this.api.save(
              profileId,
              JSON.stringify({
                version: 1,
                workspaces: state.workspaces,
                installs: state.installs,
              })
            )
      );
    this.writeTail = write;
    return write;
  }
  private async patch(
    profileId: number,
    jamId: string,
    entryId: string,
    patch: Partial<JamEntryProgress>
  ) {
    this.check(profileId);
    this.store.dispatch(
      actions.jamEntryPatch({ profileId, jamId, submissionId: entryId, patch })
    );
    if (patch.status !== "checking")
      await this.persist(profileId, this.store.getState().jams);
  }
  async load() {
    const generation = ++this.loadGeneration;
    const profileId = this.store.getState().profile.profile?.id;
    if (!profileId || this.running || this.store.getState().jams.busy) return;
    ++this.ratingsEpoch;
    this.replace({ ...this.store.getState().jams, ready: false });
    try {
      const raw = await this.api.load(profileId);
      if (
        generation !== this.loadGeneration ||
        this.store.getState().profile.profile?.id !== profileId
      )
        return;
      const state = restoreJamState(raw, profileId);
      this.replace(state);
      await this.reconcile();
    } catch (e) {
      if (
        generation === this.loadGeneration &&
        this.store.getState().profile.profile?.id === profileId
      ) {
        this.replace({
          ...emptyJamsState(),
          profileId,
          ready: true,
          error: `Could not restore jam workspace: ${errorText(e)}`,
        });
      }
    }
  }
  cancel() {
    this.cancelled = true;
  }
  private async run(
    kind: "import" | "download" | "remove",
    jamId: string | undefined,
    total: number,
    work: (profileId: number) => Promise<void>
  ) {
    const state = this.store.getState().jams;
    const profileId = state.profileId;
    if (
      !state.ready ||
      !profileId ||
      !this.active(profileId) ||
      state.busy ||
      this.running
    )
      return;
    this.running = true;
    ++this.loadGeneration;
    this.cancelled = false;
    this.replace({
      ...state,
      error: undefined,
      busy: { kind, jamId, completed: 0, total },
    });
    try {
      await work(profileId);
    } catch (e) {
      if (this.active(profileId))
        this.replace({ ...this.store.getState().jams, error: errorText(e) });
    } finally {
      this.running = false;
      if (this.active(profileId)) {
        this.replace({ ...this.store.getState().jams, busy: undefined });
        // Downloads can finish while preparation owns the workspace lock.
        try {
          await this.reconcile();
        } catch (e) {
          if (this.active(profileId))
            this.replace({
              ...this.store.getState().jams,
              error: `Could not refresh installation status: ${errorText(e)}`,
            });
        }
      } else if (
        this.store.getState().profile.profile &&
        !this.store.getState().jams.ready
      ) {
        await this.load();
      }
    }
  }
  async import(url: string) {
    await this.run("import", undefined, 1, async (profileId) => {
      const jam = await this.api.importJam(url);
      this.check(profileId);
      const state = this.store.getState().jams;
      const existing = state.workspaces[jam.id];
      // Keep old entries too: a withdrawn submission may still own an install.
      const importedIds = new Set(jam.entries.map((e) => e.submissionId));
      const entries = [
        ...jam.entries,
        ...(existing?.entries || []).filter(
          (e) => !importedIds.has(e.submissionId)
        ),
      ];
      const next = {
        ...state,
        workspaces: {
          ...state.workspaces,
          [jam.id]: {
            ...jam,
            entries,
            progress: existing?.progress || {},
            ratings: existing?.ratings,
            creatorComments: existing?.creatorComments,
            importedAt: Date.now(),
          },
        },
      };
      this.replace(next);
      await this.persist(profileId, next);
    });
    const canonical = normalizeJamUrl(url);
    if (canonical)
      await this.syncRatings(new URL(canonical).pathname.split("/")[2]);
  }
  async syncRatings(jamId: string) {
    const state = this.store.getState().jams;
    const profileId = state.profileId;
    const jam = state.workspaces[jamId];
    if (
      !profileId ||
      !state.ready ||
      !jam ||
      !this.active(profileId) ||
      !this.api.ratedGames ||
      jam.ratingsSyncing
    )
      return;
    const key = `${profileId}:${jamId}`;
    const request = (this.ratingsRequests.get(key) || 0) + 1;
    const epoch = this.ratingsEpoch;
    this.ratingsRequests.set(key, request);
    this.replace({
      ...state,
      workspaces: {
        ...state.workspaces,
        [jamId]: { ...jam, ratingsSyncing: true, ratingsError: undefined },
      },
    });
    const current = () =>
      this.active(profileId) &&
      this.ratingsEpoch === epoch &&
      this.ratingsRequests.get(key) === request;
    try {
      const ratedGameIds = await this.api.ratedGames(jam.url, profileId);
      if (!current()) return;
      const latest = this.store.getState().jams;
      const existing = latest.workspaces[jamId];
      if (!existing) return;
      const known = new Set(existing.entries.map((entry) => entry.gameId));
      const ratings = {
        ratedGameIds: [
          ...new Set(
            ratedGameIds.filter(
              (id) => Number.isSafeInteger(id) && known.has(id)
            )
          ),
        ],
        syncedAt: Date.now(),
      };
      const next = {
        ...latest,
        workspaces: {
          ...latest.workspaces,
          [jamId]: {
            ...existing,
            ratings,
            ratingsSyncing: false,
            ratingsError: undefined,
          },
        },
      };
      this.replace(next);
      await this.persist(profileId, next);
    } catch (e) {
      if (!current()) return;
      const latest = this.store.getState().jams;
      if (latest.workspaces[jamId])
        this.replace({
          ...latest,
          workspaces: {
            ...latest.workspaces,
            [jamId]: {
              ...latest.workspaces[jamId],
              ratingsSyncing: false,
              ratingsError: errorText(e),
            },
          },
        });
    }
  }
  async syncMyRatings(jamId: string, submissionIds: string[], fresh = false) {
    const state = this.store.getState().jams;
    const profileId = state.profileId;
    const jam = state.workspaces[jamId];
    if (
      !profileId ||
      !state.ready ||
      !jam ||
      !this.active(profileId) ||
      !jam.ratings ||
      !this.api.personalRating
    )
      return;
    const key = `${profileId}:${jamId}`;
    const request = (this.myRatingRequests.get(key) || 0) + 1;
    const epoch = this.ratingsEpoch;
    this.myRatingRequests.set(key, request);
    const rated = new Set(jam.ratings.ratedGameIds);
    const entries = jam.entries
      .filter(
        (entry) =>
          submissionIds.includes(entry.submissionId) && rated.has(entry.gameId)
      )
      .slice(0, 50);
    this.replace({
      ...state,
      workspaces: {
        ...state.workspaces,
        [jamId]: {
          ...jam,
          myRatingsSyncing: !!entries.length,
          myRatingsError: undefined,
        },
      },
    });
    const current = () =>
      this.active(profileId) &&
      this.ratingsEpoch === epoch &&
      this.myRatingRequests.get(key) === request;
    if (!entries.length) return;
    const completed: Array<[string, JamPersonalRating]> = [];
    const failed: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (
        cursor < entries.length &&
        this.myRatingRequests.get(key) === request
      ) {
        const entry = entries[cursor++];
        const cacheKey = `${profileId}:${epoch}:${entry.submissionUrl}`;
        const cached = this.myRatingCache.get(cacheKey);
        if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) {
          completed.push([
            entry.submissionId,
            { ...cached.value, checkedAt: cached.at },
          ]);
          continue;
        }
        try {
          let pending = fresh ? undefined : this.myRatingInFlight.get(cacheKey);
          if (!pending) {
            pending = (async () => {
              await this.acquireCommentSlot();
              try {
                return await this.api.personalRating!(
                  entry.submissionUrl,
                  profileId
                );
              } finally {
                this.releaseCommentSlot();
              }
            })();
            this.myRatingInFlight.set(cacheKey, pending);
            pending
              .finally(() => {
                if (this.myRatingInFlight.get(cacheKey) === pending)
                  this.myRatingInFlight.delete(cacheKey);
              })
              .catch(() => {});
          }
          const raw = await pending;
          if (!current()) continue;
          if (!isValidPersonalRating(raw)) {
            failed.push(entry.submissionId);
            continue;
          }
          const at = Date.now();
          const value = { ...raw, checkedAt: at };
          this.myRatingCache.set(cacheKey, { value: raw, at });
          completed.push([entry.submissionId, value]);
        } catch {
          failed.push(entry.submissionId);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, worker)
    );
    if (!current()) return;
    const latest = this.store.getState().jams;
    const existing = latest.workspaces[jamId];
    if (!existing) return;
    const progress = { ...existing.progress };
    for (const [submissionId, myRating] of completed) {
      progress[submissionId] = {
        ...(progress[submissionId] || { status: "new" as const }),
        myRating,
      };
    }
    const next = {
      ...latest,
      workspaces: {
        ...latest.workspaces,
        [jamId]: {
          ...existing,
          progress,
          myRatingsSyncing: false,
          myRatingsError: failed.length
            ? `Could not load your saved ratings for ${failed.length} ${
                failed.length === 1 ? "entry" : "entries"
              }. Retry to check them.`
            : undefined,
        },
      },
    };
    this.replace(next);
    await this.persist(profileId, next);
  }
  async syncComments(jamId: string, submissionIds: string[], fresh = false) {
    const state = this.store.getState().jams,
      profileId = state.profileId,
      jam = state.workspaces[jamId];
    if (
      !profileId ||
      !state.ready ||
      !jam ||
      !this.active(profileId) ||
      !this.api.commentCount
    )
      return;
    const key = `${profileId}:${jamId}`,
      request = (this.commentRequests.get(key) || 0) + 1,
      epoch = this.ratingsEpoch;
    this.commentRequests.set(key, request);
    this.commentGeneration.set(key, request);
    const entries = jam.entries
      .filter((e) => submissionIds.includes(e.submissionId))
      .slice(0, 50);
    if (!entries.length) {
      this.replace({
        ...state,
        workspaces: {
          ...state.workspaces,
          [jamId]: { ...jam, commentsSyncing: false },
        },
      });
      return;
    }
    this.replace({
      ...state,
      workspaces: {
        ...state.workspaces,
        [jamId]: { ...jam, commentsSyncing: true, commentsError: undefined },
      },
    });
    const current = () =>
      this.active(profileId) &&
      epoch === this.ratingsEpoch &&
      this.commentRequests.get(key) === request;
    const done: Array<[string, number, number]> = [];
    const failures: string[] = [];
    try {
      let cursor = 0;
      const worker = async () => {
        while (
          cursor < entries.length &&
          this.commentGeneration.get(key) === request
        ) {
          const entry = entries[cursor++];
          const cacheKey = entry.submissionUrl;
          const cached = this.commentCache.get(cacheKey);
          const saved = jam.progress[entry.submissionId];
          const age = Date.now() - (saved?.commentsCheckedAt ?? 0);
          if (
            !fresh &&
            saved?.commentCountVersion === 3 &&
            Number.isSafeInteger(saved.commentCount) &&
            saved.commentCount! >= 0 &&
            saved.commentsCheckedAt &&
            age >= 0 &&
            age < 5 * 60_000
          ) {
            done.push([
              entry.submissionId,
              saved.commentCount!,
              saved.commentsCheckedAt,
            ]);
            continue;
          }
          if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) {
            done.push([entry.submissionId, cached.count, cached.at]);
            continue;
          }
          try {
            let pending = this.commentInFlight.get(cacheKey);
            if (!pending) {
              pending = (async () => {
                await this.acquireCommentSlot();
                try {
                  return await this.api.commentCount!(entry.submissionUrl);
                } finally {
                  this.releaseCommentSlot();
                }
              })();
              this.commentInFlight.set(cacheKey, pending);
              pending
                .finally(() => {
                  if (this.commentInFlight.get(cacheKey) === pending)
                    this.commentInFlight.delete(cacheKey);
                })
                .catch(() => {});
            }
            const count = await pending;
            if (!Number.isSafeInteger(count) || count < 0) {
              failures.push(entry.submissionId);
              continue;
            }
            const at = Date.now();
            this.commentCache.set(cacheKey, { count, at });
            done.push([entry.submissionId, count, at]);
          } catch {
            failures.push(
              entry.submissionId
            ); /* Preserve previously verified values. */
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, worker)
      );
      if (!current()) return;
      const latest = this.store.getState().jams,
        existing = latest.workspaces[jamId];
      if (!existing) return;
      const progress = { ...existing.progress };
      for (const [id, count, at] of done)
        progress[id] = {
          ...(progress[id] || { status: "new" as const }),
          commentCount: count,
          commentsCheckedAt: at,
          commentCountVersion: 3,
        };
      const next = {
        ...latest,
        workspaces: {
          ...latest.workspaces,
          [jamId]: {
            ...existing,
            progress,
            commentsSyncing: false,
            commentsError: failures.length
              ? `Could not load comments for ${failures.length} ${
                  failures.length === 1 ? "entry" : "entries"
                }. Retry to check them.`
              : undefined,
          },
        },
      };
      this.replace(next);
      await this.persist(profileId, next);
    } catch (e) {
      if (current()) {
        const latest = this.store.getState().jams;
        if (latest.workspaces[jamId])
          this.replace({
            ...latest,
            workspaces: {
              ...latest.workspaces,
              [jamId]: {
                ...latest.workspaces[jamId],
                commentsSyncing: false,
                commentsError: errorText(e),
              },
            },
          });
      }
    }
  }
  private async acquireCommentSlot() {
    if (this.commentActive < 4) {
      this.commentActive += 1;
      return;
    }
    await new Promise<void>((resolve) => this.commentWaiters.push(resolve));
  }
  private releaseCommentSlot() {
    const next = this.commentWaiters.shift();
    if (next) next();
    else this.commentActive -= 1;
  }
  async syncAllComments(jamId: string, cancel = false) {
    const state = this.store.getState().jams;
    const profileId = state.profileId;
    const jam = state.workspaces[jamId];
    if (!profileId || !jam || !this.active(profileId)) return;
    if (!cancel && jam.commentsAllSyncing) return;
    const key = `${profileId}:${jamId}`;
    const request = (this.allCommentRequests.get(key) || 0) + 1;
    this.allCommentRequests.set(key, request);
    if (cancel) {
      this.commentRequests.set(key, (this.commentRequests.get(key) || 0) + 1);
      this.commentGeneration.set(key, this.commentRequests.get(key)!);
      this.replace({
        ...state,
        workspaces: {
          ...state.workspaces,
          [jamId]: {
            ...jam,
            commentsSyncing: false,
            commentsAllSyncing: false,
            commentsAllProgress: undefined,
          },
        },
      });
      return;
    }
    if (!state.ready || !this.api.commentCount) return;
    const epoch = this.ratingsEpoch;
    const isCurrent = () =>
      this.active(profileId) &&
      this.ratingsEpoch === epoch &&
      this.allCommentRequests.get(key) === request;
    const ids = jam.entries.map((entry) => entry.submissionId);
    this.replace({
      ...state,
      workspaces: {
        ...state.workspaces,
        [jamId]: {
          ...jam,
          commentsAllSyncing: true,
          commentsAllProgress: { completed: 0, total: ids.length },
        },
      },
    });
    let failedBatches = 0;
    for (let offset = 0; offset < ids.length; offset += 50) {
      if (!isCurrent()) return;
      await this.syncComments(jamId, ids.slice(offset, offset + 50));
      if (!isCurrent()) return;
      const latest = this.store.getState().jams,
        currentJam = latest.workspaces[jamId];
      if (currentJam?.commentsError) failedBatches += 1;
      if (currentJam)
        this.replace({
          ...latest,
          workspaces: {
            ...latest.workspaces,
            [jamId]: {
              ...currentJam,
              commentsAllSyncing: true,
              commentsAllProgress: {
                completed: Math.min(offset + 50, ids.length),
                total: ids.length,
              },
            },
          },
        });
    }
    if (!isCurrent()) return;
    const latest = this.store.getState().jams,
      currentJam = latest.workspaces[jamId];
    if (currentJam)
      this.replace({
        ...latest,
        workspaces: {
          ...latest.workspaces,
          [jamId]: {
            ...currentJam,
            commentsAllSyncing: false,
            commentsAllProgress: undefined,
            ...(failedBatches
              ? {
                  commentsError: `Could not fully check ${failedBatches} group${
                    failedBatches === 1 ? "" : "s"
                  } of comments. Some counts may be missing.`,
                }
              : {}),
          },
        },
      });
  }
  async syncCreatorComments(jamId: string, fresh = false) {
    const state = this.store.getState().jams,
      profileId = state.profileId,
      jam = state.workspaces[jamId];
    if (
      !profileId ||
      !state.ready ||
      !jam ||
      !this.active(profileId) ||
      !this.api.creatorComments ||
      jam.creatorCommentsSyncing
    )
      return;
    if (
      !fresh &&
      jam.creatorComments &&
      Date.now() - jam.creatorComments.syncedAt < 5 * 60_000
    )
      return;
    const key = `${profileId}:${jamId}`,
      request = (this.creatorCommentRequests.get(key) || 0) + 1,
      epoch = this.ratingsEpoch;
    this.creatorCommentRequests.set(key, request);
    this.replace({
      ...state,
      workspaces: {
        ...state.workspaces,
        [jamId]: {
          ...jam,
          creatorCommentsSyncing: true,
          creatorCommentsError: undefined,
        },
      },
    });
    const current = () =>
      this.active(profileId) &&
      epoch === this.ratingsEpoch &&
      this.creatorCommentRequests.get(key) === request;
    try {
      const result = await this.api.creatorComments(
        jam.url,
        profileId,
        jam.entries
      );
      if (!current()) return;
      const latest = this.store.getState().jams,
        existing = latest.workspaces[jamId];
      if (!existing) return;
      const known = new Set(existing.entries.map((e) => e.gameId));
      const valid = {
        ownGameIds: [
          ...new Set(
            result.ownGameIds.filter(
              (id) => Number.isSafeInteger(id) && known.has(id)
            )
          ),
        ],
        commenterIds: [
          ...new Set(
            result.commenterIds.filter(
              (id) => Number.isSafeInteger(id) && id > 0
            )
          ),
        ],
        syncedAt: Date.now(),
        complete: result.complete,
      };
      const next = {
        ...latest,
        workspaces: {
          ...latest.workspaces,
          [jamId]: {
            ...existing,
            creatorComments: valid,
            creatorCommentsSyncing: false,
            creatorCommentsError: undefined,
          },
        },
      };
      this.replace(next);
      await this.persist(profileId, next);
    } catch (e) {
      if (current()) {
        const latest = this.store.getState().jams;
        if (latest.workspaces[jamId])
          this.replace({
            ...latest,
            workspaces: {
              ...latest.workspaces,
              [jamId]: {
                ...latest.workspaces[jamId],
                creatorCommentsSyncing: false,
                creatorCommentsError: errorText(e),
              },
            },
          });
      }
    }
  }
  async download(
    jamId: string,
    submissionId?: string,
    explicitUploadId?: number
  ) {
    const jam = this.store.getState().jams.workspaces[jamId];
    if (!jam) return;
    const entries = submissionId
      ? jam.entries.filter((e) => e.submissionId === submissionId)
      : jam.entries;
    await this.run("download", jamId, entries.length, async (profileId) => {
      const locationId =
        this.store.getState().preferences.defaultInstallLocation;
      if (!locationId)
        throw new Error(
          "Choose a default install location in Preferences before downloading a jam."
        );
      for (const [index, entry] of entries.entries()) {
        this.check(profileId);
        try {
          await this.downloadEntry(
            profileId,
            jamId,
            entry,
            locationId,
            submissionId ? explicitUploadId : undefined
          );
        } catch (e) {
          this.check(profileId);
          await this.patch(profileId, jamId, entry.submissionId, {
            status: "attention",
            message: errorText(e),
          });
        }
        this.check(profileId);
        this.replace({
          ...this.store.getState().jams,
          busy: {
            kind: "download",
            jamId,
            completed: index + 1,
            total: entries.length,
          },
        });
      }
      this.store.dispatch(actions.refreshDownloads({}));
    });
  }
  private async downloadEntry(
    profileId: number,
    jamId: string,
    entry: JamEntry,
    locationId: string,
    explicitUploadId?: number
  ) {
    const game = await this.api.game(entry.gameId);
    this.check(profileId);
    await this.patch(profileId, jamId, entry.submissionId, {
      status: "checking",
      game,
      message: undefined,
    });
    // No purchase or bundle materialization: list only uploads already accessible.
    const uploads = await this.api.uploads(game.id);
    this.check(profileId);
    const native = chooseNativeUpload(uploads);
    const html = chooseHtmlFallback(uploads);
    const choice = native.status === "none" ? html : native;
    let upload: Upload;
    if (explicitUploadId) {
      const selected = uploads.find(
        (u) =>
          u.id === explicitUploadId &&
          !u.demo &&
          !u.preorder &&
          (u.type === UploadType.Default || u.type === UploadType.HTML)
      );
      if (!selected)
        throw new Error(
          "That build is no longer available or compatible. Refresh and choose again."
        );
      upload = selected;
    } else if (choice.status === "selected") upload = choice.upload;
    else if (choice.status === "ambiguous") {
      await this.patch(profileId, jamId, entry.submissionId, {
        status: "attention",
        candidates: choice.uploads,
        message: "Choose which build to install.",
      });
      return;
    } else {
      await this.patch(profileId, jamId, entry.submissionId, {
        status: game.type === GameType.HTML ? "web" : "attention",
        candidates: undefined,
        message:
          game.type === GameType.HTML
            ? "Play on the game page; no compatible downloadable build was found."
            : "No accessible compatible build. Check the project page for purchases or other downloads.",
      });
      return;
    }
    const caves = await this.api.caves(game.id);
    const downloads = await this.api.downloads();
    this.check(profileId);
    const installed = caves.find(
      (c) => c.upload?.id === upload.id && c.stats.installedAt
    );
    const pending = downloads.find(
      (d) => d.upload.id === upload.id && (!d.finishedAt || d.error)
    );
    if (installed || pending) {
      const caveId = installed?.id || pending!.caveId;
      const state = this.store.getState().jams;
      const old = state.installs[caveId];
      const kept = !!(
        old?.kept || state.workspaces[jamId].progress[entry.submissionId]?.kept
      );
      this.replace({
        ...state,
        installs: {
          ...state.installs,
          [caveId]: old
            ? { ...old, kept, jamIds: [...new Set([...old.jamIds, jamId])] }
            : {
                caveId,
                gameId: game.id,
                uploadId: upload.id,
                jamIds: [jamId],
                createdByJam: false,
                preexisting: true,
                kept,
              },
        },
      });
      if (pending?.error && !installed) {
        this.check(profileId);
        await this.api.retry(pending.id);
      }
      await this.patch(profileId, jamId, entry.submissionId, {
        status: installed ? "ready" : "queued",
        caveId,
        kept,
        uploadId: upload.id,
        downloadId: pending?.id,
        message: installed
          ? "Already installed."
          : "Already in the download queue.",
        candidates: undefined,
      });
      return;
    }
    if (caves.some((c) => c.upload?.id === upload.id))
      throw new Error(
        "An incomplete installation already exists. Repair it from the game's installation controls before retrying."
      );
    this.check(profileId);
    // Capture the old profile's snapshot so a late result is never attributed to a new login.
    const beforeQueue = this.store.getState().jams;
    const result = await this.api.queue(game, upload, profileId, locationId);
    const base = this.active(profileId)
      ? this.store.getState().jams
      : beforeQueue;
    const next: JamsState = {
      ...base,
      installs: {
        ...base.installs,
        [result.caveId]: {
          caveId: result.caveId,
          gameId: game.id,
          uploadId: upload.id,
          jamIds: [jamId],
          createdByJam: true,
          preexisting: false,
          kept: !!base.workspaces[jamId].progress[entry.submissionId]?.kept,
        },
      },
      workspaces: {
        ...base.workspaces,
        [jamId]: {
          ...base.workspaces[jamId],
          progress: {
            ...base.workspaces[jamId].progress,
            [entry.submissionId]: {
              status: "queued",
              game,
              uploadId: upload.id,
              caveId: result.caveId,
              downloadId: result.id,
              kept: base.workspaces[jamId].progress[entry.submissionId]?.kept,
              message: undefined,
            },
          },
        },
      },
    };
    if (this.active(profileId)) this.replace(next);
    await this.persist(profileId, next);
    this.store.dispatch(actions.downloadQueued({}));
    this.check(profileId);
  }
  async keep(jamId: string, entryId: string, kept: boolean) {
    const state = this.store.getState().jams;
    if (
      !state.profileId ||
      state.busy ||
      !this.active(state.profileId) ||
      !state.workspaces[jamId]?.entries.some((e) => e.submissionId === entryId)
    )
      return;
    const progress = state.workspaces[jamId]?.progress[entryId];
    const record = progress?.caveId && state.installs[progress.caveId];
    if (record) {
      const workspaces = { ...state.workspaces };
      for (const jam of Object.values(workspaces)) {
        const progress = { ...jam.progress };
        for (const [id, item] of Object.entries(progress))
          if (item.caveId === record.caveId) progress[id] = { ...item, kept };
        workspaces[jam.id] = { ...jam, progress };
      }
      this.replace({
        ...state,
        workspaces,
        installs: { ...state.installs, [record.caveId]: { ...record, kept } },
      });
    }
    await this.patch(state.profileId, jamId, entryId, { kept });
  }
  async remove(jamId: string) {
    const jam = this.store.getState().jams.workspaces[jamId];
    if (!jam) return;
    await this.run("remove", jamId, jam.entries.length, async (profileId) => {
      for (const [index, entry] of jam.entries.entries()) {
        this.check(profileId);
        const state = this.store.getState().jams;
        const progress = state.workspaces[jamId].progress[entry.submissionId];
        const record = progress?.caveId && state.installs[progress.caveId];
        if (record && !progress?.kept && !record.kept) {
          try {
            if (canRemoveJamInstall(record, jamId)) {
              if (
                this.store.getState().tasks.tasksByGameId[entry.gameId]?.length
              )
                throw new Error(
                  "Close the game or wait for its current operation before removing it."
                );
              const cave = (await this.api.caves(entry.gameId)).find(
                (c) => c.id === record.caveId
              );
              this.check(profileId);
              if (cave && cave.upload.id !== record.uploadId)
                throw new Error(
                  "This installation changed outside Jam Mode; it was preserved."
                );
              const downloads = await this.api.downloads();
              this.check(profileId);
              for (const d of downloads.filter(
                (d) => d.caveId === record.caveId && (!d.finishedAt || d.error)
              )) {
                await this.api.discard(d.id);
                this.check(profileId);
              }
              const beforeUninstall = this.store.getState().jams;
              const remainingCave = (await this.api.caves(entry.gameId)).find(
                (c) => c.id === record.caveId
              );
              this.check(profileId);
              if (remainingCave && remainingCave.upload.id !== record.uploadId)
                throw new Error(
                  "This installation changed outside Jam Mode; it was preserved."
                );
              if (
                this.store.getState().tasks.tasksByGameId[entry.gameId]?.length
              )
                throw new Error(
                  "Close the game or wait for its current operation before removing it."
                );
              if (remainingCave) await this.api.uninstall(record.caveId);
              const current = this.active(profileId)
                ? this.store.getState().jams
                : beforeUninstall;
              const installs = { ...current.installs };
              delete installs[record.caveId];
              const workspaces = { ...current.workspaces };
              for (const workspace of Object.values(workspaces)) {
                const progress = { ...workspace.progress };
                for (const [id, item] of Object.entries(progress))
                  if (item.caveId === record.caveId)
                    progress[id] = {
                      ...item,
                      status: "removed",
                      caveId: undefined,
                      downloadId: undefined,
                      message: "Jam installation removed.",
                    };
                workspaces[workspace.id] = { ...workspace, progress };
              }
              const next = { ...current, installs, workspaces };
              if (this.active(profileId)) this.replace(next);
              await this.persist(profileId, next);
              this.store.dispatch(actions.uninstallEnded({}));
              this.check(profileId);
            } else {
              // Release this jam's reference, preserving shared and pre-existing copies.
              const jamIds = record.jamIds.filter((id) => id !== jamId);
              const installs = { ...state.installs };
              if (jamIds.length)
                installs[record.caveId] = { ...record, jamIds };
              else delete installs[record.caveId];
              this.replace({ ...state, installs });
            }
            await this.patch(profileId, jamId, entry.submissionId, {
              status: "removed",
              caveId: undefined,
              downloadId: undefined,
              message:
                "Removed from this jam. Shared and pre-existing installations were preserved.",
            });
          } catch (e) {
            this.check(profileId);
            await this.patch(profileId, jamId, entry.submissionId, {
              message: `Could not remove: ${errorText(e)}`,
            });
          }
        }
        this.check(profileId);
        this.replace({
          ...this.store.getState().jams,
          busy: {
            kind: "remove",
            jamId,
            completed: index + 1,
            total: jam.entries.length,
          },
        });
      }
      this.store.dispatch(actions.refreshDownloads({}));
    });
  }
  async reconcile() {
    const profileId = this.store.getState().jams.profileId;
    if (
      !profileId ||
      !this.active(profileId) ||
      this.store.getState().jams.busy
    )
      return;
    const downloads = await this.api.downloads();
    if (!this.active(profileId) || this.store.getState().jams.busy) return;
    for (const jam of Object.values(this.store.getState().jams.workspaces)) {
      for (const [entryId, progress] of Object.entries(jam.progress)) {
        if (!progress.caveId || progress.status === "removed") continue;
        const download =
          downloads.find((d) => d.id === progress.downloadId) ||
          [...downloads].reverse().find((d) => d.caveId === progress.caveId);
        let next: Partial<JamEntryProgress> | undefined;
        if (download?.error)
          next = {
            status: "attention",
            message: download.errorMessage || download.error,
          };
        else if (download && !download.finishedAt) next = { status: "queued" };
        else if (
          progress.status === "queued" ||
          progress.status === "checking" ||
          progress.status === "ready"
        ) {
          const entry = jam.entries.find((e) => e.submissionId === entryId);
          if (!entry) continue;
          const caves = await this.api.caves(entry.gameId);
          if (!this.active(profileId) || this.store.getState().jams.busy)
            return;
          next = caves.some(
            (c) =>
              c.id === progress.caveId &&
              c.upload.id ===
                (progress.uploadId ||
                  this.store.getState().jams.installs[progress.caveId!]
                    ?.uploadId) &&
              c.stats.installedAt
          )
            ? {
                status: "ready",
                message:
                  progress.status === "ready" ? progress.message : undefined,
              }
            : {
                status: "attention",
                message:
                  "Installation is missing or incomplete. Retry the download.",
              };
        }
        if (
          next &&
          (next.status !== progress.status || next.message !== progress.message)
        )
          await this.patch(profileId, jam.id, entryId, next);
      }
    }
  }
}

/** Restore only validated entries; never infer ownership from installed games. */
export function restoreJamState(
  raw: string | undefined,
  profileId: number
): JamsState {
  const state = { ...emptyJamsState(), profileId, ready: true };
  if (!raw) return state;
  const data = JSON.parse(raw);
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    !isRecord(data.workspaces) ||
    !isRecord(data.installs)
  )
    throw new Error("Unsupported jam workspace data.");
  for (const [id, value] of Object.entries(data.workspaces)) {
    if (!isRecord(value)) continue;
    const jam = value as JamsState["workspaces"][string];
    if (
      jam.id !== id ||
      normalizeJamUrl(jam.url) !== jam.url ||
      new URL(jam.url).pathname.split("/")[2] !== id ||
      !Array.isArray(jam.entries) ||
      typeof jam.title !== "string"
    )
      continue;
    const entries = jam.entries.flatMap((e) => {
      const metadata = parseJamSubmissionMetadata(e);
      if (!metadata || metadata.jamSlug !== id) return [];
      const { jamSlug: _slug, jamUrl: _url, ...entry } = metadata;
      return [entry];
    });
    const progress = Object.fromEntries(
      entries.map((e) => {
        const rawProgress = isRecord(jam.progress)
          ? jam.progress[e.submissionId]
          : undefined;
        const p =
          isRecord(rawProgress) &&
          [
            "new",
            "checking",
            "queued",
            "ready",
            "web",
            "attention",
            "removed",
          ].includes(rawProgress.status)
            ? (rawProgress as unknown as JamEntryProgress)
            : undefined;
        if (!p) return [e.submissionId, { status: "new" as const }];
        const restored: JamEntryProgress = {
          ...p,
          status: p.status === "checking" ? "new" : p.status,
        };
        if (
          p.commentCountVersion !== 3 ||
          !Number.isSafeInteger(p.commentCount) ||
          (p.commentCount ?? -1) < 0
        ) {
          delete restored.commentCount;
          delete restored.commentsCheckedAt;
          delete restored.commentCountVersion;
        }
        const myRating = restorePersonalRating(p.myRating);
        if (myRating) restored.myRating = myRating;
        else delete restored.myRating;
        return [e.submissionId, restored];
      })
    );
    const knownGameIds = new Set(entries.map((entry) => entry.gameId));
    const ratings =
      isRecord(jam.ratings) &&
      Array.isArray(jam.ratings.ratedGameIds) &&
      typeof jam.ratings.syncedAt === "number" &&
      Number.isFinite(jam.ratings.syncedAt) &&
      jam.ratings.syncedAt > 0
        ? {
            ratedGameIds: [
              ...new Set(
                jam.ratings.ratedGameIds.filter(
                  (gameId: unknown): gameId is number =>
                    typeof gameId === "number" &&
                    Number.isSafeInteger(gameId) &&
                    knownGameIds.has(gameId)
                )
              ),
            ],
            syncedAt: jam.ratings.syncedAt,
          }
        : undefined;
    const creatorComments =
      isRecord(jam.creatorComments) &&
      Array.isArray(jam.creatorComments.ownGameIds) &&
      Array.isArray(jam.creatorComments.commenterIds) &&
      typeof jam.creatorComments.syncedAt === "number" &&
      Number.isFinite(jam.creatorComments.syncedAt) &&
      typeof jam.creatorComments.complete === "boolean"
        ? {
            ownGameIds: [
              ...new Set(
                jam.creatorComments.ownGameIds.filter(
                  (id: unknown): id is number =>
                    typeof id === "number" &&
                    Number.isSafeInteger(id) &&
                    knownGameIds.has(id)
                )
              ),
            ],
            commenterIds: [
              ...new Set(
                jam.creatorComments.commenterIds.filter(
                  (id: unknown): id is number =>
                    typeof id === "number" && Number.isSafeInteger(id) && id > 0
                )
              ),
            ],
            syncedAt: jam.creatorComments.syncedAt,
            complete: jam.creatorComments.complete,
          }
        : undefined;
    state.workspaces[id] = {
      ...jam,
      entries,
      progress,
      ratings,
      creatorComments,
      ratingsSyncing: false,
      ratingsError: undefined,
      myRatingsSyncing: false,
      myRatingsError: undefined,
      commentsSyncing: false,
      commentsError: undefined,
      commentsAllSyncing: false,
      commentsAllProgress: undefined,
      creatorCommentsSyncing: false,
      creatorCommentsError: undefined,
    };
  }
  for (const [caveId, value] of Object.entries(data.installs)) {
    if (!isRecord(value)) continue;
    const r = value as JamsState["installs"][string];
    if (
      r.caveId === caveId &&
      typeof caveId === "string" &&
      Number.isSafeInteger(r.gameId) &&
      r.gameId > 0 &&
      Number.isSafeInteger(r.uploadId) &&
      r.uploadId > 0 &&
      Array.isArray(r.jamIds) &&
      r.jamIds.length > 0 &&
      r.jamIds.every(
        (id) =>
          typeof id === "string" &&
          state.workspaces[id]?.entries.some((e) => e.gameId === r.gameId)
      ) &&
      typeof r.createdByJam === "boolean" &&
      typeof r.preexisting === "boolean" &&
      typeof r.kept === "boolean"
    )
      state.installs[caveId] = r;
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidPersonalRating(
  value: unknown
): value is Omit<JamPersonalRating, "checkedAt"> {
  return (
    isRecord(value) &&
    Number.isFinite(value.average) &&
    Array.isArray(value.categories) &&
    value.categories.length > 0 &&
    value.categories.every(
      (category: unknown) =>
        isRecord(category) &&
        typeof category.name === "string" &&
        category.name.trim().length > 0 &&
        Number.isFinite(category.value) &&
        category.value >= 0 &&
        (category.max === undefined ||
          (Number.isFinite(category.max) &&
            [1, 5].includes(category.max) &&
            category.value <= category.max))
    )
  );
}

function restorePersonalRating(value: unknown): JamPersonalRating | undefined {
  if (
    !isRecord(value) ||
    !Number.isFinite(value.average) ||
    !Number.isFinite(value.checkedAt) ||
    value.checkedAt <= 0 ||
    !Array.isArray(value.categories) ||
    value.categories.length === 0
  )
    return undefined;
  const categories: JamPersonalRating["categories"] = [];
  for (const category of value.categories) {
    if (
      !isRecord(category) ||
      typeof category.name !== "string" ||
      !category.name.trim() ||
      typeof category.value !== "number" ||
      !Number.isFinite(category.value) ||
      category.value < 0 ||
      (category.max !== undefined &&
        (typeof category.max !== "number" ||
          !Number.isFinite(category.max) ||
          ![1, 5].includes(category.max) ||
          category.value > category.max))
    )
      return undefined;
    categories.push({
      name: category.name.trim(),
      value: category.value,
      ...(category.max !== undefined ? { max: category.max } : {}),
    });
  }
  return {
    average:
      categories.reduce((sum, item) => sum + item.value, 0) / categories.length,
    categories,
    checkedAt: value.checkedAt,
  };
}
