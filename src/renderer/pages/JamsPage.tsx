import { actions } from "common/actions";
import { GameType, Upload } from "common/butlerd/messages";
import { JamEntry, JamWorkspace } from "common/jams/model";
import { JamSession, JamsState } from "common/jams/state";
import { creatorCommentStatus } from "common/jams/creator-comments";
import {
  filterJamEntries,
  jamCommentCount,
  JamSort,
  JamRatingFilter,
  JamPlatformFilter,
  JamInstallFilter,
} from "common/jams/listing";
import { Dispatch } from "common/types";
import React from "react";
import Button from "renderer/basics/Button";
import { hook } from "renderer/hocs/hook";
import { dispatchTabPageUpdate } from "renderer/hocs/tab-utils";
import { withTab } from "renderer/hocs/withTab";
import { MeatProps } from "renderer/scenes/HubScene/Meats/types";
import JamGameCard from "renderer/pages/JamsPage/JamGameCard";
import {
  shouldDispatchVisibleCommentSync,
  visibleCommentSyncKey,
} from "renderer/pages/JamsPage/commentSync";
import {
  clearJamReturnContext,
  isJamReturnContextValid,
  readJamReturnContext,
  saveJamReturnContext,
} from "renderer/pages/JamsPage/returnContext";
import styled, * as styles from "renderer/styles";

const JamsDiv = styled.div`
  ${styles.meat};
  color: ${(props) => props.theme.baseText};
  overflow-y: auto;
  padding: 24px;

  h1 {
    margin: 0 0 8px;
  }
  h2 {
    font-size: 18px;
    margin: 24px 0 10px;
  }
  p {
    line-height: 1.5;
  }
  a {
    color: inherit;
  }
`;

const Intro = styled.div`
  max-width: 900px;
  margin-bottom: 20px;
  color: ${(props) => props.theme.baseText};
  opacity: 0.9;
`;

const ImportForm = styled.form`
  display: flex;
  gap: 8px;
  max-width: 720px;
  margin: 18px 0;

  input {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: inherit;
    background: rgba(0, 0, 0, 0.2);
  }
`;

const Notice = styled.div`
  max-width: 900px;
  padding: 12px 14px;
  margin: 14px 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  line-height: 1.5;
  &.error {
    background: rgba(180, 40, 40, 0.22);
  }
`;

const CommentProgress = styled.progress`
  display: block;
  width: 100%;
  height: 12px;
  margin: 8px 0;
  accent-color: ${(props) => props.theme.accent};
`;

const JamPicker = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 18px 0;
  button {
    color: inherit;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 6px;
    padding: 8px 12px;
    cursor: pointer;
  }
  button.active {
    background: rgba(255, 255, 255, 0.2);
  }
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 16px 0;
`;

const SearchInput = styled.input`
  min-width: 220px;
  padding: 9px 11px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: inherit;
  background: rgba(0, 0, 0, 0.2);
`;

const ListingControls = styled.div`
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 12px;
  margin: 16px 0;
  label {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: ${(props) => props.theme.secondaryText};
    min-width: 0;
    max-width: 100%;
  }
  select {
    padding: 9px 11px;
    border: 1px solid ${(props) => props.theme.filterBorder};
    border-radius: 6px;
    color: ${(props) => props.theme.baseText};
    background: ${(props) => props.theme.itemBackground};
    font: inherit;
    max-width: 100%;
  }
`;

const EntryList = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(224px, 100%), 1fr));
  gap: 24px;
  max-width: 1200px;
  align-items: start;
`;

interface Props extends MeatProps {
  tab: string;
  dispatch: Dispatch;
  jams: JamsState;
  profileId: number | null;
}

interface State {
  url: string;
  selectedJamId?: string;
  search: string;
  page: number;
  confirmDownload: boolean;
  confirmRemove: boolean;
  confirmUninstall?: string;
  sort: JamSort;
  rating: JamRatingFilter;
  platform: JamPlatformFilter;
  installation: JamInstallFilter;
  randomSeed: number;
}

const PAGE_SIZE = 50;

class JamsPage extends React.PureComponent<Props, State> {
  private listRef = React.createRef<HTMLDivElement>();
  private restoredProfileId?: number;
  private visibleCommentsKey?: string;
  private creatorCommentsKey?: string;
  private myRatingsKey?: string;
  private myRatingsSnapshotKey?: string;
  private commentAuthorsKey?: string;
  override state: State = {
    url: "",
    search: "",
    page: 0,
    confirmDownload: false,
    confirmRemove: false,
    sort: "popular",
    rating: "all",
    platform: "",
    installation: "all",
    randomSeed: Math.floor(Math.random() * 0x100000000),
  };

  override componentDidMount() {
    this.props.dispatch(actions.jamsLoad({}));
    this.restoreContextIfReady();
    const saved = readJamReturnContext(this.props.tab, this.props.profileId);
    if (
      this.props.jams.ready &&
      this.props.profileId != null &&
      this.props.jams.profileId === this.props.profileId
    ) {
      const selected = isJamReturnContextValid(
        saved,
        this.props.jams.workspaces
      )
        ? this.props.jams.workspaces[saved.jamId]
        : this.selectedJam(this.props, this.state);
      if (selected)
        this.props.dispatch(actions.jamSyncRatings({ jamId: selected.id }));
    }
    dispatchTabPageUpdate(this.props, { label: "Jams" });
  }

  override componentWillUnmount() {
    if (
      this.props.profileId != null &&
      this.props.jams.profileId === this.props.profileId
    ) {
      this.saveReturnContext();
    }
  }

  override componentDidUpdate(prevProps: Props, prevState: State) {
    if (
      prevProps.profileId !== this.props.profileId ||
      (!prevProps.jams.ready && this.props.jams.ready) ||
      (!prevProps.visible && this.props.visible)
    ) {
      this.visibleCommentsKey = undefined;
      this.creatorCommentsKey = undefined;
      this.myRatingsKey = undefined;
      this.myRatingsSnapshotKey = undefined;
      this.commentAuthorsKey = undefined;
    }
    this.restoreContextIfReady();
    const selected = this.selectedJam(this.props, this.state);
    const previous = this.selectedJam(prevProps, prevState);
    if (
      this.props.jams.ready &&
      this.props.profileId != null &&
      this.props.jams.profileId === this.props.profileId &&
      selected &&
      (!prevProps.jams.ready ||
        previous?.id !== selected.id ||
        (!prevProps.visible && this.props.visible))
    ) {
      this.props.dispatch(actions.jamSyncRatings({ jamId: selected.id }));
    }
    this.syncVisibleComments();
  }

  syncVisibleComments = (fresh = false) => {
    const { jams, profileId } = this.props;
    if (
      !jams.ready ||
      !this.props.visible ||
      jams.busy ||
      profileId == null ||
      jams.profileId !== profileId
    )
      return;
    const jam = this.selectedJam(this.props, this.state);
    if (!jam) return;
    if (
      this.state.rating === "unrated_team_uncommented" &&
      jam.ratings &&
      jam.creatorComments?.ownTeamComplete &&
      !jam.teamCommentsSyncing
    ) {
      const own = new Set(jam.creatorComments.ownGameIds);
      const candidates = filterJamEntries(jam, {
        ...this.state,
        rating: "unrated",
      })
        .filter((entry) => !own.has(entry.gameId))
        .slice(0, PAGE_SIZE)
        .map((entry) => entry.submissionId);
      const authorKey = `${profileId}:${
        jam.id
      }:${jam.creatorComments.ownTeamIds?.join(",")}:${[...candidates]
        .sort()
        .join(",")}`;
      if (fresh || authorKey !== this.commentAuthorsKey) {
        this.commentAuthorsKey = authorKey;
        this.props.dispatch(
          actions.jamSyncCommentAuthors({
            jamId: jam.id,
            submissionIds: candidates,
            fresh,
          })
        );
      }
    }
    const entries = filterJamEntries(jam, this.state);
    const page = Math.min(
      this.state.page,
      Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1)
    );
    const submissionIds = entries
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map((entry) => entry.submissionId);
    const key = visibleCommentSyncKey(profileId, jam.id, submissionIds);
    if (jam.ratings) {
      const snapshotKey = `${profileId}:${jam.id}:${jam.ratings.syncedAt}`;
      const ratingsKey = `${key}:${snapshotKey}`;
      if (ratingsKey !== this.myRatingsKey) {
        const ratingsFresh = snapshotKey !== this.myRatingsSnapshotKey;
        this.myRatingsKey = ratingsKey;
        this.myRatingsSnapshotKey = snapshotKey;
        this.props.dispatch(
          actions.jamSyncMyRatings({
            jamId: jam.id,
            submissionIds,
            fresh: ratingsFresh,
          })
        );
      }
    }
    if (
      shouldDispatchVisibleCommentSync({
        fresh,
        commentsSyncing: !!jam.commentsSyncing,
        commentsAllSyncing: !!jam.commentsAllSyncing,
        nextKey: key,
        previousKey: this.visibleCommentsKey,
      })
    ) {
      this.visibleCommentsKey = key;
      this.props.dispatch(
        actions.jamSyncComments({ jamId: jam.id, submissionIds, fresh })
      );
    }
    const creatorKey = `${profileId}:${jam.id}`;
    if (fresh || creatorKey !== this.creatorCommentsKey) {
      this.creatorCommentsKey = creatorKey;
      this.props.dispatch(
        actions.jamSyncCreatorComments({ jamId: jam.id, fresh })
      );
    }
  };

  restoreContextIfReady = () => {
    if (!this.props.jams.ready || this.props.profileId == null) return;
    if (this.props.jams.profileId !== this.props.profileId) return;
    if (this.restoredProfileId === this.props.profileId) return;
    const profileId = this.props.profileId;
    this.restoredProfileId = profileId;
    const context = readJamReturnContext(this.props.tab, profileId);
    if (!context) {
      this.resetListingForProfile();
      return;
    }
    if (!isJamReturnContextValid(context, this.props.jams.workspaces)) {
      clearJamReturnContext(this.props.tab, profileId);
      this.resetListingForProfile();
      return;
    }
    const jam = this.props.jams.workspaces[context.jamId];
    const matchingEntries = filterJamEntries(jam, context);
    const lastPage = Math.max(
      0,
      Math.ceil(matchingEntries.length / PAGE_SIZE) - 1
    );
    this.setState(
      {
        selectedJamId: context.jamId,
        search: context.search,
        sort: context.sort,
        rating: context.rating,
        platform: context.platform,
        installation: context.installation,
        page: Math.min(context.page, lastPage),
        randomSeed: context.randomSeed,
      },
      () => {
        if (
          this.props.profileId !== profileId ||
          this.props.jams.profileId !== profileId
        )
          return;
        const list = this.listRef.current;
        if (list) list.scrollTop = context.scrollTop;
      }
    );
  };

  resetListingForProfile = () => {
    this.setState({
      selectedJamId: undefined,
      search: "",
      page: 0,
      sort: "popular",
      rating: "all",
      platform: "",
      installation: "all",
      randomSeed: Math.floor(Math.random() * 0x100000000),
      confirmDownload: false,
      confirmRemove: false,
      confirmUninstall: undefined,
    });
    if (this.listRef.current) this.listRef.current.scrollTop = 0;
  };

  selectedJam = (props: Props, state: State) =>
    Object.values(props.jams.workspaces).find(
      (jam) => jam.id === state.selectedJamId
    ) ||
    Object.values(props.jams.workspaces).sort(
      (a, b) => b.importedAt - a.importedAt
    )[0];

  onImport = (event: React.FormEvent) => {
    event.preventDefault();
    const url = this.state.url.trim();
    if (url) {
      this.props.dispatch(actions.jamImport({ url }));
      this.setState({
        selectedJamId: undefined,
        confirmDownload: false,
        confirmRemove: false,
        confirmUninstall: undefined,
      });
    }
  };

  saveReturnContext = () => {
    if (
      this.props.profileId == null ||
      this.props.jams.profileId !== this.props.profileId
    )
      return;
    const selected = this.selectedJam(this.props, this.state);
    if (selected) {
      saveJamReturnContext(this.props.tab, this.props.profileId, {
        jamId: selected.id,
        search: this.state.search,
        sort: this.state.sort,
        rating: this.state.rating,
        platform: this.state.platform,
        installation: this.state.installation,
        page: this.state.page,
        randomSeed: this.state.randomSeed,
        scrollTop: this.listRef.current?.scrollTop ?? 0,
      });
    }
  };

  navigate = (url: string) => {
    this.saveReturnContext();
    this.props.dispatch(
      actions.evolveTab({
        tab: this.props.tab,
        wind: "root",
        url,
        replace: false,
      })
    );
  };

  override render() {
    const { jams } = this.props;
    if (this.props.profileId == null || jams.profileId !== this.props.profileId)
      return (
        <JamsDiv ref={this.listRef}>
          <Notice>Loading your saved jams…</Notice>
        </JamsDiv>
      );
    const workspaces = Object.values(jams.workspaces).sort(
      (a, b) => b.importedAt - a.importedAt
    );
    const selected =
      workspaces.find((jam) => jam.id === this.state.selectedJamId) ??
      workspaces[0];
    return (
      <JamsDiv ref={this.listRef}>
        <Intro>
          <h1>Game jams</h1>
          <div>
            Experimental jam workspace. Import a public itch.io jam to find its
            entries, install playable games, and rate them on the jam website.
          </div>
        </Intro>

        <ImportForm onSubmit={this.onImport}>
          <input
            aria-label="Public itch.io jam URL"
            placeholder="https://itch.io/jam/your-jam"
            value={this.state.url}
            onChange={(event) => this.setState({ url: event.target.value })}
          />
          <Button
            type="submit"
            primary
            disabled={!jams.ready || !this.state.url.trim() || !!jams.busy}
          >
            {jams.busy?.kind === "import" ? "Importing…" : "Import jam"}
          </Button>
        </ImportForm>

        {jams.error ? (
          <Notice className="error" role="alert">
            {jams.error}
          </Notice>
        ) : null}
        {jams.busy ? this.renderBusy(jams.busy) : null}

        {!jams.ready && !workspaces.length ? (
          <Notice>Loading your saved jams…</Notice>
        ) : null}
        {workspaces.length ? (
          <>
            <JamPicker aria-label="Saved jams">
              {workspaces.map((jam) => (
                <button
                  key={jam.id}
                  className={(selected?.id ?? "") === jam.id ? "active" : ""}
                  onClick={() =>
                    this.setState({
                      selectedJamId: jam.id,
                      page: 0,
                      search: "",
                      confirmDownload: false,
                      confirmRemove: false,
                      confirmUninstall: undefined,
                      rating: "all",
                    })
                  }
                >
                  {jam.title || jam.id}
                </button>
              ))}
            </JamPicker>
            {selected ? this.renderWorkspace(selected) : null}
          </>
        ) : jams.ready ? (
          <Notice>Import a public jam to create your first workspace.</Notice>
        ) : null}
      </JamsDiv>
    );
  }

  renderBusy(busy: NonNullable<JamsState["busy"]>) {
    if (busy.kind === "import") return null;
    return (
      <Notice>
        {busy.kind === "download"
          ? "Preparing jam downloads"
          : "Removing jam installs"}
        : {busy.completed} of {busy.total}
        {busy.kind === "download" ? (
          <>
            {" "}
            · <a href="itch://downloads">Open downloads</a>
          </>
        ) : null}
        <Button onClick={() => this.props.dispatch(actions.jamCancel({}))}>
          {busy.kind === "download" ? "Stop adding games" : "Stop removing"}
        </Button>
      </Notice>
    );
  }

  renderWorkspace(jam: JamSession) {
    const { jams } = this.props;
    const progress = jam.progress ?? {};
    const entries = filterJamEntries(jam, this.state);
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    const page = Math.min(this.state.page, pages - 1);
    const visible = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const counts = jam.entries.reduce<Record<string, number>>(
      (result, entry) => {
        const status = progress[entry.submissionId]?.status ?? "new";
        result[status] = (result[status] ?? 0) + 1;
        return result;
      },
      {}
    );

    return (
      <>
        <h2>{jam.title || "Jam workspace"}</h2>
        <p>
          <a
            href={jam.url}
            onClick={(event) => {
              event.preventDefault();
              this.navigate(jam.url);
            }}
          >
            Browse jam website
          </a>{" "}
          · {jam.entries.length} entries ·{" "}
          {Object.entries(counts)
            .map(([key, value]) => `${value} ${key}`)
            .join(" · ")}
        </p>
        <ListingControls>
          <label>
            Search
            <SearchInput
              aria-label="Search jam entries"
              placeholder="Search entries"
              value={this.state.search}
              onChange={(event) =>
                this.setState({ search: event.target.value, page: 0 })
              }
            />
          </label>
          <label>
            Sort by
            <select
              aria-label="Sort jam games"
              value={this.state.sort}
              onChange={(event) =>
                this.setState({ sort: event.target.value as JamSort, page: 0 })
              }
            >
              <option value="popular">Popular</option>
              <option value="random">Random</option>
              <option value="most_karma">Most karma</option>
              <option value="least_ratings">Least rated</option>
              <option value="most_ratings">Most rated</option>
              <option value="most_comments">Most comments</option>
              <option value="least_comments">Fewest comments</option>
              <option value="created_at_asc">Submission order</option>
              <option value="created_at_desc">Most recently submitted</option>
            </select>
          </label>
          <label>
            My ratings
            <select
              aria-label="Filter by my ratings"
              value={this.state.rating}
              onChange={(event) =>
                this.setState({
                  rating: event.target.value as JamRatingFilter,
                  page: 0,
                })
              }
            >
              <option value="all">All games</option>
              <option value="unrated" disabled={!jam.ratings}>
                Haven’t rated
              </option>
              <option
                value="unrated_team_uncommented"
                disabled={
                  !jam.ratings ||
                  !jam.creatorComments?.ownTeamComplete ||
                  !jam.creatorComments.ownGameIds.length
                }
              >
                Unrated, no comments from my team
              </option>
              <option value="rated" disabled={!jam.ratings}>
                Have rated
              </option>
            </select>
          </label>
          <label>
            Platform
            <select
              aria-label="Filter by platform"
              value={this.state.platform}
              onChange={(event) =>
                this.setState({
                  platform: event.target.value as JamPlatformFilter,
                  page: 0,
                })
              }
            >
              <option value="">Any platform</option>
              <option value="web">Web</option>
              <option value="windows">Windows</option>
              <option value="osx">macOS</option>
              <option value="linux">Linux</option>
            </select>
          </label>
          <label>
            Installation
            <select
              aria-label="Filter by installation"
              value={this.state.installation}
              onChange={(event) =>
                this.setState({
                  installation: event.target.value as JamInstallFilter,
                  page: 0,
                })
              }
            >
              <option value="all">All installations</option>
              <option value="ready">Ready to play</option>
              <option value="not-installed">Not installed</option>
              <option value="kept">Kept</option>
              <option value="attention">Needs attention</option>
            </select>
          </label>
          {this.state.sort === "random" ? (
            <Button
              onClick={() =>
                this.setState({
                  randomSeed: Math.floor(Math.random() * 0x100000000),
                  page: 0,
                })
              }
            >
              Shuffle
            </Button>
          ) : null}
          <Button
            onClick={() =>
              this.setState({
                search: "",
                rating: "all",
                platform: "",
                installation: "all",
                sort: "popular",
                page: 0,
              })
            }
          >
            Clear filters
          </Button>
        </ListingControls>
        <p aria-live="polite">
          Showing {entries.length} of {jam.entries.length} entries
        </p>
        <Controls>
          <Button
            disabled={!jams.ready || !!jams.busy}
            onClick={() =>
              this.props.dispatch(actions.jamImport({ url: jam.url }))
            }
          >
            Refresh entries
          </Button>
          <Button
            disabled={!jams.ready || !!jams.busy || jam.ratingsSyncing}
            onClick={() =>
              this.props.dispatch(actions.jamSyncRatings({ jamId: jam.id }))
            }
          >
            {jam.ratingsSyncing ? "Syncing ratings…" : "Sync my ratings"}
          </Button>
          <Button
            disabled={
              !jams.ready ||
              !!jams.busy ||
              jam.commentsSyncing ||
              jam.commentsAllSyncing ||
              jam.creatorCommentsSyncing
            }
            onClick={() => this.syncVisibleComments(true)}
          >
            {jam.commentsSyncing || jam.creatorCommentsSyncing
              ? "Syncing comments…"
              : "Sync comments"}
          </Button>
          <Button
            onClick={() =>
              this.setState({
                confirmDownload: !this.state.confirmDownload,
                confirmRemove: false,
              })
            }
            disabled={!jams.ready || !jam.entries.length || !!jams.busy}
          >
            Download all
          </Button>
          <Button
            onClick={() =>
              this.setState({
                confirmRemove: !this.state.confirmRemove,
                confirmDownload: false,
              })
            }
            disabled={!jams.ready || !jam.entries.length || !!jams.busy}
          >
            Remove jam installs
          </Button>
        </Controls>
        {jam.commentsSyncing &&
        !jam.commentsAllSyncing &&
        jam.commentsProgress ? (
          <Notice role="status" aria-live="polite">
            Checking comment counts for the current group.
            <CommentProgress
              max={Math.max(1, jam.commentsProgress.total)}
              value={Math.min(
                jam.commentsProgress.completed,
                jam.commentsProgress.total
              )}
              aria-label="Visible comment count sync progress"
            />
            <div>
              Processed {jam.commentsProgress.completed.toLocaleString()} of{" "}
              {jam.commentsProgress.total.toLocaleString()} games this run;{" "}
              {jam.entries
                .filter((entry) => jamCommentCount(jam, entry) !== undefined)
                .length.toLocaleString()}{" "}
              currently have a stored count.
            </div>
          </Notice>
        ) : null}
        {this.state.sort === "most_comments" ||
        this.state.sort === "least_comments" ||
        jam.commentsAllSyncing ? (
          <Notice role="status">
            {this.state.sort === "most_comments" ||
            this.state.sort === "least_comments"
              ? "Sorted by checked top-level comment counts. Games with unchecked counts appear last. Check all counts to sort the whole jam; large jams can take a while."
              : "Checking top-level comment counts for the whole jam."}
            <div>
              {jam.entries
                .filter((entry) => jamCommentCount(jam, entry) !== undefined)
                .length.toLocaleString()}{" "}
              of {jam.entries.length.toLocaleString()} games currently have a
              stored count.
            </div>
            {jam.commentsAllSyncing ? (
              <>
                {jam.commentsAllProgress ? (
                  <CommentProgress
                    max={Math.max(1, jam.commentsAllProgress.total)}
                    value={Math.min(
                      jam.commentsAllProgress.completed,
                      jam.commentsAllProgress.total
                    )}
                    aria-label="Bulk comment count sync progress"
                  />
                ) : null}
                <div>
                  Processed{" "}
                  {jam.commentsAllProgress?.completed.toLocaleString() ?? "0"}{" "}
                  of{" "}
                  {jam.commentsAllProgress?.total.toLocaleString() ??
                    jam.entries.length.toLocaleString()}{" "}
                  games.
                </div>
                <Button
                  onClick={() =>
                    this.props.dispatch(
                      actions.jamSyncAllComments({
                        jamId: jam.id,
                        cancel: true,
                      })
                    )
                  }
                >
                  Stop checking
                </Button>
              </>
            ) : (
              <Button
                disabled={!jams.ready || !!jams.busy}
                onClick={() =>
                  this.props.dispatch(
                    actions.jamSyncAllComments({ jamId: jam.id })
                  )
                }
              >
                Check all comment counts
              </Button>
            )}
          </Notice>
        ) : null}
        {jam.myRatingsError ? (
          <Notice role="status">
            {jam.myRatingsError} Use Sync my ratings to retry.
          </Notice>
        ) : null}
        {jam.myRatingsUnavailable ? (
          <Notice role="status">
            itch.io no longer provides your category scores for{" "}
            {jam.myRatingsUnavailable.toLocaleString()} entries in this
            completed jam. Rated indicators and previously saved scores are
            kept.
          </Notice>
        ) : null}
        {this.state.rating === "unrated_team_uncommented" ||
        jam.teamCommentsSyncing ? (
          <Notice role="status">
            Showing games you haven’t rated and that neither you nor your game’s
            contributors have commented on. Unchecked or incomplete scans stay
            hidden. Checking a large jam can take a while.
            {jam.teamCommentsSyncing ? (
              <>
                <div>
                  Processed{" "}
                  {jam.teamCommentsProgress?.completed.toLocaleString() ?? "0"}{" "}
                  of {jam.teamCommentsProgress?.total.toLocaleString() ?? "0"}{" "}
                  unrated games.
                </div>
                <Button
                  onClick={() =>
                    this.props.dispatch(
                      actions.jamSyncAllCommentAuthors({
                        jamId: jam.id,
                        cancel: true,
                      })
                    )
                  }
                >
                  Stop checking team comments
                </Button>
              </>
            ) : (
              <Button
                disabled={
                  !!jams.busy ||
                  jam.commentsAllSyncing ||
                  !jam.creatorComments?.ownTeamComplete
                }
                onClick={() =>
                  this.props.dispatch(
                    actions.jamSyncAllCommentAuthors({ jamId: jam.id })
                  )
                }
              >
                Check all unrated games for team comments
              </Button>
            )}
          </Notice>
        ) : null}
        {jam.commentAuthorsError ? (
          <Notice role="status">{jam.commentAuthorsError}</Notice>
        ) : null}
        {jam.creatorComments?.ownGameIds.length &&
        !jam.creatorComments.ownTeamComplete ? (
          <Notice>
            Refresh entries, then Sync comments to identify your game’s
            contributors before using the team-comment filter.
          </Notice>
        ) : null}
        <p>
          {jam.ratings
            ? `My ratings last synced ${new Date(
                jam.ratings.syncedAt
              ).toLocaleString()}.`
            : "Sync your itch.io ratings to filter games you have or haven’t rated."}{" "}
          Download all and Remove jam installs apply to the whole jam.
        </p>
        {jam.ratingsError ? (
          <Notice role="status">
            {jam.ratingsError}
            {jam.ratings
              ? " The filters are using your last synced ratings."
              : " Rating filters are unavailable until sync succeeds."}{" "}
            <Button onClick={() => this.navigate(`${jam.url}/entries`)}>
              Open jam website
            </Button>
          </Notice>
        ) : null}
        {jam.creatorComments ? (
          <p>
            {jam.creatorComments.ownGameIds.length
              ? `Creator comments on your entries last checked ${new Date(
                  jam.creatorComments.syncedAt
                ).toLocaleString()}.`
              : jam.creatorComments.complete
              ? "No entries for this account were found in this jam."
              : "Your jam entries could not be fully checked."}
            {!jam.creatorComments.complete
              ? " Some comments could not be checked; only confirmed matches are shown."
              : ""}
          </p>
        ) : null}
        {jam.commentsError || jam.creatorCommentsError ? (
          <Notice role="status">
            {jam.commentsError ? <div>{jam.commentsError}</div> : null}
            {jam.creatorCommentsError ? (
              <div>{jam.creatorCommentsError}</div>
            ) : null}
            Previously checked comments are kept. Use Sync comments to retry.
          </Notice>
        ) : null}
        {jam.entries.length > 0 &&
        !jam.entries.some(
          (entry) =>
            entry.ratingCount !== undefined || entry.jamEntryId !== undefined
        ) ? (
          <Notice>
            Use Refresh entries to load rating counts, karma, and submission
            order for this saved jam.
          </Notice>
        ) : null}
        {this.state.confirmDownload ? (
          <Notice>
            Games will use your default install location. Compatible native
            builds are preferred; downloadable web builds are used when needed.
            Multiple builds require a choice. Purchases are handled on itch.io.
            Downloads continue in the download manager after this preparation
            finishes.
            <Controls>
              <Button
                primary
                onClick={() => {
                  this.props.dispatch(
                    actions.jamDownloadAll({ jamId: jam.id })
                  );
                  this.setState({ confirmDownload: false });
                }}
              >
                Start downloads
              </Button>
              <Button onClick={() => this.setState({ confirmDownload: false })}>
                Cancel
              </Button>
            </Controls>
          </Notice>
        ) : null}
        {this.state.confirmRemove ? (
          <Notice>
            This removes installs created by this jam workspace that you have
            not kept and that are not shared with another jam. Existing installs
            are preserved. Installed save files may be removed with the game.
            <Controls>
              <Button
                primary
                onClick={() => {
                  this.props.dispatch(actions.jamRemoveAll({ jamId: jam.id }));
                  this.setState({ confirmRemove: false });
                }}
              >
                Remove jam installs
              </Button>
              <Button onClick={() => this.setState({ confirmRemove: false })}>
                Cancel
              </Button>
            </Controls>
          </Notice>
        ) : null}
        <EntryList>
          {visible.map((entry) => {
            const item = progress[entry.submissionId];
            return this.renderEntry(
              jam,
              entry,
              item?.status ?? "new",
              item?.message,
              item?.kept ?? false,
              item?.game?.type,
              item?.candidates
            );
          })}
        </EntryList>
        {!entries.length ? (
          <Notice>
            No games match these filters. Try clearing a filter or changing your
            search.
          </Notice>
        ) : null}
        <Controls>
          <Button
            disabled={page === 0}
            onClick={() => this.setState({ page: page - 1 })}
          >
            Previous
          </Button>
          <span>
            Page {page + 1} of {pages}
          </span>
          <Button
            disabled={page + 1 >= pages}
            onClick={() => this.setState({ page: page + 1 })}
          >
            Next
          </Button>
        </Controls>
      </>
    );
  }

  renderEntry(
    jam: JamWorkspace,
    entry: JamEntry,
    status: string,
    message?: string,
    kept = false,
    gameType?: GameType,
    candidates?: Upload[]
  ) {
    const { dispatch } = this.props;
    const ready = status === "ready";
    const webAvailable =
      !!entry.gameUrl &&
      (entry.platforms?.includes("web") ||
        status === "web" ||
        gameType === GameType.HTML);
    const busy = !!this.props.jams.busy;
    const session = this.props.jams.workspaces[jam.id];
    const item = session?.progress[entry.submissionId];
    return (
      <JamGameCard
        key={entry.submissionId}
        entry={entry}
        commentCount={session && jamCommentCount(session, entry)}
        rated={session?.ratings?.ratedGameIds.includes(entry.gameId)}
        myRating={item?.myRating}
        commentsLoading={
          !!session?.commentsSyncingIds?.includes(entry.submissionId)
        }
        refreshingComments={
          !!session?.commentsSyncingIds?.includes(entry.submissionId)
        }
        onRefreshComments={() =>
          dispatch(
            actions.jamSyncOneComment({
              jamId: jam.id,
              submissionId: entry.submissionId,
            })
          )
        }
        creatorCommented={creatorCommentStatus(entry, session?.creatorComments)}
        game={
          this.props.jams.workspaces[jam.id]?.progress[entry.submissionId]?.game
        }
        onOpenGame={() => this.navigate(entry.gameUrl || entry.submissionUrl)}
      >
        <div className="status">
          {status === "attention" ? "Needs attention" : status}
          {message ? ` · ${message}` : ""}
        </div>
        <div className="actions">
          {ready ? (
            <Button
              primary
              disabled={busy}
              onClick={() => {
                this.saveReturnContext();
                dispatch(
                  actions.jamPlay({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                  })
                );
                this.navigate(entry.submissionUrl);
              }}
            >
              Play
            </Button>
          ) : null}
          {webAvailable ? (
            <Button
              onClick={() => {
                this.saveReturnContext();
                dispatch(
                  actions.jamPlay({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                    web: true,
                  })
                );
              }}
            >
              Play web
            </Button>
          ) : null}
          {!ready ? (
            <Button
              onClick={() =>
                dispatch(
                  actions.jamDownloadAll({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                  })
                )
              }
              disabled={busy}
            >
              {status === "new" || status === "removed"
                ? "Install"
                : "Retry install"}
            </Button>
          ) : null}
          {status === "attention" && candidates?.length ? (
            <label>
              Choose build
              <select
                defaultValue=""
                onChange={(event) => {
                  const uploadId = Number(event.target.value);
                  if (uploadId) {
                    dispatch(
                      actions.jamDownloadAll({
                        jamId: jam.id,
                        submissionId: entry.submissionId,
                        uploadId,
                      })
                    );
                    event.target.value = "";
                  }
                }}
                disabled={busy}
              >
                <option value="">Select a compatible build…</option>
                {candidates.map((upload) => (
                  <option key={upload.id} value={upload.id}>
                    {upload.displayName || upload.filename}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button onClick={() => this.navigate(entry.submissionUrl)}>
            Rate &amp; comment
          </Button>
          {item?.caveId ? (
            <Button
              disabled={busy}
              onClick={() =>
                this.setState({
                  confirmUninstall: `${jam.id}:${entry.submissionId}`,
                })
              }
            >
              Uninstall
            </Button>
          ) : null}
          {entry.gameUrl ? (
            <Button onClick={() => this.navigate(entry.gameUrl!)}>
              Open game page
            </Button>
          ) : null}
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={kept}
              onChange={(event) =>
                dispatch(
                  actions.jamKeep({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                    kept: event.target.checked,
                  })
                )
              }
            />{" "}
            Keep installed
          </label>
        </div>
        {this.state.confirmUninstall === `${jam.id}:${entry.submissionId}` ? (
          <Notice role="alert">
            Uninstall {entry.title}? This removes its installed files, including
            a kept copy or one shared with other jams.
            <Button
              disabled={busy}
              onClick={() => {
                this.setState({ confirmUninstall: undefined });
                dispatch(
                  actions.jamRemoveOne({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                  })
                );
              }}
            >
              Confirm uninstall
            </Button>
            <Button
              onClick={() => this.setState({ confirmUninstall: undefined })}
            >
              Cancel
            </Button>
          </Notice>
        ) : null}
      </JamGameCard>
    );
  }
}

export default withTab(
  hook((map) => ({
    jams: map((rs) => rs.jams),
    profileId: map((rs) => rs.profile.profile?.id ?? null),
  }))(JamsPage)
);
