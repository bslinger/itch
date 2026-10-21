import { actions } from "common/actions";
import { GameType, Upload } from "common/butlerd/messages";
import { JamEntry, JamWorkspace } from "common/jams/model";
import { JamSession, JamsState } from "common/jams/state";
import { Dispatch } from "common/types";
import React from "react";
import Button from "renderer/basics/Button";
import { hook } from "renderer/hocs/hook";
import { dispatchTabPageUpdate } from "renderer/hocs/tab-utils";
import { withTab } from "renderer/hocs/withTab";
import { MeatProps } from "renderer/scenes/HubScene/Meats/types";
import JamGameCard from "renderer/pages/JamsPage/JamGameCard";
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
}

interface State {
  url: string;
  selectedJamId?: string;
  search: string;
  page: number;
  confirmDownload: boolean;
  confirmRemove: boolean;
}

const PAGE_SIZE = 50;

class JamsPage extends React.PureComponent<Props, State> {
  override state: State = {
    url: "",
    search: "",
    page: 0,
    confirmDownload: false,
    confirmRemove: false,
  };

  override componentDidMount() {
    this.props.dispatch(actions.jamsLoad({}));
    dispatchTabPageUpdate(this.props, { label: "Jams" });
  }

  onImport = (event: React.FormEvent) => {
    event.preventDefault();
    const url = this.state.url.trim();
    if (url) {
      this.props.dispatch(actions.jamImport({ url }));
      this.setState({
        selectedJamId: undefined,
        confirmDownload: false,
        confirmRemove: false,
      });
    }
  };

  navigate = (url: string) => {
    this.props.dispatch(actions.navigate({ wind: "root", url }));
  };

  override render() {
    const { jams } = this.props;
    const workspaces = Object.values(jams.workspaces).sort(
      (a, b) => b.importedAt - a.importedAt
    );
    const selected =
      workspaces.find((jam) => jam.id === this.state.selectedJamId) ??
      workspaces[0];
    return (
      <JamsDiv>
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
    const entries = jam.entries.filter((entry) => {
      const text = `${entry.title} ${entry.gameUrl ?? ""} ${
        entry.submissionId
      }`.toLowerCase();
      return text.includes(this.state.search.trim().toLowerCase());
    });
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
        <Controls>
          <SearchInput
            aria-label="Search jam entries"
            placeholder="Search entries"
            value={this.state.search}
            onChange={(event) =>
              this.setState({ search: event.target.value, page: 0 })
            }
          />
          <Button
            disabled={!jams.ready || !!jams.busy}
            onClick={() =>
              this.props.dispatch(actions.jamImport({ url: jam.url }))
            }
          >
            Refresh entries
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
    return (
      <JamGameCard
        key={entry.submissionId}
        entry={entry}
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
              onClick={() =>
                dispatch(
                  actions.jamPlay({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                  })
                )
              }
            >
              Play
            </Button>
          ) : null}
          {webAvailable ? (
            <Button
              onClick={() =>
                dispatch(
                  actions.jamPlay({
                    jamId: jam.id,
                    submissionId: entry.submissionId,
                    web: true,
                  })
                )
              }
            >
              Play web
            </Button>
          ) : null}
          {!ready && status !== "removed" ? (
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
              {status === "new" ? "Install" : "Retry install"}
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
      </JamGameCard>
    );
  }
}

export default withTab(
  hook((map) => ({ jams: map((rs) => rs.jams) }))(JamsPage)
);
