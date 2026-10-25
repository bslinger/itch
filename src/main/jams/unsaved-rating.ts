/** True only for an HTTPS itch.io jam submission rating route. */
export function isJamRatingRoute(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "itch.io" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/jam\/[a-z0-9-]+\/rate\/[1-9][0-9]*\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Executed in the page's main world. It asks itch.io's own beforeunload
 * handler whether its rating form is dirty, without reading rating values.
 */
export function probeJamRatingDirty(): {
  formPresent: boolean;
  hasRatingForm: boolean;
  dirty: boolean | null;
} {
  const pageDocument = (globalThis as any).document;
  const pageWindow = (globalThis as any).window;
  const form = pageDocument.querySelector(".criteria_rater form");
  const formPresent = !!form;
  const hasRatingForm = !!form?.querySelector('input[name^="ratings["]');
  if (!formPresent) {
    return { formPresent: false, hasRatingForm: false, dirty: false };
  }
  if (!hasRatingForm) {
    return { formPresent: true, hasRatingForm: false, dirty: null };
  }

  // JamGameVoter's send_dirty_warning handler returns a warning string when
  // its own criteria maps differ. jQuery's triggerHandler runs those handlers
  // without bubbling or invoking browser unload behavior.
  const jquery = pageWindow.jQuery || pageWindow.$;
  if (!jquery?.Event) return { formPresent, hasRatingForm, dirty: null };
  const event = jquery.Event("beforeunload");
  let dirty = false;
  let lastResult: unknown;
  Object.defineProperty(event, "result", {
    configurable: true,
    get: () => lastResult,
    set: (value) => {
      lastResult = value;
      if ((typeof value === "string" && value.length > 0) || value === false) {
        dirty = true;
      }
    },
  });
  jquery(pageWindow).triggerHandler(event);
  return {
    formPresent,
    hasRatingForm: true,
    dirty: dirty || event.isDefaultPrevented(),
  };
}

export type JamRatingWarning = "dirty" | "unknown";

/** Navigation policy kept separate so profile/tab races can be verified. */
export async function attemptJamReturn(options: {
  pageURL: string;
  isCurrent: () => boolean;
  probe: () => Promise<{
    formPresent: boolean;
    hasRatingForm: boolean;
    dirty: boolean | null;
  }>;
  confirm: (warning: JamRatingWarning) => Promise<boolean>;
  navigate: () => void;
  onProbeError?: (error: unknown) => void;
}): Promise<boolean> {
  const { pageURL, isCurrent, probe, confirm, navigate, onProbeError } =
    options;
  if (!isCurrent()) return false;
  let warning: JamRatingWarning | null = null;
  if (isJamRatingRoute(pageURL)) {
    try {
      const result = await probe();
      if (!isCurrent()) return false;
      if (
        !result ||
        typeof result.formPresent !== "boolean" ||
        typeof result.hasRatingForm !== "boolean"
      ) {
        warning = "unknown";
      } else if (result.formPresent) {
        if (!result.hasRatingForm || typeof result.dirty !== "boolean") {
          warning = "unknown";
        } else if (result.dirty) {
          warning = "dirty";
        }
      }
    } catch (error) {
      onProbeError?.(error);
      if (!isCurrent()) return false;
      warning = "unknown";
    }
  }
  if (warning) {
    if (!isCurrent() || !(await confirm(warning)) || !isCurrent()) {
      return false;
    }
  } else if (!isCurrent()) {
    return false;
  }
  navigate();
  return true;
}

export function createJamReturnDeduplicator() {
  const pending = new Set<string>();
  return async (key: string, run: () => Promise<void>) => {
    if (pending.has(key)) return;
    pending.add(key);
    try {
      await run();
    } finally {
      pending.delete(key);
    }
  };
}
