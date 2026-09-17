// #/tech/<id>/delete - remove a technology wholly.  The pure parts are
// exported so the gate and the summary are tested without a DOM.

import { h, clear, downloadText } from "../lib/dom.js";
import { explain } from "../lib/net.js";
import { createProvider, RepoError, webIdeUrl } from "../lib/repo.js";
import { runMergeRequest, STEPS, stepLabel } from "../lib/review-flow.js";
import {
  deleteFiles, defaultBranchName, baselineFiles, technologyPath, TRAILER,
} from "../lib/review-files.js";
import { publishedFor } from "../lib/examples.js";

const MARKS = { idle: "·", running: "…", ok: "✓", fail: "✗" };

// Typing the id is the gate: the path list alone does not prove the admin
// read which technology they are on.  Case-sensitive, because ids are.
export function deleteReady(typed, id) {
  return String(typed === null || typed === undefined ? "" : typed).trim()
    === String(id);
}

export function deleteSummary(files) {
  const list = Array.isArray(files) ? files : [];
  const examples = [];
  let removed = 0;
  let rewritten = 0;
  for (const file of list) {
    if (!file) continue;
    if (file.remove) {
      removed += 1;
      if (file.path.indexOf("data/examples/") === 0) examples.push(file.path);
    } else {
      rewritten += 1;
    }
  }
  return { removed, rewritten, examples };
}

// The paths a human has to delete when the API is unreachable.  Only the
// removals: the catalog rewrite is a file with content and is offered for
// download exactly as the review screen offers one.
export function removalChecklist(files) {
  const list = Array.isArray(files) ? files : [];
  const lines = [];
  for (const file of list) {
    if (file && file.remove) lines.push(file.path);
  }
  return lines.join("\n") + "\n";
}

// --- the view -----------------------------------------------------------
//
// Arriving straight on this URL - a reload, a pasted link, back or forward -
// means ctx.sourcesCache holds nothing for this id yet: the published
// document has to be fetched before the delete can be offered, or the drift
// check below has no baseline and silently claims nothing moved.  Same gate,
// and the same ctx.generation guard, views/review.js uses: a load that
// finishes after the admin has navigated away paints nothing.

export function render(root, ctx, params) {
  const id = String((params && params.id) || "");
  const mine = ctx.generation;
  if (ctx.sourcesCache.has(id)) {
    paint(root, ctx, id);
    return;
  }
  root.appendChild(h("section", {},
    h("h1", {}, `Delete ${id}`),
    h("p", { class: "muted" }, "Loading…")));
  ctx.loadSource(id).then(() => {
    if (mine !== ctx.generation) return;
    clear(root);
    paint(root, ctx, id);
  }, (err) => {
    if (mine !== ctx.generation) return;
    clear(root).appendChild(h("section", {},
      h("h1", {}, `Delete ${id}`),
      h("p", { class: "error" },
        `Could not load '${id}': ${messageOf(err)}`),
      backLinks(id)));
  });
}

function paint(root, ctx, id) {
  // Cached by the load above, or already warm because the editor screen
  // this button was clicked from loaded it first.  null means this
  // technology has never been published: there is no document to compare
  // upstream.  data/catalog.yml is published unconditionally, though - a
  // delete always rewrites it - so its baseline is still built and checked
  // even here; only views/review.js's expectedFiles() has no commit to make
  // at all for a brand-new technology and skips the check entirely.
  const source = ctx.sourcesCache.get(id);
  const files = deleteFiles({
    id,
    catalog: ctx.catalog,
    examples: publishedFor(ctx.examples, id),
  });
  const summary = deleteSummary(files);
  // baselineFiles emits the document half with emitTechnology(), which
  // throws on anything that is not a mapping - so a null source cannot be
  // passed straight through.  {} stands in for it and emits harmlessly;
  // the key it produced is then dropped, since there is no published
  // document for this id to compare the branch against.
  const expected = baselineFiles({
    id, doc: source === null ? {} : source, catalog: ctx.catalog,
  });
  if (source === null) delete expected[technologyPath(id)];
  const eff = ctx.effective();
  const blocked = blockedReason(eff.repository);

  let typed = "";
  // Set for the duration of a run, so refresh() - reachable the whole time
  // through the confirm box's oninput - cannot re-enable the button while
  // a delete is in flight, and a second click cannot start a second one.
  let running = false;
  // The branch name the in-flight (or most recently finished) run actually
  // used, for paintResult's branch-exists message.  delete.js has no
  // branch-name field to remember it in the way views/review.js does.
  let lastBranch = null;
  const status = h("div", { class: "review-progress", "aria-live": "polite" });
  const go = h("button", {
    type: "button", class: "btn btn-danger", disabled: true,
    onclick: () => { run(); },
  }, `Delete ${id}`);

  function refresh() {
    go.disabled = running || !deleteReady(typed, id) || Boolean(blocked);
  }

  const confirm = h("input", {
    type: "text", class: "mono", placeholder: id,
    "aria-label": "Type the technology id to confirm",
    oninput: (event) => { typed = event.target.value; refresh(); },
  });

  async function run() {
    // A run makes 1 + N sequential requests against the repository API -
    // seconds, not instant - so there is a real window for the confirm box
    // to be retyped (re-enabling the button through refresh()) or clicked
    // again while the first run is still going.  Both are closed by
    // `running`: refresh() stays shut while it is true, and a call that
    // slips through some other way returns immediately rather than
    // starting a second, concurrent delete.
    if (running) return;
    running = true;
    confirm.disabled = true;
    // A retry after a failure starts clean: the previous outcome and step
    // marks are stale the moment this run begins.
    clear(status);
    go.disabled = true;
    let provider;
    try {
      provider = createProvider(eff.repository.kind, {
        apiUrl: eff.repository.api_url,
        project: eff.repository.project,
        defaultBranch: eff.repository.default_branch,
        token: eff.repository.token,
      });
    } catch (err) {
      // An unknown repository kind: no step ran, so none is marked - the
      // same shape views/review.js's create() reports this failure in.
      paintResult(status, { ok: false, step: null, error: err, missing: [] },
                  files, ctx, lastBranch);
      running = false;
      confirm.disabled = false;
      refresh();
      return;
    }
    // Stamped fresh for this run rather than memoized - the same
    // minute-resolution name a retry inside the same minute would collide
    // with, which is exactly the case paintResult's branch-exists message
    // is for.
    lastBranch = defaultBranchName(id);
    const result = await runMergeRequest({
      provider, files,
      expected,
      branch: lastBranch,
      message: `Delete ${id}`,
      title: `Delete ${id}`,
      body: `Removes ${id}, its catalog row and ${summary.examples.length} example record(s).\n\n${TRAILER}`,
      defaultBranch: eff.repository.default_branch,
      onStep: (key, state) => { paintStep(status, key, state); },
    });
    paintResult(status, result, files, ctx, lastBranch);
    running = false;
    // Both controls stay shut on success, same as views/review.js: the
    // technology is gone and a second run could only duplicate the merge
    // request.  Re-enabling the input alone was enough to undo that - it
    // still holds the matching id, and its oninput calls refresh(), which
    // with `running` back to false re-enables the button.  A failure opens
    // both again - still gated on the confirm text and the token - so a
    // transient error (network, a busy API) can be retried.
    if (!result.ok) {
      confirm.disabled = false;
      refresh();
    }
  }

  clear(root).appendChild(h("section", {},
    h("h1", {}, `Delete ${id}`),
    h("p", { class: "notice" },
      `This removes ${summary.removed} file(s) and rewrites data/catalog.yml. `
      + "It cannot be undone from Studio; recovery is reverting the merge request."),
    h("ul", { class: "file-list" },
      files.map((file) => h("li", {},
        h("code", {}, file.path),
        h("span", { class: "muted" }, file.remove ? " — removed" : " — rewritten")))),
    h("p", { class: "help" },
      "Example records added since this site was last built are not in this "
      + "list and will not be removed."),
    h("p", { class: "field-label" }, `Type ${id} to confirm`),
    confirm,
    blocked ? h("p", { class: "error" }, blocked) : null,
    h("div", { class: "btn-row" }, go,
      h("a", { href: `#/tech/${encodeURIComponent(id)}` }, "Cancel")),
    status));
}

// The same three checks views/review.js's blockedReason() makes for the
// ordinary update, minus its "nothing to commit" case: deleteFiles() always
// includes the catalog rewrite, so that case cannot arise here.
function blockedReason(repo) {
  if (!repo.token) return "Set a repository token in Settings first.";
  if (!repo.kind || !repo.api_url || !repo.project) {
    return "The repository is not configured (kind, API URL, project).";
  }
  return null;
}

// --- the two small painters -----------------------------------------------
//
// The same shape views/review.js's stepProgress()/succeed()/failed() paint,
// copied rather than reinvented: one tick per step, then the outcome.  There
// is nothing to show before the admin clicks Delete, so the checklist is
// built into `status` on the first step reported rather than up front.

function paintStep(status, key, state) {
  let steps = status.querySelector(".steps");
  if (!steps) {
    steps = h("ol", { class: "steps" });
    for (const [stepKey, label] of STEPS) {
      steps.appendChild(h("li", { dataset: { step: stepKey } },
        h("span", { class: "step-mark step-idle" }, MARKS.idle),
        h("span", {}, label)));
    }
    status.appendChild(steps);
  }
  const li = steps.querySelector(`[data-step="${key}"]`);
  if (!li) return;
  const mark = li.querySelector(".step-mark");
  mark.className = `step-mark step-${state}`;
  mark.textContent = MARKS[state] || "";
}

// `ctx` gives the failure branch the repository config it needs for the
// CORS fallback's Web IDE links.  `branchName` is the branch this run
// actually used - null when it failed before one was picked (an unknown
// repository kind) - for the branch-exists message below.
function paintResult(status, result, files, ctx, branchName) {
  if (result.ok) {
    // Counted from what was actually written, not the original pre-drop
    // list: a path runMergeRequest reports in result.missing was already
    // gone upstream and was never part of this commit, so claiming it was
    // removed would overstate what the run did.
    const missing = result.missing || [];
    const written = files.filter(
      (file) => file && missing.indexOf(file.path) === -1);
    const summary = deleteSummary(written);
    // The technology document is the one removal not under data/examples/
    // - deleteFiles() always emits exactly one.  Left out of the sentence
    // when it was already gone upstream (missing), the same way the
    // example count just above already excludes what missing dropped -
    // otherwise a never-published technology's delete would claim a
    // document was removed that was never there to remove.
    const docWritten = written.some((file) =>
      file && file.remove && file.path.indexOf("data/examples/") !== 0);
    status.appendChild(h("p", { class: "flash" },
      "Deleted: "
      + (docWritten ? "the technology document, " : "")
      + "its catalog row and "
      + `${summary.examples.length} example record(s) removed.`));
    const url = result.mr && result.mr.url;
    status.appendChild(url
      ? (isWebUrl(url)
        ? h("p", {}, h("a", { href: url, target: "_blank", rel: "noopener" }, url))
        : h("p", { class: "mono" }, String(url)))
      : h("p", { class: "muted" },
        "The API did not return a URL; look for the branch in the repository."));
  } else {
    const step = result.step;
    const err = result.error;
    status.appendChild(h("p", { class: "error" },
      step
        ? `${stepLabel(step)} failed. `
          + (err instanceof RepoError ? explain(err) : messageOf(err))
        : messageOf(err)));
    // Only these two run after the branch exists, so only they can leave
    // something behind for a retry to trip over - the same rule and the
    // same wording views/review.js's failed() uses for the ordinary update.
    if (step === "commit" || step === "openMergeRequest") {
      status.appendChild(h("p", { class: "help" },
        `The branch '${branchName}' was created before this failed; delete `
        + "it in the repository, or edit the branch name, before retrying."));
    }
    // Blocked by the browser (CORS or unreachable) - the common case at this
    // shop, not the exotic one - gets the paste-by-hand fallback below the
    // error rather than just the message above.  Any other failure (a bad
    // token, an unknown repository kind, drift) has nothing here to add: the
    // admin has to fix that and retry, not work around it by hand.
    if (err && err.cors) paintFallback(status, files, ctx);
  }
  if (result.missing && result.missing.length) {
    status.appendChild(h("p", { class: "notice" },
      `${result.missing.length} path(s) already gone, not removed: `
      + result.missing.join(", ")));
  }
}

// --- the CORS/unreachable fallback -----------------------------------------
//
// A removal has no content, so it cannot be copied or downloaded the way
// views/review.js offers a rewritten file - there is nothing to save.  What
// it gets instead is a link to open the path in the repository's web editor
// and delete it there, plus a plain-text list of every path for pasting into
// a ticket.  The catalog rewrite *is* a file with content, so it gets the
// same Copy/Download/Open-in-Web-IDE offer views/review.js's fallback makes
// for an ordinary update.
function paintFallback(status, files, ctx) {
  const repo = (ctx.effective() || {}).repository || {};
  const rewrites = files.filter((file) => file && !file.remove);
  const removals = files.filter((file) => file && file.remove);

  const panel = h("div", { class: "panel" },
    h("h2", {}, "Delete by hand"),
    h("p", { class: "help" },
      "The repository API could not be reached. Commit the file below, then "
      + "delete each path that follows it directly in the repository."));
  rewrites.forEach((file, index) => {
    panel.appendChild(fileDetails(repo, file, index === 0));
  });
  panel.appendChild(h("h3", {}, "Paths to delete"));
  panel.appendChild(h("ul", { class: "removal-list" },
    removals.map((file) => h("li", {},
      h("code", {}, file.path),
      webIdeLink(repo, file.path)))));
  panel.appendChild(checklistField(files));
  status.appendChild(panel);
}

// The same offer views/review.js's fileDetails() makes for a rewritten file:
// copy it, download it, or open it in the repository's web editor.  Kept
// here rather than shared, because it is view/DOM code, not something
// lib/review-files.js exports.
function fileDetails(repo, file, open) {
  const area = h("textarea", {
    class: "mono yaml-dump", rows: "16", readonly: true, spellcheck: "false",
    value: file.content, "aria-label": file.path,
  });
  const note = h("span", { class: "muted" });
  let timer = null;

  function say(text) {
    note.textContent = text;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { note.textContent = ""; timer = null; }, 3000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(file.content);
      say("Copied.");
    } catch (err) {
      // No clipboard permission, or an insecure origin: select the text so
      // the keyboard shortcut still works.
      area.focus();
      area.select();
      say("Could not copy — the text is selected, use your copy shortcut.");
    }
  }

  function download() {
    downloadText(file.path.split("/").pop(),
                 "text/yaml;charset=utf-8", file.content);
    say("Downloaded.");
  }

  return h("details", { class: "yaml-file", open: open ? true : null },
    h("summary", {}, h("code", {}, file.path)),
    area,
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "btn", onclick: copy }, "Copy"),
      h("button", { type: "button", class: "btn", onclick: download },
        "Download"),
      webIdeLink(repo, file.path),
      note));
}

// The Web IDE always opens the base branch: it creates its own branch for
// whatever is edited there - true of a path being deleted exactly as of one
// being updated.
function webIdeLink(repo, path) {
  return repo.web_ide_url
    ? h("a", {
      class: "btn", target: "_blank", rel: "noopener",
      href: webIdeUrl(repo.web_ide_url, {
        project: repo.project,
        branch: repo.default_branch,
        path,
      }),
    }, "Open in Web IDE")
    : null;
}

// The textarea + Copy button holding removalChecklist(files), for pasting
// the whole list into a ticket in one go rather than one path at a time.
function checklistField(files) {
  const text = removalChecklist(files);
  const area = h("textarea", {
    class: "mono yaml-dump", rows: "6", readonly: true, spellcheck: "false",
    value: text, "aria-label": "Paths to delete",
  });
  const note = h("span", { class: "muted" });
  let timer = null;

  function say(msg) {
    note.textContent = msg;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { note.textContent = ""; timer = null; }, 3000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      say("Copied.");
    } catch (err) {
      area.focus();
      area.select();
      say("Could not copy — the text is selected, use your copy shortcut.");
    }
  }

  return h("div", {},
    h("p", { class: "help" },
      "Every path above, one per line, for pasting into a ticket."),
    area,
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "btn", onclick: copy }, "Copy"),
      note));
}

// --- odds and ends --------------------------------------------------------

function backLinks(id) {
  return h("p", {},
    h("a", { href: `#/tech/${encodeURIComponent(id)}` }, "Back to the editor"),
    " · ",
    h("a", { href: "#/" }, "All technologies"));
}

function isWebUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}
