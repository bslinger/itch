import { Cave, Game, Upload, UploadType } from "common/butlerd/messages";

export interface JamWorkspace {
  id: string;
  /** Canonical itch.io jam page URL. */
  url: string;
  title: string;
  entries: JamEntry[];
}

export interface JamEntry {
  submissionId: string;
  /** Canonical itch.io rating URL for this submission. */
  submissionUrl: string;
  gameId: number;
  title: string;
  gameUrl?: string;
  /** Public itch.io cover image URL, when supplied by the entries endpoint. */
  coverUrl?: string;
  shortText?: string;
  platforms?: string[];
  tags?: string[];
}

/** Tracks whether an installed cave belongs exclusively to a jam workspace. */
export interface JamInstallOwnership {
  caveId: Cave["id"];
  gameId: Game["id"];
  uploadId: Upload["id"];
  /** Jam workspaces that reference this cave; multiple ids make it shared. */
  jamIds: string[];
  /** True only when this jam workflow created the install. */
  createdByJam: boolean;
  /** True when this cave existed before the jam workflow began. */
  preexisting: boolean;
  /** User explicitly chose to retain this install. */
  kept: boolean;
}

export interface JamSubmissionMetadata {
  submissionId: string;
  submissionUrl: string;
  jamUrl: string;
  jamSlug: string;
  gameId: number;
  title: string;
  gameUrl?: string;
  coverUrl?: string;
  shortText?: string;
  platforms?: string[];
  tags?: string[];
}

export type UploadChoice<T> =
  | { status: "none" }
  | { status: "selected"; upload: T }
  | { status: "ambiguous"; uploads: T[] };

const JAM_PATH = /^\/jam\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/?$/;
const SUBMISSION_PATH =
  /^\/jam\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/rate\/([1-9][0-9]*)\/?$/;

function parseItchUrl(input: unknown): URL | undefined {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim()
  ) {
    return undefined;
  }
  // URL normalizes an explicit default port away, so check the raw authority
  // before parsing to keep the accepted URL form unambiguous.
  if (!/^https:\/\/itch\.io(?:\/|$)/.test(input)) return undefined;

  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "itch.io" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

export function normalizeJamUrl(input: unknown): string | undefined {
  const url = parseItchUrl(input);
  const match = url?.pathname.match(JAM_PATH);
  return match ? `https://itch.io/jam/${match[1]}` : undefined;
}

export function normalizeSubmissionUrl(input: unknown): string | undefined {
  const url = parseItchUrl(input);
  const match = url?.pathname.match(SUBMISSION_PATH);
  return match ? `https://itch.io/jam/${match[1]}/rate/${match[2]}` : undefined;
}

export function parseJamSubmissionMetadata(
  input: unknown
): JamSubmissionMetadata | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const metadata = input as Record<string, unknown>;
  const submissionUrl = normalizeSubmissionUrl(
    metadata.submissionUrl ?? metadata.url
  );
  const title = metadata.title;
  const gameUrl =
    metadata.gameUrl === undefined
      ? undefined
      : normalizeGameUrl(metadata.gameUrl);
  const coverUrl = normalizeJamCoverUrl(metadata.coverUrl);
  const shortText = normalizeOptionalText(metadata.shortText, 500);
  const platforms = normalizeJamPlatforms(metadata.platforms);
  const tags = normalizeJamTags(metadata.tags);
  const submissionPathId =
    submissionUrl &&
    new URL(submissionUrl).pathname.match(SUBMISSION_PATH)?.[2];
  if (
    !submissionUrl ||
    !submissionPathId ||
    (metadata.submissionId !== undefined &&
      String(metadata.submissionId) !== submissionPathId) ||
    typeof metadata.gameId !== "number" ||
    !Number.isSafeInteger(metadata.gameId) ||
    metadata.gameId <= 0 ||
    typeof title !== "string" ||
    title.trim().length === 0 ||
    (metadata.gameUrl !== undefined && !gameUrl)
  ) {
    return undefined;
  }

  const parsedUrl = new URL(submissionUrl);
  const match = parsedUrl.pathname.match(SUBMISSION_PATH)!;
  const jamSlug = match[1];

  return {
    submissionId: match[2],
    submissionUrl,
    jamUrl: `https://itch.io/jam/${jamSlug}`,
    jamSlug,
    gameId: metadata.gameId,
    title: title.trim(),
    gameUrl,
    ...(coverUrl ? { coverUrl } : {}),
    ...(shortText ? { shortText } : {}),
    ...(platforms ? { platforms } : {}),
    ...(tags ? { tags } : {}),
  };
}

/** Accept only cover images hosted by itch.io's image CDN. */
export function normalizeJamCoverUrl(input: unknown): string | undefined {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim()
  ) {
    return undefined;
  }
  try {
    const url = new URL(input);
    const authority = input.match(/^https:\/\/([^/?#]*)/)?.[1];
    if (
      url.protocol !== "https:" ||
      url.hostname !== "img.itch.zone" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      authority !== "img.itch.zone" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.startsWith("/")
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeOptionalText(
  input: unknown,
  maxLength: number
): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return value.length > 0 && value.length <= maxLength ? value : undefined;
}

const JAM_PLATFORMS = new Set(["windows", "osx", "linux", "web"]);

function normalizeJamPlatforms(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const values = [
    ...new Set(
      input.filter(
        (value): value is string =>
          typeof value === "string" && JAM_PLATFORMS.has(value)
      )
    ),
  ];
  return values.length ? values : undefined;
}

function normalizeJamTags(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const values = [
    ...new Set(
      input
        .map((value) => {
          const tag =
            typeof value === "string"
              ? value
              : typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                typeof (value as Record<string, unknown>).name === "string"
              ? (value as Record<string, string>).name
              : "";
          return tag.trim();
        })
        .filter((tag) => tag.length > 0 && tag.length <= 80)
        .slice(0, 8)
    ),
  ];
  return values.length ? values : undefined;
}

export function normalizeGameUrl(input: unknown): string | undefined {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim()
  ) {
    return undefined;
  }
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.itch\.io$/.test(url.hostname) ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/[a-z0-9-]+\/?$/.test(url.pathname)
    ) {
      return undefined;
    }
    const authority = input.match(/^https:\/\/([^/?#]*)/)?.[1];
    if (!authority || authority !== url.hostname) return undefined;
    return `https://${url.hostname}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

function chooseOne(items: Upload[]): UploadChoice<Upload> {
  const unique = Array.from(
    new Map(items.map((item) => [item.id, item])).values()
  );
  if (unique.length === 0) return { status: "none" };
  if (unique.length === 1) return { status: "selected", upload: unique[0] };
  return { status: "ambiguous", uploads: unique };
}

/**
 * Picks from uploads that the caller has already determined are compatible
 * with this machine. Default uploads represent executable game builds.
 */
export function chooseNativeUpload(uploads: Upload[]): UploadChoice<Upload> {
  return chooseOne(
    uploads.filter(
      (upload) =>
        upload.type === UploadType.Default && !upload.demo && !upload.preorder
    )
  );
}

/** Selects an HTML upload to offer as the web fallback. */
export function chooseHtmlFallback(uploads: Upload[]): UploadChoice<Upload> {
  return chooseOne(
    uploads.filter(
      (upload) =>
        upload.type === UploadType.HTML && !upload.demo && !upload.preorder
    )
  );
}

export function canRemoveJamInstall(
  ownership: JamInstallOwnership,
  jamId: string
): boolean {
  return (
    ownership.createdByJam &&
    !ownership.preexisting &&
    !ownership.kept &&
    ownership.jamIds.length === 1 &&
    ownership.jamIds[0] === jamId
  );
}
