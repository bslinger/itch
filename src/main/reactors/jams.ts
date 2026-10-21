import { actions } from "common/actions";
import * as messages from "common/butlerd/messages";
import { normalizeGameUrl } from "common/jams/model";
import { Watcher } from "common/util/watcher";
import { Store } from "common/types";
import { mcall } from "main/butlerd/mcall";
import { JamController } from "main/jams/controller";
import { importJam } from "main/jams/import";
import { fetchJamRatedGames } from "main/jams/ratings";
import { JamStorage } from "main/jams/storage";
import { mainLogger } from "main/logger";

const DATA_KEY = "@itch/jams/v1";
export default function jams(watcher: Watcher) {
  let controller: JamController | undefined;
  const storage = new JamStorage({
    get: async (profileId, key) => {
      const result = await mcall(messages.ProfileDataGet, { profileId, key });
      return result.ok ? result.value : undefined;
    },
    put: async (profileId, key, value) => {
      await mcall(messages.ProfileDataPut, { profileId, key, value });
    },
  });
  const get = (store: Store) => {
    if (!controller)
      controller = new JamController(store, {
        load: (profileId) => storage.load(profileId),
        saveState: (profileId, state) => storage.saveState(profileId, state),
        save: async (profileId, value) => {
          await mcall(messages.ProfileDataPut, {
            profileId,
            key: DATA_KEY,
            value,
          });
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
  watcher.on(actions.jamImport, async (store, { payload }) => {
    await get(store).import(payload.url);
  });
  watcher.on(actions.jamSyncRatings, async (store, { payload }) => {
    await get(store).syncRatings(payload.jamId);
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
