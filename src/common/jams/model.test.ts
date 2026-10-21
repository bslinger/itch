import { test } from "node:test";
import assert from "node:assert/strict";
import { Upload, UploadStorage, UploadType } from "common/butlerd/messages";
import {
  canRemoveJamInstall,
  chooseHtmlFallback,
  chooseNativeUpload,
  normalizeGameUrl,
  normalizeJamUrl,
  normalizeSubmissionUrl,
  parseJamSubmissionMetadata,
  JamInstallOwnership,
} from "common/jams/model";

function upload(
  id: number,
  type: UploadType,
  overrides: Partial<Upload> = {}
): Upload {
  return {
    id,
    storage: UploadStorage.Hosted,
    filename: `upload-${id}.zip`,
    displayName: `Upload ${id}`,
    size: 1024,
    channelName: "",
    type,
    preorder: false,
    demo: false,
    platforms: {},
    ...overrides,
  };
}

test("jam URLs normalize only strict itch.io jam pages", () => {
  assert.equal(
    normalizeJamUrl("https://itch.io/jam/summer-jam/"),
    "https://itch.io/jam/summer-jam"
  );
  for (const url of [
    "http://itch.io/jam/summer-jam",
    "https://itch.io.evil.test/jam/summer-jam",
    "https://evil.test@itch.io/jam/summer-jam",
    "https://itch.io:443/jam/summer-jam",
    "https://itch.io/jam/summer-jam?next=https://evil.test",
    "https://itch.io/jam/summer-jam#fragment",
    "https://itch.io/jam/%2e%2e/other",
    "https://itch.io/jam/summer-jam/rate/123",
  ]) {
    assert.equal(normalizeJamUrl(url), undefined, url);
  }
});

test("submission URLs require a jam rating route with a positive numeric id", () => {
  assert.equal(
    normalizeSubmissionUrl("https://itch.io/jam/summer-jam/rate/123/"),
    "https://itch.io/jam/summer-jam/rate/123"
  );
  for (const url of [
    "https://itch.io/rate/123",
    "https://itch.io/jam/summer-jam/rate/0",
    "https://itch.io/jam/summer-jam/rate/1/extra",
    "https://itch.io/jam/summer-jam/rate/123?redirect=evil",
    "//itch.io/jam/summer-jam/rate/123",
  ]) {
    assert.equal(normalizeSubmissionUrl(url), undefined, url);
  }
});

test("submission metadata is validated and canonicalized", () => {
  assert.deepEqual(
    parseJamSubmissionMetadata({
      url: "https://itch.io/jam/summer-jam/rate/456/",
      gameId: 789,
      title: "  Tiny Game  ",
      gameUrl: "https://maker.itch.io/tiny-game/",
    }),
    {
      submissionId: "456",
      submissionUrl: "https://itch.io/jam/summer-jam/rate/456",
      jamUrl: "https://itch.io/jam/summer-jam",
      jamSlug: "summer-jam",
      gameId: 789,
      title: "Tiny Game",
      gameUrl: "https://maker.itch.io/tiny-game",
    }
  );
  assert.equal(normalizeGameUrl("https://itch.io/jam/summer-jam"), undefined);
  assert.equal(
    parseJamSubmissionMetadata({
      submissionUrl: "https://itch.io/jam/summer-jam/rate/456",
      submissionId: "999",
      gameId: 789,
      title: "Tiny Game",
    }),
    undefined
  );
  assert.equal(
    parseJamSubmissionMetadata({
      submissionUrl: "https://itch.io/jam/summer-jam/rate/456",
      gameId: 789,
      title: " ",
    }),
    undefined
  );
});

test("upload choices filter unsuitable builds and report ambiguity", () => {
  const native = upload(1, UploadType.Default);
  const html = upload(2, UploadType.HTML);
  const candidates = [
    native,
    upload(3, UploadType.Default, { demo: true }),
    upload(4, UploadType.Default, { preorder: true }),
    upload(5, UploadType.Soundtrack),
    html,
    upload(6, UploadType.HTML, { demo: true }),
  ];
  assert.deepEqual(chooseNativeUpload(candidates), {
    status: "selected",
    upload: native,
  });
  assert.deepEqual(chooseHtmlFallback(candidates), {
    status: "selected",
    upload: html,
  });
  assert.equal(
    chooseNativeUpload([native, upload(7, UploadType.Default)]).status,
    "ambiguous"
  );
  assert.deepEqual(chooseNativeUpload([native, { ...native }]), {
    status: "selected",
    upload: native,
  });
  assert.deepEqual(chooseNativeUpload([]), { status: "none" });
});

test("jam cleanup keeps preexisting, retained, and shared installs", () => {
  const record: JamInstallOwnership = {
    caveId: "cave-a",
    gameId: 10,
    uploadId: 20,
    jamIds: ["jam-a"],
    createdByJam: true,
    preexisting: false,
    kept: false,
  };
  assert.equal(canRemoveJamInstall(record, "jam-a"), true);
  assert.equal(
    canRemoveJamInstall({ ...record, createdByJam: false }, "jam-a"),
    false
  );
  assert.equal(
    canRemoveJamInstall({ ...record, preexisting: true }, "jam-a"),
    false
  );
  assert.equal(canRemoveJamInstall({ ...record, kept: true }, "jam-a"), false);
  assert.equal(
    canRemoveJamInstall({ ...record, jamIds: ["jam-a", "jam-b"] }, "jam-a"),
    false
  );
  assert.equal(canRemoveJamInstall(record, "jam-b"), false);
});
