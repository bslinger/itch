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
  };
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
