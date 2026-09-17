// What a commit from the review screen actually writes: which files, with
// what content, and the defaults offered for branch, commit message and
// merge-request description.
//
// Browser module, but DOM-free and side-effect-free at import time, so the
// Node tests exercise exactly what the view runs.

import { emitTechnology, emitCatalog } from "./yaml-emit.js";
import { describeChanges } from "./diff.js";
import { exampleStem, examplePath, publishedList } from "./examples.js";

export const CATALOG_PATH = "data/catalog.yml";

// The line the merge-request description ends with, so a reader of the MR
// knows where it came from.
export const TRAILER = "Created with Data maps Studio.";

export function technologyPath(id) {
  return `data/technologies/${id}.yml`;
}

// The catalog file is rewritten whenever the row changed - the store labels
// those changes `catalog.<key>` - or the technology is new and has no row in
// the published catalog yet.
export function touchesCatalog(changes, isNew) {
  if (isNew) return true;
  return (changes || []).some((change) =>
    typeof change.label === "string" && change.label.startsWith("catalog."));
}

// The full catalog with `row` in it: replaced in place when the id is already
// there, otherwise inserted after the last row of the same category, so the
// file keeps reading as one block per category.  Appended when the category
// is new to the catalog.
export function catalogRows(catalog, row) {
  const rows = Array.isArray(catalog) ? catalog.slice() : [];
  const id = row ? row.id : undefined;
  const at = rows.findIndex((entry) => entry && entry.id === id);
  if (at !== -1) {
    rows[at] = row;
    return rows;
  }
  let last = -1;
  rows.forEach((entry, index) => {
    if (entry && row && entry.category === row.category) last = index;
  });
  if (last === -1) rows.push(row);
  else rows.splice(last + 1, 0, row);
  return rows;
}

// [{path, content, exists}] in commit order.  `exists` decides create vs
// update for both providers: the technology file exists unless this is a new
// technology, and data/catalog.yml always exists.
//
// `examples` are the store's pending records; each becomes one created file
// under data/examples/<id>/, written verbatim - the build publishes these
// byte for byte and never parses them, so nothing here reformats them.  They
// come last, after the YAML, so the merge request reads document first and
// evidence second.
export function commitFiles({ id, doc, row, catalog, isNew, changes,
                              examples } = {}) {
  const files = [{
    path: technologyPath(id),
    content: emitTechnology(doc),
    exists: !isNew,
  }];
  if (touchesCatalog(changes, isNew)) {
    files.push({
      path: CATALOG_PATH,
      content: emitCatalog({ technologies: catalogRows(catalog, row) }),
      exists: true,
    });
  }
  for (const entry of examples || []) {
    if (!entry || typeof entry !== "object") continue;
    files.push({
      path: examplePath(id, exampleStem(entry.dataset, entry.label)),
      content: String(entry.content === null || entry.content === undefined
        ? "" : entry.content),
      exists: false,
    });
  }
  return files;
}

// --- the upstream check ---------------------------------------------------
//
// A commit regenerates whole files from the snapshot the site was built
// from, so a change someone else merged in the meantime would be silently
// reverted by it.  The review screen therefore reads every file it is about
// to update from the default branch and compares it with what Studio would
// emit for the *baseline* - the published document, before this admin's
// edits.  Equal means nothing moved; anything else stops the run.

// What the repository should still hold, keyed by path: the technology file
// as emitted from the baseline document, and the catalog as emitted from the
// published rows, both untouched by the edits under review.
export function baselineFiles({ id, doc, catalog } = {}) {
  const out = {};
  out[technologyPath(id)] = emitTechnology(doc);
  out[CATALOG_PATH] = emitCatalog({
    technologies: Array.isArray(catalog) ? catalog : [],
  });
  return out;
}

// The paths that moved on since the site was built.
//
// `files` is what commitFiles produced, `remote` maps a path to what the API
// returned for it ({exists, content}), and `expected` maps a path to the
// baseline text from baselineFiles.  A file this commit creates is not
// compared (there is nothing upstream yet), nor is one that was never
// fetched or has no baseline text - only a real disagreement is reported.
export function driftedPaths(files, remote, expected) {
  const seen = remote || {};
  const want = expected || {};
  const out = [];
  for (const file of files || []) {
    if (!file || !file.exists) continue;
    const found = seen[file.path];
    if (!found) continue;
    if (typeof want[file.path] !== "string") continue;
    if (!found.exists || !sameText(found.content, want[file.path])) {
      out.push(file.path);
    }
  }
  return out;
}

// Line endings and the trailing newline are not a change worth blocking a
// merge request over; anything else is.
function sameText(a, b) {
  return normalize(a) === normalize(b);
}

function normalize(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "");
}

// Why one path is in that list: "missing" when the branch has no such file
// at all, "changed" when it has one and it disagrees.  `remote` is the entry
// the provider's readFile returned for the path.
//
// The two are not the same problem.  A file Studio expects to update and
// cannot find upstream usually means the token cannot see it or the base
// branch is not the one the site was built from - not that a colleague
// edited it - and telling an admin to wait for a rebuild in that case sends
// them to wait for something that will never happen.
export function driftReason(remote) {
  return remote && remote.exists ? "changed" : "missing";
}

// What the admin is told, naming the files and the way out.  There is no
// "commit anyway": the file Studio holds was built from a snapshot that no
// longer matches the branch, so committing it would revert someone's work.
//
// `reasons` maps a path to its driftReason; a path with no entry (and the
// one-argument call the review screen used before reasons existed) reads as
// "changed".  `branch` names the branch the files were read from.
export function driftMessage(paths, reasons, branch) {
  const why = reasons || {};
  const where = branch || "the default branch";
  const missing = [];
  const changed = [];
  for (const path of paths || []) {
    if (why[path] === "missing") missing.push(path);
    else changed.push(path);
  }
  const sentences = [];
  if (changed.length) {
    sentences.push(`${changed.join(", ")} changed in the repository since `
      + "this site was built.");
  }
  if (missing.length) {
    sentences.push(`${missing.join(", ")} does not exist on ${where} — `
      + "the token may not be allowed to read it, or the site was built "
      + "from a different branch.");
  }
  const head = sentences.join(" ");
  return (head === "" ? "" : head + " ")
    + "Wait for the site to rebuild, then reload Studio — reopening the "
    + "technology is not enough, because Studio keeps the snapshot it "
    + "loaded at start-up. Make your change again by hand against the new "
    + "file. Do not resume the older draft: it would put back the values "
    + "it was written against and undo the newer published edits. The "
    + "YAML fallback and a merge by hand also work.";
}

// Local time, because the admin reading the branch name is the one who made
// it: studio/cisco-asa-20260901-1432.
export function defaultBranchName(id, now = new Date()) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}`
    + `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `studio/${id}-${stamp}`;
}

export function defaultCommitMessage(name, count) {
  const total = Number(count) || 0;
  const plural = total === 1 ? "change" : "changes";
  return `${name}: ${total} ${plural} via Studio`;
}

// A raw record is captured output, and no validator can tell an address from
// a name in it.  The one thing Studio can do is make sure the reviewer is
// told, in the description they are about to approve, that this merge request
// carries some.
export function exampleNotice(count) {
  const total = Number(count) || 0;
  if (total <= 0) return "";
  return `Contains ${total} example record(s): review for sensitive content `
    + "before merging.";
}

export function defaultDescription(changes, examples) {
  const parts = [];
  const list = describeChanges(changes || []);
  if (list) parts.push(list);
  const notice = exampleNotice((examples || []).length);
  if (notice) parts.push(notice);
  parts.push(TRAILER);
  return parts.join("\n\n");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

// The catalog without `id`.  Nothing is reordered: a delete is not the place
// to rewrite the rest of the file, and a reviewer should see one row gone.
export function catalogRowsWithout(catalog, id) {
  const rows = Array.isArray(catalog) ? catalog : [];
  return rows.filter((entry) => !entry || entry.id !== id);
}

// Everything a whole-technology delete writes, in commit order: the document
// first so the merge request reads as a removal, then the catalog that stops
// pointing at it, then the evidence.
//
// `examples` is the technology's entry in examples.json - which is a snapshot
// of the last build, so a record committed since then is not here and is not
// deleted.  The confirm screen says so; see the spec.
export function deleteFiles({ id, catalog, examples } = {}) {
  const files = [{ path: technologyPath(id), remove: true }];
  files.push({
    path: CATALOG_PATH,
    content: emitCatalog({ technologies: catalogRowsWithout(catalog, id) }),
    exists: true,
  });
  for (const record of publishedList(examples)) {
    // record.path is the site-relative path examples.json carries
    // ("examples/<id>/<stem>.log") - not a path in the repository, which
    // always has "data/" in front.  Rebuild it from the stem the same way
    // commitFiles does for a record just attached, so a delete removes the
    // file that is actually there instead of 404ing on one that never was.
    if (record.stem) files.push({ path: examplePath(id, record.stem), remove: true });
  }
  return files;
}
