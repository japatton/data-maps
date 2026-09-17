// Example records as Studio sees them: the sidecar layout in
// data/examples/, and what has to be true of one before it can be committed.
//
// The layout is the one datamaps/examples.py owns - a directory per
// technology, a file stem that is a dataset id optionally followed by
// `-<label>` - so the two must agree byte for byte or the build rejects what
// Studio wrote.  Nothing here touches the DOM or the network.

// The build flags a record over this as unrepresentative.  A warning, never
// an error: an oversized record is still a real record.
export const MAX_BYTES = 262144;

// What may follow the dataset id in a stem.  Deliberately narrower than the
// filesystem allows: the label reappears in the rendered page and in a
// branch's diff, so it stays lowercase, hyphenated and short.
export const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;

// Where every example lives, and the prefix that tells one apart from a
// YAML file in a commit.
export const EXAMPLES_DIR = "data/examples";

export function exampleStem(dataset, label) {
  const id = text(dataset);
  const tag = text(label);
  return tag === "" ? id : id + "-" + tag;
}

// The build's rule for reading a stem back into a dataset, ported from
// datamaps/examples.py's resolve_stem: dataset ids contain hyphens, so the
// match is longest-prefix and the prefix has to end at the stem's end or at
// a '-' ('nx-alerts' does not match dataset 'nx-alert').
//
// Composing a stem and resolving one are not inverses, which is the whole
// reason this is here: aws-guardduty has datasets `findings` and
// `findings-s3-export`, so a record on `findings` labelled `s3-export`
// composes a stem the build reads as the *other* dataset.  Studio has to
// refuse that rather than write a file that lands somewhere else.
//
// Returns {dataset, label}, both null when no dataset id fits.
export function resolveStem(stem, datasetIds) {
  const value = text(stem);
  const ids = Array.isArray(datasetIds) ? datasetIds : [];
  let best = null;
  for (const raw of ids) {
    const id = text(raw);
    if (id === "") continue;
    if (value !== id && value.indexOf(id + "-") !== 0) continue;
    if (best === null || id.length > best.length) best = id;
  }
  if (best === null) return { dataset: null, label: null };
  if (value === best) return { dataset: best, label: "example" };
  return {
    dataset: best,
    label: value.slice(best.length + 1).replace(/-/g, " "),
  };
}

export function examplePath(tech, stem) {
  return EXAMPLES_DIR + "/" + text(tech) + "/" + text(stem) + ".log";
}

export function isExamplePath(path) {
  return text(path).indexOf(EXAMPLES_DIR + "/") === 0;
}

// UTF-8 bytes, counted by hand rather than through TextEncoder: this module
// is imported by the Node tests as well as the browser, and the count is the
// same rule the build applies to the file on disk.
//
// The content is measured exactly as it stands, never trimmed: the commit
// writes the record byte for byte, and a count that quietly dropped the
// leading and trailing whitespace would disagree with the file on disk.
export function byteLength(content) {
  const value = content === null || content === undefined
    ? "" : String(content);
  let bytes = 0;
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && at + 1 < value.length) {
      // A surrogate pair is one four-byte character, not two three-byte ones.
      bytes += 4;
      at += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function oversize(content) {
  return byteLength(content) > MAX_BYTES;
}

// Whether a technology takes no example records at all, per schema.json's
// examples.excluded (datamaps/examples.py's EXCLUDED).  A schema without the
// key - an older published site - excludes nothing rather than everything.
export function isExcluded(schema, id) {
  const doc = schema && schema.examples ? schema.examples : {};
  const list = Array.isArray(doc.excluded) ? doc.excluded : [];
  return list.indexOf(text(id)) !== -1;
}

// "12.3 KB" / "912 bytes", for the lists in the editor.
export function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "unknown size";
  if (size < 1024) return size + (size === 1 ? " byte" : " bytes");
  return (size / 1024).toFixed(1) + " KB";
}

// One technology's entry in the shell's examples.json, defensively: a site
// built before examples existed has no such document, and a technology with
// no records has no entry in it.  Both views read the listing through this,
// so a load never hands the store something the collision check cannot
// index into.
export function publishedFor(all, id) {
  const doc = all && typeof all === "object" ? all : {};
  const found = doc[String(id === null || id === undefined ? "" : id)];
  return found && typeof found === "object" ? found : {};
}

// The published records for one technology, as a flat list of
// {dataset, label, path, size, stem}.  `published` is the technology's entry
// in examples.json: {dataset: [{label, path, size}]}.
export function publishedList(published) {
  const doc = published && typeof published === "object" ? published : {};
  const out = [];
  for (const dataset of Object.keys(doc).sort()) {
    const rows = Array.isArray(doc[dataset]) ? doc[dataset] : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const label = text(row.label);
      out.push({
        dataset,
        label,
        path: text(row.path),
        size: Number(row.size),
        stem: exampleStem(dataset, label),
      });
    }
  }
  return out;
}

// The published listing with a set of just-committed records folded in.
//
// The shell's examples.json is a snapshot of the last build, so the moment
// a merge request is created it is out of date by exactly the records that
// merge request carries.  Attaching the same stem again in the same session
// has to collide with the branch, not wait for the next deploy to find out.
// A stem the listing already holds is left as it is.
export function withCommitted(published, tech, records) {
  const out = {};
  const doc = published && typeof published === "object" ? published : {};
  for (const dataset of Object.keys(doc)) {
    out[dataset] = Array.isArray(doc[dataset]) ? doc[dataset].slice() : [];
  }
  const seen = publishedList(out).map((row) => row.stem);
  for (const record of (Array.isArray(records) ? records : [])) {
    if (!record) continue;
    const dataset = text(record.dataset);
    const label = text(record.label);
    if (dataset === "") continue;
    const stem = exampleStem(dataset, label);
    if (seen.indexOf(stem) !== -1) continue;
    seen.push(stem);
    if (!Array.isArray(out[dataset])) out[dataset] = [];
    out[dataset].push({
      label,
      // Site-relative, the way examples_json writes it: the editor's link
      // resolves it against the page, not against the repository root.
      path: examplePath(tech, stem).replace(/^data\//, ""),
      size: byteLength(record.content),
    });
  }
  return out;
}

// Everything wrong with one pending record, as the {path, message} issues the
// store re-paths under ["examples", i, ...].
//
// `doc` is the technology document being edited, `published` its entry in
// examples.json, `pending` the *other* pending records (the caller drops the
// one under test, so a record never collides with itself), and `excluded` the
// technology ids that take no examples at all - schema.json's
// examples.excluded, which mirrors datamaps/examples.py's EXCLUDED.
export function validateExample(entry, doc, published, pending, excluded) {
  const issues = [];
  const record = entry && typeof entry === "object" ? entry : {};
  const dataset = text(record.dataset);
  const label = text(record.label);
  const content = record.content === null || record.content === undefined
    ? "" : String(record.content);
  const document_ = doc && typeof doc === "object" ? doc : {};
  const techId = text(document_.id);
  const blocked = Array.isArray(excluded) ? excluded : [];

  if (techId !== "" && blocked.indexOf(techId) !== -1) {
    issues.push({
      path: ["technology"],
      message: "'" + techId + "' takes no example records: its "
        + "documentation is controlled and the build rejects one.",
    });
  }

  const datasets = Array.isArray(document_.datasets) ? document_.datasets : [];
  const known = datasets.some((item) => item && text(item.id) === dataset);
  if (dataset === "") {
    issues.push({ path: ["dataset"], message: "Name the dataset this record "
      + "belongs to." });
  } else if (!known) {
    issues.push({
      path: ["dataset"],
      message: "'" + dataset + "' is not a dataset of this technology.",
    });
  }

  if (label !== "" && !LABEL_RE.test(label)) {
    issues.push({
      path: ["label"],
      message: "The label may hold lowercase letters, digits and hyphens, "
        + "and must start with a letter or a digit.",
    });
  }

  if (dataset !== "" && known && label !== "") {
    // The stem has to resolve back to the dataset it was composed from, or
    // the build files the record under a sibling whose id is a longer
    // prefix of it.  Only a labelled record can go wrong: a bare dataset id
    // always resolves to itself.
    const ids = datasets.map((item) => (item ? text(item.id) : ""));
    const landing = resolveStem(exampleStem(dataset, label), ids).dataset;
    if (landing !== null && landing !== dataset) {
      issues.push({
        path: ["label"],
        message: "The build would read " + exampleStem(dataset, label)
          + ".log as a record of '" + landing + "', not '" + dataset
          + "' — it reads the longest dataset id the stem starts with. "
          + "Choose a label that does not start with '"
          + landing.slice(dataset.length + 1) + "'.",
      });
    }
  }

  if (dataset !== "") {
    const stem = exampleStem(dataset, label);
    const taken = publishedList(published)
      .some((row) => row.stem === stem)
      || (Array.isArray(pending) ? pending : []).some(
        (other) => other && exampleStem(text(other.dataset),
                                        text(other.label)) === stem);
    if (taken) {
      issues.push({
        path: ["label"],
        // A record with no label yet is told to take one; one that already
        // has a label has to be told the label it has is not free.
        message: "There is already a record at " + stem + ".log — "
          + (label === "" ? "give this one a label."
                          : "choose a different label."),
      });
    }
  }

  if (content.trim() === "") {
    issues.push({ path: ["content"], message: "The record is empty." });
  }

  return issues;
}

function text(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}
