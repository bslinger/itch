import React, { useState } from "react";
import { Game, GameType } from "common/butlerd/messages";
import { JamEntry, normalizeJamCoverUrl } from "common/jams/model";
import { jamKarma } from "common/jams/listing";
import { JamPersonalRating } from "common/jams/state";
import styled from "renderer/styles";

const Card = styled.article`
  min-width: 0;
  color: ${(props) => props.theme.baseText};

  a {
    color: inherit;
    text-decoration: none;
  }
  a:hover .game-title {
    text-decoration: underline;
  }
  a:focus-visible {
    outline: 2px solid ${(props) => props.theme.accent};
    outline-offset: 4px;
  }
`;

const Cover = styled.div`
  position: relative;
  aspect-ratio: 5 / 4;
  overflow: hidden;
  background: ${(props) => props.theme.itemBackground};

  img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }
  .cover-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    color: ${(props) => props.theme.secondaryText};
    font-size: 12px;
  }
`;

const TitleRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 7px;

  h3 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    line-height: 20px;
    font-weight: bold;
  }
  .platforms {
    flex-shrink: 0;
    max-width: 50%;
    font-size: 10px;
    font-weight: bold;
    line-height: 16px;
    letter-spacing: 0.02em;
    text-align: right;
  }
`;

const Tags = styled.div`
  margin-top: 2px;
  color: ${(props) => props.theme.accent};
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Description = styled.p`
  margin: 3px 0 0;
  color: ${(props) => props.theme.secondaryText};
  font-size: 12px;
  line-height: 18px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
`;

const JamControls = styled.div`
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);

  .status {
    color: ${(props) => props.theme.secondaryText};
    font-size: 12px;
    line-height: 18px;
    margin-bottom: 8px;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .actions button {
    min-width: 0;
    min-height: 30px;
    font-size: 12px;
    padding: 4px 9px;
  }
  label {
    display: inline-flex;
    gap: 5px;
    align-items: center;
    font-size: 12px;
    max-width: 100%;
  }
  select {
    min-width: 0;
    max-width: 100%;
  }
`;

const Metrics = styled.div`
  margin-top: 5px;
  color: ${(props) => props.theme.secondaryText};
  font-size: 11px;
  line-height: 17px;
`;

const CommentMetadata = styled.div`
  margin-top: 2px;
  color: ${(props) => props.theme.secondaryText};
  font-size: 11px;
  line-height: 17px;

  .creator-commented {
    color: ${(props) => props.theme.accent};
  }
`;

const PLATFORM_LABELS: Record<string, string> = {
  web: "WEB",
  windows: "WIN",
  osx: "MAC",
  linux: "LINUX",
  android: "ANDROID",
  ios: "iOS",
};

interface Props {
  entry: JamEntry;
  game?: Game;
  onOpenGame: () => void;
  /** Known public comment count; zero is a verified count. */
  commentCount?: number;
  /** Whether the game's primary creator commented on the user's jam game. */
  creatorCommented?: boolean;
  /** True while the controller is checking public comments. */
  commentsLoading?: boolean;
  rated?: boolean;
  myRating?: JamPersonalRating;
  children?: React.ReactNode;
}

/** The Explore-style game presentation, with jam controls below the game details. */
export default function JamGameCard({
  entry,
  game,
  onOpenGame,
  commentCount,
  creatorCommented,
  commentsLoading,
  rated,
  myRating,
  children,
}: Props) {
  const coverUrl =
    normalizeJamCoverUrl(game?.coverUrl) ||
    normalizeJamCoverUrl(entry.coverUrl);
  const [failedCover, setFailedCover] = useState<string>();
  const platforms = new Set(entry.platforms || []);
  if (game?.platforms) {
    for (const platform of Object.keys(game.platforms)) {
      if (game.platforms[platform as keyof typeof game.platforms])
        platforms.add(platform);
    }
  }
  if (game?.type === GameType.HTML) platforms.add("web");
  const platformLabels = Object.keys(PLATFORM_LABELS)
    .filter((platform) => platforms.has(platform))
    .map((platform) => PLATFORM_LABELS[platform]);
  const description = game?.shortText || entry.shortText;
  const title = game?.title || entry.title;
  const karma = jamKarma(entry);
  const categories = myRating?.categories || [];
  const ratingScale =
    categories.length &&
    categories.every((category) => category.max === categories[0].max)
      ? categories[0].max
      : undefined;
  const ratingText = myRating
    ? `${Number(myRating.average.toFixed(2))}${
        ratingScale ? `/${ratingScale}` : ""
      }`
    : undefined;
  const ratingDetails = categories
    .map(
      (category) =>
        `${category.name}: ${category.value}${
          category.max ? `/${category.max}` : ""
        }`
    )
    .join("\n");

  return (
    <Card data-game-id={entry.gameId}>
      <a
        href={entry.gameUrl || entry.submissionUrl}
        onClick={(event) => {
          event.preventDefault();
          onOpenGame();
        }}
        aria-label={`Open ${title}`}
      >
        <Cover>
          {coverUrl && coverUrl !== failedCover ? (
            <img
              src={coverUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setFailedCover(coverUrl)}
            />
          ) : (
            <span className="cover-placeholder">No cover available</span>
          )}
        </Cover>
        <TitleRow>
          <h3 className="game-title" title={title}>
            {title}
          </h3>
          {platformLabels.length ? (
            <span className="platforms" title={platformLabels.join(" · ")}>
              {platformLabels.join(" · ")}
            </span>
          ) : null}
        </TitleRow>
      </a>
      {entry.tags?.length ? (
        <Tags>
          {entry.tags
            .slice(0, 3)
            .map((tag) => `#${tag.replace(/^#/, "")}`)
            .join(", ")}
        </Tags>
      ) : null}
      {description ? <Description>{description}</Description> : null}
      {entry.ratingCount !== undefined ? (
        <Metrics>
          {entry.ratingCount.toLocaleString()}{" "}
          {entry.ratingCount === 1 ? "rating" : "ratings"}
          {karma !== undefined ? ` · Karma ${karma.toFixed(2)}` : ""}
        </Metrics>
      ) : null}
      <CommentMetadata aria-live={commentsLoading ? "polite" : undefined}>
        {rated ? (
          <div
            className="my-rating"
            title={ratingDetails || undefined}
            tabIndex={ratingDetails ? 0 : undefined}
          >
            ★{" "}
            {ratingText
              ? `${
                  categories.length > 1 ? "Your average" : "Your rating"
                }: ${ratingText}`
              : "You rated this game"}
          </div>
        ) : null}
        {commentsLoading ? (
          <div>Loading comments…</div>
        ) : commentCount !== undefined ? (
          <div>
            {commentCount.toLocaleString()}{" "}
            {commentCount === 1 ? "comment" : "comments"}
          </div>
        ) : (
          <div>Comments not checked</div>
        )}
        {creatorCommented === true ? (
          <div className="creator-commented">
            Creator commented on your game
          </div>
        ) : null}
      </CommentMetadata>
      {children ? <JamControls>{children}</JamControls> : null}
    </Card>
  );
}
