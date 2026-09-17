// The merge request, as a sequence of remote steps with no DOM in it:
//
//   checkAccess → readFile (the drift check) → createBranch → commit
//   → openMergeRequest
//
// The provider is injected, so the whole run - including every way it can
// fail - is driven from a test with nothing on the network.  views/review.js
// paints what `onStep` reports and what the result says.

import {
  driftedPaths, driftReason, driftMessage,
} from "./review-files.js";

/** The steps in the order they run, with the label the view prints. */
export const STEPS = [
  ["checkAccess", "Check access"],
  ["readFile", "Check upstream"],
  ["createBranch", "Create branch"],
  ["commit", "Commit files"],
  ["openMergeRequest", "Open merge request"],
];

export function stepLabel(key) {
  const found = STEPS.find((entry) => entry[0] === key);
  return found ? found[1] : key;
}

/**
 * Reads every file this commit would update from the base branch and
 * compares it with what Studio would emit for the published baseline.  A
 * difference means the branch moved on since this site was built, and the
 * regenerated file would revert it, so the run stops here - before the branch
 * exists and with nothing to clean up.
 *
 * Returns `{checked, missing}` - `checked` is how many update files were
 * compared; `missing` is the removal paths that are already gone on the base
 * branch.  Throws a drift error when a checked file moved, or when a removal
 * with a baseline (the technology document) changed since this site was
 * built.  With no baseline (`expected` empty) there is nothing to compare, so
 * nothing is claimed.
 */
export async function checkUpstream({ provider, files, expected, branch }) {
  const updates = (files || []).filter((file) => file && file.exists);
  const removals = (files || []).filter((file) => file && file.remove);
  const remote = {};
  for (const file of updates) {
    remote[file.path] = await provider.readFile(file.path, branch);
  }
  // A removal asks whether the path is still there.  One that is already
  // gone is somebody else having done the job, not a conflict.
  //
  // A removal the caller gave a baseline for is also checked for content:
  // that is the technology document, and if it moved since this site was
  // built then deleting it would throw away an edit nobody has seen.  The
  // example logs have no baseline, so they are only checked for existence.
  const missing = [];
  const want = expected || {};
  for (const file of removals) {
    const found = await provider.readFile(file.path, branch);
    if (!found || !found.exists) { missing.push(file.path); continue; }
    if (typeof want[file.path] === "string") remote[file.path] = found;
  }
  const drifted = driftedPaths(
    files.map((file) => (file.remove && typeof want[file.path] === "string"
      ? { path: file.path, exists: true } : file)),
    remote, want);
  if (drifted.length) {
    // Why each path is in that list: a file the branch does not have at all
    // is usually a token that cannot see it or a base branch that is not the
    // one this site was built from, and "wait for the rebuild" is no advice
    // at all for that.
    const reasons = {};
    for (const path of drifted) reasons[path] = driftReason(remote[path]);
    const err = new Error(driftMessage(drifted, reasons, branch));
    err.step = "readFile";
    err.drift = true;
    err.paths = drifted;
    err.reasons = reasons;
    throw err;
  }
  return { checked: updates.length, missing };
}

/**
 * Run the five steps and say what happened.
 *
 *   {ok: true, mr, missing}                     the merge request exists
 *   {ok: false, step, error, missing, drift?}   nothing was written past `step`
 *
 * `missing` lists removal paths that were already gone on the base branch -
 * dropped from the commit rather than treated as a conflict.
 *
 * `onStep(key, status, value)` is called with "running" before each step and
 * "ok" or "fail" after it; `value` is what the step returned (or the error).
 * A failure *after* the merge request was opened is still a success: the
 * request is out there, and telling the admin to retry a commit that has
 * already happened would be worse than saying nothing.
 */
export async function runMergeRequest({ provider, files, expected, branch,
                                        message, title, body, defaultBranch,
                                        onStep }) {
  const report = typeof onStep === "function" ? onStep : () => {};
  const list = files || [];
  let mr = null;
  let at = null;
  let missing = [];

  async function step(key, run) {
    at = key;
    report(key, "running", null);
    const value = await run();
    report(key, "ok", value);
    return value;
  }

  try {
    await step("checkAccess", () => provider.checkAccess());
    const upstream = await step("readFile", () => checkUpstream({
      provider, files: list, expected, branch: defaultBranch,
    }));
    missing = upstream.missing || [];
    // Everything still worth writing: a path that is already gone would make
    // the provider fail a commit that has nothing to do.
    const writing = list.filter((file) => missing.indexOf(file.path) === -1);
    if (writing.length === 0) {
      const err = new Error(
        "Nothing left to delete: every path this would remove is already "
        + "gone from " + defaultBranch + ".");
      err.step = "readFile";
      throw err;
    }
    await step("createBranch", () => provider.createBranch(branch));
    await step("commit", () => provider.commit(branch, message, writing));
    at = "openMergeRequest";
    report("openMergeRequest", "running", null);
    mr = await provider.openMergeRequest(branch, title, body);
    report("openMergeRequest", "ok", mr);
  } catch (err) {
    // Past the point of no return: the request was opened and only the
    // reporting of it failed, so the admin is told about the request.
    if (mr !== null) return { ok: true, mr, missing };
    const key = err && typeof err.step === "string" ? err.step : at;
    report(key, "fail", err);
    const result = { ok: false, step: key, error: err, missing };
    if (err && err.drift) {
      result.drift = { paths: err.paths || [], reasons: err.reasons || {} };
    }
    return result;
  }
  return { ok: true, mr, missing };
}
