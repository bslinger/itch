import { actions } from "common/actions";
import * as messages from "common/butlerd/messages";
import {
  normalizeGameUrl,
  normalizeJamUrl,
  normalizeSubmissionUrl,
} from "common/jams/model";
import { Watcher } from "common/util/watcher";
import { Store } from "common/types";
import { mcall } from "main/butlerd/mcall";
import { JamController } from "main/jams/controller";
import { importJam } from "main/jams/import";
import { fetchJamPersonalRating, fetchJamRatedGames } from "main/jams/ratings";
import {
  fetchJamCommentCount,
  fetchJamEntryCommentAuthors,
  fetchJamCreatorComments,
} from "main/jams/comments";
import { JamStorage } from "main/jams/storage";
import { ChunkedJamStorageBackend } from "main/jams/chunked-storage";
import { mainLogger } from "main/logger";
import { setJamRateLimitHandler } from "main/jams/comment-requests";
import { dialog } from "electron";
import {
  attemptJamReturn,
  createJamReturnDeduplicator,
  probeJamRatingDirty,
} from "main/jams/unsaved-rating";
import { getWebContents } from "main/reactors/web-contents/web-contents-state";
import { getNativeWindow } from "main/reactors/winds";
import { Space } from "common/helpers/space";

const DATA_KEY = "@itch/jams/v1";
function safeJamLogError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(
      /\b(csrf|token|cookie|authorization|password)\b(\s*[:=]\s*)[^\s&]+/gi,
      "$1$2[redacted]"
    )
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 180);
  return `${name}: ${safeMessage}`;
}

export default function jams(watcher: Watcher) {
  setJamRateLimitHandler(({ delayMs, retry }) => {
    mainLogger.warn(
      `[jam-comments] HTTP 429 rate limit; shared cooldown ${Math.ceil(
        delayMs / 1000
      )}s (attempt ${retry})`
    );
  });
  let controller: JamController | undefined;
  const runDeduplicatedReturn = createJamReturnDeduplicator();
  const backend = new ChunkedJamStorageBackend({
    get: async (profileId, key) => {
      const result = await mcall(messages.ProfileDataGet, { profileId, key });
      return result.ok ? result.value : undefined;
    },
    put: async (profileId, key, value) => {
      await mcall(messages.ProfileDataPut, { profileId, key, value });
    },
  });
  const storage = new JamStorage(backend);
  const get = (store: Store) => {
    if (!controller)
      controller = new JamController(store, {
        load: (profileId) => storage.load(profileId),
        saveState: (profileId, state) => storage.saveState(profileId, state),
        save: async (profileId, value) => {
          await backend.put(profileId, DATA_KEY, value);
        },
        importJam,
        ratedGames: async (url, profileId) => {
          const profile = store.getState().profile.profile;
          if (!profile || profile.id !== profileId)
            throw new Error(
              "The active itch.io account changed. Sync your ratings again."
            );
          return await fetchJamRatedGames(url, profile.user.id);
        },
        personalRating: async (url, profileId) => {
          const profile = store.getState().profile.profile;
          if (!profile || profile.id !== profileId)
            throw new Error(
              "The active itch.io account changed. Sync your saved ratings again."
            );
          return await fetchJamPersonalRating(url, profile.user.id);
        },
        commentCount: async (submissionUrl) => {
          try {
            return await fetchJamCommentCount(submissionUrl);
          } catch (error) {
            mainLogger.warn(
              `[jam-comments] count failed ${
                normalizeSubmissionUrl(submissionUrl) ||
                "[invalid submission URL]"
              }: ${safeJamLogError(error)}`
            );
            throw error;
          }
        },
        commentAuthors: async (submissionUrl) =>
          fetchJamEntryCommentAuthors(submissionUrl),
        creatorComments: async (url, profileId, entries) => {
          const profile = store.getState().profile.profile;
          if (!profile || profile.id !== profileId)
            throw new Error(
              "The active itch.io account changed. Sync comments again."
            );
          try {
            const result = await fetchJamCreatorComments(
              url,
              profile.user.id,
              entries
            );
            if (!result.complete) {
              mainLogger.warn(
                `[jam-comments] creator scan incomplete ${
                  normalizeJamUrl(url) || "[invalid jam URL]"
                }`
              );
            }
            return result;
          } catch (error) {
            mainLogger.warn(
              `[jam-comments] creator scan failed ${
                normalizeJamUrl(url) || "[invalid jam URL]"
              }: ${safeJamLogError(error)}`
            );
            throw error;
          }
        },
        game: async (gameId) => {
          const { game } = await mcall(messages.FetchGame, {
            gameId,
            fresh: true,
          });
          if (!game) throw new Error("Game is no longer accessible.");
          return game;
        },
        uploads: async (gameId) =>
          (
            await mcall(messages.FetchGameUploads, {
              gameId,
              compatible: true,
              fresh: true,
            })
          ).uploads,
        caves: async (gameId) => {
          const items: messages.Cave[] = [];
          let cursor: messages.Cursor | undefined;
          do {
            const res = await mcall(messages.FetchCaves, {
              filters: { gameId },
              limit: 100,
              cursor,
            });
            items.push(...res.items);
            cursor = res.nextCursor;
          } while (cursor);
          return items;
        },
        downloads: async () =>
          (await mcall(messages.DownloadsList, {})).downloads,
        queue: async (game, upload, profileId, installLocationId) =>
          await mcall(messages.InstallQueue, {
            game,
            upload,
            build: upload.build,
            profileId,
            installLocationId,
            queueDownload: true,
            fastQueue: true,
          }),
        discard: async (downloadId) => {
          await mcall(messages.DownloadsDiscard, { downloadId });
        },
        retry: async (downloadId) => {
          await mcall(messages.DownloadsRetry, { downloadId });
        },
        uninstall: async (caveId) => {
          await mcall(messages.UninstallPerform, { caveId });
        },
      });
    return controller;
  };
  watcher.on(actions.loginSucceeded, async (store) => {
    await get(store).load();
  });
  watcher.on(actions.loggedOut, async (store) => {
    get(store).cancel();
  });
  watcher.on(actions.jamsLoad, async (store) => {
    await get(store).load();
  });
  watcher.on(actions.jamReturnToList, async (store, { payload }) => {
    const { wind, tab } = payload;
    const key = `${wind}:${tab}`;
    await runDeduplicatedReturn(key, async () => {
      const initialState = store.getState();
      const initialTab = initialState.winds[wind]?.tabInstances[tab];
      if (!initialTab) return;
      const initialSpace = Space.fromState(initialState, wind, tab);
      const tabURL = initialSpace.url() ?? "";
      const registryWC = getWebContents(wind, tab);
      const wc =
        initialSpace.isBrowser() && registryWC && !registryWC.isDestroyed()
          ? registryWC
          : null;
      const pageURL = wc ? wc.getURL() : tabURL;
      const profileId = initialState.profile.profile?.id;
      const isCurrent = () => {
        const state = store.getState();
        const currentTab = state.winds[wind]?.tabInstances[tab];
        if (!currentTab) return false;
        const currentSpace = Space.fromState(state, wind, tab);
        const currentTabURL = currentSpace.url() ?? "";
        const currentRegistryWC = getWebContents(wind, tab);
        const currentWC =
          currentSpace.isBrowser() &&
          currentRegistryWC &&
          !currentRegistryWC.isDestroyed()
            ? currentRegistryWC
            : null;
        const currentURL = currentWC ? currentWC.getURL() : currentTabURL;
        return (
          currentTabURL === tabURL &&
          currentWC === wc &&
          currentURL === pageURL &&
          state.profile.profile?.id === profileId
        );
      };
      await attemptJamReturn({
        pageURL,
        isCurrent,
        probe: async () => {
          if (!wc || wc.isDestroyed()) throw new Error("Page is unavailable");
          return (await wc.executeJavaScript(
            `(${probeJamRatingDirty.toString()})()`
          )) as {
            formPresent: boolean;
            hasRatingForm: boolean;
            dirty: boolean | null;
          };
        },
        confirm: async (warning) => {
          if (warning === "unknown") {
            mainLogger.warn(
              `Could not verify jam rating save state for ${pageURL}`
            );
          }
          const nativeWindow = getNativeWindow(store.getState(), wind);
          const options = {
            type: "warning" as const,
            title:
              warning === "dirty"
                ? "Leave this rating page?"
                : "Could not check this rating page",
            message:
              warning === "dirty"
                ? "Your rating changes have not been saved."
                : "Itch could not verify whether your rating changes have been saved.",
            detail:
              warning === "dirty"
                ? "Leave without saving your changes?"
                : "Leave this page anyway?",
            buttons:
              warning === "dirty"
                ? ["Leave without saving", "Stay on this page"]
                : ["Leave page", "Stay on this page"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          };
          const { response } = nativeWindow
            ? await dialog.showMessageBox(nativeWindow, options)
            : await dialog.showMessageBox(options);
          return response === 0;
        },
        onProbeError: (error) => {
          mainLogger.warn(`Could not inspect jam rating save state: ${error}`);
        },
        navigate: () =>
          store.dispatch(
            actions.evolveTab({
              wind,
              tab,
              url: "itch://jams",
              replace: false,
            })
          ),
      });
    });
  });
  watcher.on(actions.jamImport, async (store, { payload }) => {
    await get(store).import(payload.url);
  });
  watcher.on(actions.jamSyncRatings, async (store, { payload }) => {
    await get(store).syncRatings(payload.jamId);
  });
  watcher.on(actions.jamSyncMyRatings, async (store, { payload }) => {
    await get(store).syncMyRatings(
      payload.jamId,
      payload.submissionIds,
      payload.fresh
    );
  });
  watcher.on(actions.jamSyncComments, async (store, { payload }) => {
    await get(store).syncComments(
      payload.jamId,
      payload.submissionIds,
      payload.fresh
    );
  });
  watcher.on(actions.jamSyncAllComments, async (store, { payload }) => {
    await get(store).syncAllComments(payload.jamId, payload.cancel);
  });
  watcher.on(actions.jamSyncCreatorComments, async (store, { payload }) => {
    await get(store).syncCreatorComments(payload.jamId, payload.fresh);
  });
  watcher.on(actions.jamSyncCommentAuthors, async (store, { payload }) => {
    await get(store).syncCommentAuthors(
      payload.jamId,
      payload.submissionIds,
      payload.fresh
    );
  });
  watcher.on(actions.jamSyncAllCommentAuthors, async (store, { payload }) => {
    await get(store).syncAllCommentAuthors(payload.jamId, payload.cancel);
  });
  watcher.on(actions.jamDownloadAll, async (store, { payload }) => {
    await get(store).download(
      payload.jamId,
      payload.submissionId,
      payload.uploadId
    );
  });
  watcher.on(actions.jamRemoveAll, async (store, { payload }) => {
    await get(store).remove(payload.jamId);
  });
  watcher.on(actions.jamRemoveOne, async (store, { payload }) => {
    await get(store).removeOne(payload.jamId, payload.submissionId);
  });
  watcher.on(actions.jamCancel, async (store) => {
    get(store).cancel();
  });
  watcher.on(actions.jamKeep, async (store, { payload }) => {
    await get(store).keep(payload.jamId, payload.submissionId, payload.kept);
  });
  watcher.on(actions.downloadEnded, async (store) => {
    try {
      await get(store).reconcile();
    } catch (e) {
      mainLogger.warn(`Jam reconcile failed: ${e}`);
    }
  });
  watcher.on(actions.jamPlay, async (store, { payload }) => {
    const state = store.getState().jams;
    const jam = state.workspaces[payload.jamId];
    const entry = jam?.entries.find(
      (e) => e.submissionId === payload.submissionId
    );
    const progress = jam?.progress[payload.submissionId];
    if (!entry || state.busy) return;
    if (payload.web) {
      const url = normalizeGameUrl(progress?.game?.url || entry.gameUrl);
      if (url) store.dispatch(actions.navigate({ wind: "root", url }));
    } else if (
      progress?.status === "ready" &&
      progress.caveId &&
      progress.game
    ) {
      store.dispatch(
        actions.queueGame({ game: progress.game, caveId: progress.caveId })
      );
    }
  });
}
