// #/tech/<id>/review — the hand-off: what changed, which files that writes,
// and the one button that turns them into a merge request.
//
// Nothing here edits the document.  Every remote step reports itself as it
// runs and says why it failed; the YAML fallback below is always populated,
// so an unreachable or CORS-blocked API never leaves the admin stuck.

import { h, clear, downloadText } from "../lib/dom.js";
import { textField, textArea } from "../lib/forms.js";
import { createProvider, webIdeUrl, RepoError } from "../lib/repo.js";
import { explain } from "../lib/net.js";
import { summarizeValue } from "../lib/diff.js";
import {
  commitFiles, defaultBranchName, defaultCommitMessage, defaultDescription,
  baselineFiles,
} from "../lib/review-files.js";
import { runMergeRequest, STEPS, stepLabel } from "../lib/review-flow.js";
import {
  isExamplePath, publishedFor, withCommitted,
} from "../lib/examples.js";

const MARKS = { idle: "·", running: "…", ok: "✓", fail: "✗" };

export function render(root, ctx, params) {
  const id = String((params && params.id) || "");
  // The shell bumps this before every route render, so a load that finishes
  // after the admin has navigated away paints nothing.
  const mine = ctx.generation;
  const store = ctx.store;

  // Arriving straight on this URL (a reload, or a pasted link) means the
  // store holds nothing yet: fetch the published document and the catalog
  // row, then pick up whatever draft this browser kept.
  if (store.id === id && store.doc) {
    paint(root, ctx, id);
    return;
  }
  root.appendChild(h("section", {},
    h("h1", {}, "Review changes"),
    h("p", { class: "mono muted" }, id),
    h("p", { class: "muted" }, "Loading…")));
  loadInto(ctx, id).then(() => {
    if (mine !== ctx.generation) return;
    clear(root);
    paint(root, ctx, id);
  }, (err) => {
    if (mine !== ctx.generation) return;
    clear(root).appendChild(h("section", {},
      h("h1", {}, "Review changes"),
      h("p", { class: "error" },
        `Could not load '${id}': ${messageOf(err)}`),
      backLinks(id)));
  });
}

async function loadInto(ctx, id) {
  const source = await ctx.loadSource(id);
  const row = ctx.catalog.find((entry) => entry && entry.id === id) || null;
  ctx.store.loadTechnology(id, {
    source, catalogRow: row, published: publishedFor(ctx.examples, id),
  });
  const draft = ctx.store.loadDraft(id);
  if (draft) ctx.store.resumeDraft(draft);
}

function paint(root, ctx, id) {
  const store = ctx.store;
  const repo = (ctx.effective() || {}).repository || {};
  const issues = store.errors();

  if (issues.length) {
    root.appendChild(h("section", {},
      h("h1", {}, "Review changes"),
      h("p", { class: "mono muted" }, id),
      h("div", { class: "panel" },
        h("p", { class: "error" },
          `${issues.length} ${plural(issues.length, "problem")} must be `
          + "fixed in the editor before this can be committed."),
        h("ul", { class: "review-issues" },
          issues.map((issue) => h("li", {}, issue.message))),
        backLinks(id))));
    return;
  }

  const changes = store.changes();
  const examples = Array.isArray(store.examples) ? store.examples : [];
  const files = commitFiles({
    id,
    doc: store.doc,
    row: store.row,
    catalog: ctx.catalog,
    isNew: store.isNew,
    changes,
    examples,
  });
  const name = String(store.row.name || store.doc.name || id);
  const branchDefault = defaultBranchName(id);
  const messageDefault = defaultCommitMessage(name, changes.length);

  // Changes that put back what a resumed draft was written against, over a
  // value published since.  The drift guard cannot catch these: it compares
  // the branch with a baseline loaded fresh, and they match.
  const reverts = typeof store.reverts === "function" ? store.reverts() : [];

  const section = h("section", {},
    h("h1", {}, "Review changes"),
    h("p", { class: "mono muted" }, id),
    h("div", { class: "split" },
      h("div", { class: "pane" },
        changesPanel(changes, reverts),
        filesPanel(files, store.isNew, examples.length),
        mergePanel({ ctx, id, repo, files, changes, examples, branchDefault,
                     messageDefault }),
        // The YAML fallback is for the files Studio emits; a raw record is
        // committed byte for byte and has nothing to hand-edit.
        fallbackPanel(repo, files.filter((file) => !isExamplePath(file.path)))),
      h("div", { class: "rail" }, targetPanel(repo, id))));
  root.appendChild(section);
}

// --- panels ---------------------------------------------------------------

function changesPanel(changes, reverts = []) {
  const panel = h("div", { class: "panel" },
    h("h2", {}, `Changes (${changes.length})`));
  if (changes.length === 0) {
    panel.appendChild(h("p", { class: "muted" },
      "Nothing differs from the published files."));
    return panel;
  }
  const reverted = new Set(reverts.map((change) => change.label));
  if (reverted.size) {
    panel.appendChild(h("p", { class: "error" },
      `${reverted.size} of these undo${reverted.size === 1 ? "es" : ""} `
      + "work published after your draft was saved. Resuming the draft put "
      + "the older values back. Check each one marked below before you "
      + "continue — keeping it will revert somebody else's change."));
  }
  panel.appendChild(h("ul", { class: "change-list" },
    changes.map((change) => h("li", {},
      h("code", {}, change.label),
      " ",
      h("span", { class: `change-kind change-${change.kind}` }, change.kind),
      valueTail(change),
      reverted.has(change.label)
        ? h("span", { class: "change-revert" },
            " reverts a change published after your draft")
        : null))));
  return panel;
}

// "`old` → `new`" for a scalar change; nothing for an add, a removal, or a
// reordering, where there is no pair of values worth printing.
function valueTail(change) {
  if (change.kind !== "changed") return null;
  if (change.before === undefined && change.after === undefined) return null;
  return [
    " ",
    h("code", { class: "change-before" }, summarizeValue(change.before)),
    " → ",
    h("code", { class: "change-after" }, summarizeValue(change.after)),
  ];
}

function filesPanel(files, isNew, exampleCount) {
  return h("div", { class: "panel" },
    h("h2", {}, `Files (${files.length})`),
    h("ul", { class: "file-list" },
      files.map((file) => h("li", {},
        h("code", {}, file.path),
        " ",
        h("span", { class: "muted" },
          `${file.exists ? "update" : "new file"}, `
          + `${lineCount(file.content)} lines`)))),
    isNew
      ? h("p", { class: "help" },
        "A new technology: the map file is created and its row is added to "
        + "the catalog.")
      : null,
    exampleCount
      ? h("p", { class: "notice" },
        `${exampleCount} example ${plural(exampleCount, "record")} `
        + "committed verbatim — read them once more before merging: nothing "
        + "here can tell a hostname from a customer name.")
      : null);
}

function targetPanel(repo, id) {
  return h("div", {},
    h("h3", {}, "Target"),
    railRow("Kind", repo.kind),
    railRow("Project", repo.project),
    railRow("API", repo.api_url),
    railRow("Base branch", repo.default_branch),
    railRow("Token", repo.token ? "set" : "not set"),
    h("p", { class: "help" },
      "The token is read from Settings and sent only to this API."),
    h("p", {}, h("a", { href: `#/tech/${encodeURIComponent(id)}` },
                 "Back to the editor")));
}

function railRow(label, value) {
  return h("p", { class: "help" },
    h("span", { class: "field-label" }, label),
    h("span", { class: "mono" }, value ? String(value) : "—"));
}

// --- the merge request ----------------------------------------------------

function mergePanel({ ctx, id, repo, files, changes, examples, branchDefault,
                      messageDefault }) {
  const fields = mergeFields({ branchDefault, messageDefault, changes,
                               examples });
  const progress = stepProgress();
  const blocked = blockedReason(repo, changes);
  const button = h("button", {
    type: "button", class: "btn btn-primary", disabled: Boolean(blocked),
    onclick: () => { create(); },
  }, "Create merge request");

  let running = false;
  // Kept for the error message: the name the failed run actually used.
  let lastBranch = branchDefault;

  function stop() {
    running = false;
    button.disabled = Boolean(blocked);
  }

  async function create() {
    if (running) return;
    running = true;
    button.disabled = true;
    clear(progress.outcome);
    progress.reset();

    // A field emptied (or left as spaces) falls back to its default rather
    // than sending a blank branch name or an empty commit message.  An
    // untouched branch name is stamped now rather than when the page was
    // drawn: a review left open over lunch would otherwise carry a name that
    // says it was made an hour before the branch existed.
    const typedBranch = String(fields.branch.value || "").trim();
    const branchName = (typedBranch === "" || typedBranch === branchDefault)
      ? defaultBranchName(id)
      : typedBranch;
    if (fields.branch.value !== branchName) fields.branch.value = branchName;
    lastBranch = branchName;
    const commitMessage = trimmed(fields.message.value, messageDefault);

    let provider;
    try {
      provider = createProvider(repo.kind, {
        apiUrl: repo.api_url,
        project: repo.project,
        defaultBranch: repo.default_branch,
        token: repo.token,
      });
    } catch (err) {
      // An unknown repository kind: no step ran, so none is marked.
      failed(progress.outcome, { step: null, error: err }, lastBranch);
      stop();
      return;
    }

    const result = await runMergeRequest({
      provider,
      files,
      expected: expectedFiles(ctx, id),
      branch: branchName,
      message: commitMessage,
      title: trimmed(fields.title.value, commitMessage),
      body: String(fields.body.value || ""),
      defaultBranch: repo.default_branch,
      onStep: (key, status, value) => {
        progress.mark(key, status, status === "ok"
          ? stepNote(key, value, branchName, files.length) : "");
      },
    });
    if (!result.ok) {
      failed(progress.outcome, result, lastBranch);
      stop();
      return;
    }
    // The merge request exists by now, and a failure while drawing the
    // outcome or clearing the draft is not a failure of the run - reporting
    // it as one would tell the admin to retry a commit that has already
    // happened.
    succeed(progress.outcome, ctx, id, result.mr);
    // Left disabled on success: the branch now exists and the working
    // document matches it, so a second click could only fail.
    running = false;
  }

  return h("div", { class: "panel" },
    h("h2", {}, "Merge request"),
    fields.nodes,
    h("div", { class: "btn-row" },
      button,
      blocked ? h("span", { class: "muted" }, blocked) : null),
    progress.node);
}

// The four fields the run reads, with the controls behind them.
function mergeFields({ branchDefault, messageDefault, changes, examples }) {
  const branch = textField({
    label: "Branch", value: branchDefault, mono: true,
    help: "Created from the base branch.",
  });
  const message = textField({ label: "Commit message", value: messageDefault });
  const title = textField({ label: "Merge request title", value: messageDefault });
  const body = textArea({
    label: "Description", rows: 8,
    value: defaultDescription(changes, examples),
  });
  return {
    nodes: [branch, message, title, body],
    branch: branch.querySelector("input"),
    message: message.querySelector("input"),
    title: title.querySelector("input"),
    body: body.querySelector("textarea"),
  };
}

// The steps as a checklist the run rewrites in place, with the outcome
// under them.  The run reports itself by rewriting both, neither of which a
// screen reader would otherwise hear about.  One region over the pair: two
// would announce the same run twice and leave the reader to work out that
// they are one story.
function stepProgress() {
  const marks = new Map();
  const steps = h("ol", { class: "steps" });
  for (const [key, label] of STEPS) {
    const mark = h("span", { class: "step-mark step-idle" }, MARKS.idle);
    const note = h("span", { class: "step-note muted" });
    marks.set(key, { mark, note });
    steps.appendChild(h("li", {}, mark, h("span", {}, label), note));
  }
  const outcome = h("div", { class: "review-outcome" });
  function mark(key, state, note) {
    const entry = marks.get(key);
    if (!entry) return;
    entry.mark.className = `step-mark step-${state}`;
    entry.mark.textContent = MARKS[state];
    entry.note.textContent = note || "";
  }
  return {
    node: h("div", { class: "review-progress", "aria-live": "polite" },
            steps, outcome),
    outcome,
    mark,
    reset() {
      for (const [key] of STEPS) mark(key, "idle", "");
    },
  };
}

// What Studio would emit for the published baseline, which is what the drift
// check compares the base branch against.  Never the working document as a
// stand-in: comparing the edited document against the branch would report
// every edit as someone else's change.  With no baseline there is nothing to
// compare, so nothing is claimed.
function expectedFiles(ctx, id) {
  const baseline = ctx.store.baseline || { doc: null, row: null };
  if (baseline.doc === null) return {};
  return baselineFiles({ id, doc: baseline.doc, catalog: ctx.catalog });
}

// The short note each finished step leaves beside its tick.
function stepNote(key, value, branchName, fileCount) {
  if (key === "checkAccess") return (value && value.name) || "";
  if (key === "readFile") {
    // checkUpstream returns {checked, missing}; missing is the delete flow's
    // concern (Task 4's screen), so this note - shared with the ordinary
    // update path - still reports only how many files were compared.
    const checked = (value && value.checked) || 0;
    return `${checked} ${plural(checked, "file")} unchanged`;
  }
  if (key === "createBranch") return branchName;
  if (key === "commit") return `${fileCount} ${plural(fileCount, "file")}`;
  return "";
}

function succeed(outcome, ctx, id, mr) {
  const url = mr && mr.url;
  outcome.appendChild(h("p", { class: "flash" }, "Merge request created."));
  // Only a real web URL becomes a link: the API's answer is data, and a
  // "javascript:" or "data:" href would run it.
  outcome.appendChild(url
    ? (isWebUrl(url)
      ? h("p", {}, h("a", { href: url, target: "_blank", rel: "noopener" },
                     url))
      : h("p", { class: "mono" }, String(url)))
    : h("p", { class: "muted" },
      "The API did not return a URL; look for the branch "
      + "in the repository."));
  outcome.appendChild(h("p", { class: "help" },
    "The draft is cleared and this document is now the baseline, so the "
    + "picker no longer shows it as pending."));
  try {
    ctx.store.clearDraft(id);
    // The branch now holds a file for every attached record, so those
    // records join the published listing before the reload drops them -
    // on the shell's copy too, so the listing survives leaving this view.
    // Without that, re-attaching the same stem in this session would look
    // free until the next build refreshed examples.json, and the commit
    // would try to create a file the branch already has.
    const listing = withCommitted(publishedFor(ctx.examples, id), id,
                                  ctx.store.examples);
    if (ctx.examples && typeof ctx.examples === "object") {
      ctx.examples[id] = listing;
    }
    ctx.store.loadTechnology(id, {
      source: ctx.store.doc, catalogRow: ctx.store.row,
      published: listing,
    });
  } catch (err) {
    outcome.appendChild(h("p", { class: "error" },
      `The merge request was created, but the local draft could not be `
      + `cleared: ${messageOf(err)}`));
  }
}

function failed(outcome, result, lastBranch) {
  const step = result.step;
  const err = result.error;
  if (result.drift) {
    // Not an API failure: the repository answered, and its answer was that
    // this document is out of date.  There is no "commit anyway".
    outcome.appendChild(h("p", { class: "error" }, messageOf(err)));
    outcome.appendChild(h("p", { class: "help" },
      "Nothing was written: the branch is not created until this check "
      + "passes."));
    return;
  }
  // A RepoError carries the endpoint's own status and body; anything else
  // (an unknown repository kind, a file read with no content) says what
  // went wrong in its message.
  outcome.appendChild(h("p", { class: "error" },
    step
      ? `${stepLabel(step)} failed. `
        + (err instanceof RepoError ? explain(err) : messageOf(err))
      : messageOf(err)));
  // Only these two run after the branch exists, so only they can leave
  // something behind for a retry to trip over.
  if (step === "commit" || step === "openMergeRequest") {
    outcome.appendChild(h("p", { class: "help" },
      `The branch '${lastBranch}' was created before this failed; delete `
      + "it in the repository, or edit the branch name, before retrying."));
  }
  outcome.appendChild(h("p", { class: "help" },
    "The YAML below is ready either way: copy it, download it, or open the "
    + "file in the repository's web editor."));
}

function blockedReason(repo, changes) {
  if (!repo.token) return "Set a repository token in Settings first.";
  if (!repo.kind || !repo.api_url || !repo.project) {
    return "The repository is not configured (kind, API URL, project).";
  }
  if (changes.length === 0) return "There is nothing to commit.";
  return null;
}

// --- the fallback ---------------------------------------------------------

function fallbackPanel(repo, files) {
  return h("div", { class: "panel" },
    h("h2", {}, "YAML fallback"),
    h("p", { class: "help" },
      "Commit by hand when the API cannot be reached: copy the file, "
      + "download it, or open it in the repository's web editor."),
    files.map((file, index) => fileDetails(repo, file, index === 0)));
}

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

  // The Web IDE always opens the base branch: it creates its own branch for
  // whatever is edited there.
  const ide = repo.web_ide_url
    ? h("a", {
      class: "btn", target: "_blank", rel: "noopener",
      href: webIdeUrl(repo.web_ide_url, {
        project: repo.project,
        branch: repo.default_branch,
        path: file.path,
      }),
    }, "Open in Web IDE")
    : null;

  return h("details", { class: "yaml-file", open: open ? true : null },
    h("summary", {}, h("code", {}, file.path)),
    area,
    h("div", { class: "btn-row" },
      h("button", { type: "button", class: "btn", onclick: copy }, "Copy"),
      h("button", { type: "button", class: "btn", onclick: download },
        "Download"),
      ide,
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

function lineCount(text) {
  return String(text).replace(/\n$/, "").split("\n").length;
}

function trimmed(value, fallback) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  return text === "" ? fallback : text;
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}
