import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptJamReturn,
  createJamReturnDeduplicator,
  isJamRatingRoute,
  probeJamRatingDirty,
} from "main/jams/unsaved-rating";

test("recognizes strict HTTPS jam rating routes with query and hash", () => {
  assert.equal(
    isJamRatingRoute(
      "https://itch.io/jam/gmtk-jam-2026/rate/4817769?x=1#rating"
    ),
    true
  );
  assert.equal(isJamRatingRoute("https://itch.io/jam/a/rate/1/"), true);
});

test("rejects non-rating and non-itch routes", () => {
  for (const url of [
    "http://itch.io/jam/a/rate/1",
    "https://evilitch.io/jam/a/rate/1",
    "https://itch.io.evil.test/jam/a/rate/1",
    "https://user:pass@itch.io/jam/a/rate/1",
    "https://itch.io/jam/a/rate/0",
    "https://itch.io/jam/a/rate/1/other",
    "itch://jams",
  ]) {
    assert.equal(isJamRatingRoute(url), false, url);
  }
});

test("probes the page's own jQuery beforeunload result without reading ratings", () => {
  const globals = globalThis as any;
  const oldDocument = globals.document;
  const oldWindow = globals.window;
  const handlers: Array<() => unknown> = [];
  const fakeWindow: any = {};
  const jquery: any = (target: unknown) => ({
    triggerHandler(event: any) {
      for (const handler of handlers) {
        const result = handler();
        if (result !== undefined) event.result = result;
        if (result === false) event.isDefaultPrevented = () => true;
      }
    },
  });
  jquery.Event = (type: string) => ({
    type,
    isDefaultPrevented: () => false,
  });
  fakeWindow.jQuery = jquery;
  globals.document = {
    querySelector: () => ({ querySelector: () => ({}) }),
  };
  globals.window = fakeWindow;

  try {
    handlers.push(() => "You have unsaved changes");
    handlers.push(() => undefined); // A later clean handler must not erase it.
    assert.deepEqual(probeJamRatingDirty(), {
      formPresent: true,
      hasRatingForm: true,
      dirty: true,
    });

    handlers.length = 0;
    handlers.push(() => undefined);
    assert.deepEqual(probeJamRatingDirty(), {
      formPresent: true,
      hasRatingForm: true,
      dirty: false,
    });

    globals.document = { querySelector: () => null };
    assert.deepEqual(probeJamRatingDirty(), {
      formPresent: false,
      hasRatingForm: false,
      dirty: false,
    });

    globals.document = {
      querySelector: () => ({ querySelector: () => null }),
    };
    assert.deepEqual(probeJamRatingDirty(), {
      formPresent: true,
      hasRatingForm: false,
      dirty: null,
    });
  } finally {
    globals.document = oldDocument;
    globals.window = oldWindow;
  }
});

const dirtyRating = {
  formPresent: true,
  hasRatingForm: true,
  dirty: true,
};

test("dirty rating return stays or leaves according to the confirmation", async () => {
  for (const [leave, expectedNavigation] of [
    [false, false],
    [true, true],
  ]) {
    let navigated = false;
    const result = await attemptJamReturn({
      pageURL: "https://itch.io/jam/jam/rate/19",
      isCurrent: () => true,
      probe: async () => dirtyRating,
      confirm: async (warning) => {
        assert.equal(warning, "dirty");
        return leave;
      },
      navigate: () => {
        navigated = true;
      },
    });
    assert.equal(result, expectedNavigation);
    assert.equal(navigated, expectedNavigation);
  }
});

test("clean rating forms and native game pages return without prompting", async () => {
  for (const pageURL of [
    "https://itch.io/jam/jam/rate/19",
    "itch://games/19",
  ]) {
    let probed = false;
    let confirmed = false;
    let navigated = false;
    const result = await attemptJamReturn({
      pageURL,
      isCurrent: () => true,
      probe: async () => {
        probed = true;
        return { formPresent: true, hasRatingForm: true, dirty: false };
      },
      confirm: async () => {
        confirmed = true;
        return false;
      },
      navigate: () => {
        navigated = true;
      },
    });
    assert.equal(result, true);
    assert.equal(navigated, true);
    assert.equal(confirmed, false);
    assert.equal(probed, pageURL.startsWith("https:"));
  }
});

test("unknown rating state warns and aborts when the page identity changes", async () => {
  let warning: string | undefined;
  let navigated = false;
  const warned = await attemptJamReturn({
    pageURL: "https://itch.io/jam/jam/rate/19",
    isCurrent: () => true,
    probe: async () => ({
      formPresent: true,
      hasRatingForm: false,
      dirty: null,
    }),
    confirm: async (kind) => {
      warning = kind;
      return false;
    },
    navigate: () => {
      navigated = true;
    },
  });
  assert.equal(warned, false);
  assert.equal(warning, "unknown");
  assert.equal(navigated, false);

  let current = true;
  const raced = await attemptJamReturn({
    pageURL: "https://itch.io/jam/jam/rate/19",
    isCurrent: () => current,
    probe: async () => {
      current = false;
      return dirtyRating;
    },
    confirm: async () => true,
    navigate: () => {
      navigated = true;
    },
  });
  assert.equal(raced, false);
  assert.equal(navigated, false);
});

test("a return request stays deduplicated while its prompt is pending", async () => {
  const deduplicate = createJamReturnDeduplicator();
  let release!: () => void;
  let runs = 0;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = deduplicate("root:tab", async () => {
    runs++;
    await blocker;
  });
  await deduplicate("root:tab", async () => {
    runs++;
  });
  assert.equal(runs, 1);
  release();
  await first;
  await deduplicate("root:tab", async () => {
    runs++;
  });
  assert.equal(runs, 2);
});
