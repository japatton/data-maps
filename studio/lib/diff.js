// Structural diff between two catalog documents, rendered for human review.
//
// `diffDocs` walks a "before" and an "after" document and returns a flat list
// of changes.  Every change carries a machine-usable `path` (the sequence of
// keys and indexes that reaches the value in the *after* document, or in the
// *before* document for a removal) and a human `label` that names list items
// by their identity key rather than by index, so an admin reads
// `datasets[connection-events].formats[syslog-raw].fields[reason].notes`
// instead of `datasets[3].formats[1].fields[12].notes`.
//
// Browser module: no imports, no DOM, no side effects at import time.

// Checked in order; the first one an item carries wins.
const IDENTITY_KEYS = ["id", "format", "vendor", "hop"];

// Scalars longer than this are cut short in the rendered summary.
const MAX_SCALAR = 80;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Object.hasOwn is ES2022; Studio's floor is ES2018.
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Structural equality, used both to prune unchanged subtrees and by the store
// to decide whether the working document differs from its baseline.
export function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
      return false;
    }
    return keys.every(
      (key) => hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

// The identity key an item is matched and labelled by, or null when it has
// none (plain scalars, or objects with no recognised key).
function identityKeyOf(item) {
  if (!isPlainObject(item)) {
    return null;
  }
  for (const key of IDENTITY_KEYS) {
    const value = item[key];
    if (typeof value === "string" && value !== "") {
      return key;
    }
  }
  return null;
}

// Match tokens for one list.  Repeated values (several `guard` hops on a
// route, say) are disambiguated by their occurrence number so that the nth
// `guard` before is matched with the nth `guard` after.
function tokensFor(list) {
  const seen = new Map();
  return list.map((item) => {
    const key = identityKeyOf(item);
    if (key === null) {
      return null;
    }
    const base = `${key}:${item[key]}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return `${base}#${count}`;
  });
}

// `datasets` + the item at index 2 becomes `datasets[connection-events]`, or
// `guarded[2] guard` for hops, whose identity is the hop kind plus position.
function itemLabel(listLabel, item, index) {
  const key = identityKeyOf(item);
  if (key === null) {
    return `${listLabel}[${index}]`;
  }
  if (key === "hop") {
    return `${listLabel}[${index}] ${item[key]}`;
  }
  return `${listLabel}[${item[key]}]`;
}

function childLabel(label, key) {
  return label === "" ? String(key) : `${label}.${key}`;
}

export function diffDocs(before, after) {
  const changes = [];
  walk(before, after, [], "", changes);
  return changes;
}

function walk(before, after, path, label, out) {
  if (deepEqual(before, after)) {
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    walkObjects(before, after, path, label, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    walkLists(before, after, path, label, out);
    return;
  }
  out.push({ path, label, kind: "changed", before, after });
}

function walkObjects(before, after, path, label, out) {
  const keys = Object.keys(before);
  for (const key of Object.keys(after)) {
    if (!hasOwn(before, key)) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    const at = path.concat(key);
    const named = childLabel(label, key);
    if (!hasOwn(after, key)) {
      out.push({ path: at, label: named, kind: "removed", before: before[key] });
    } else if (!hasOwn(before, key)) {
      out.push({ path: at, label: named, kind: "added", after: after[key] });
    } else {
      walk(before[key], after[key], at, named, out);
    }
  }
}

// Pairs up the items of two lists.  Items carrying an identity key are
// matched by token wherever they moved to; the rest are matched by their
// position *among the unidentified items*, so a blank row an admin has just
// added does not knock its identified siblings out of alignment.  A list whose
// items all lack identity therefore degrades cleanly to index matching.
function pairItems(beforeTokens, afterTokens) {
  const toAfter = new Map();
  const toBefore = new Map();

  const afterAt = new Map();
  afterTokens.forEach((token, index) => {
    if (token !== null && !afterAt.has(token)) {
      afterAt.set(token, index);
    }
  });
  beforeTokens.forEach((token, index) => {
    if (token !== null && afterAt.has(token)) {
      const at = afterAt.get(token);
      toAfter.set(index, at);
      toBefore.set(at, index);
    }
  });

  const beforeBlanks = [];
  beforeTokens.forEach((token, index) => {
    if (token === null) {
      beforeBlanks.push(index);
    }
  });
  const afterBlanks = [];
  afterTokens.forEach((token, index) => {
    if (token === null) {
      afterBlanks.push(index);
    }
  });
  const paired = Math.min(beforeBlanks.length, afterBlanks.length);
  for (let at = 0; at < paired; at += 1) {
    toAfter.set(beforeBlanks[at], afterBlanks[at]);
    toBefore.set(afterBlanks[at], beforeBlanks[at]);
  }

  return { toAfter, toBefore };
}

function walkLists(before, after, path, label, out) {
  const { toAfter, toBefore } = pairItems(tokensFor(before), tokensFor(after));

  before.forEach((item, index) => {
    if (!toAfter.has(index)) {
      out.push({
        path: path.concat(index),
        label: itemLabel(label, item, index),
        kind: "removed",
        before: item,
      });
    }
  });
  after.forEach((item, index) => {
    if (!toBefore.has(index)) {
      out.push({
        path: path.concat(index),
        label: itemLabel(label, item, index),
        kind: "added",
        after: item,
      });
      return;
    }
    walk(before[toBefore.get(index)], item, path.concat(index),
         itemLabel(label, item, index), out);
  });

  // Items that survived on both sides but changed places are reported once for
  // the list as a whole rather than as a remove/add storm.  Reading off the
  // before-indexes in after-order, a survivor that fell behind one of its old
  // followers means the list was reordered.
  const survivors = [];
  after.forEach((item, index) => {
    if (toBefore.has(index)) {
      survivors.push(toBefore.get(index));
    }
  });
  const reordered = survivors.some(
    (at, index) => index > 0 && at < survivors[index - 1]);
  if (reordered) {
    // `order` marks it as the one kind of change with no before/after value
    // to show, so the renderer never has to infer that from two undefineds.
    out.push({
      path: path.slice(),
      label: `${label} (order)`,
      kind: "changed",
      order: true,
    });
  }
}

function truncate(text) {
  return text.length > MAX_SCALAR
    ? `${text.slice(0, MAX_SCALAR - 1)}…`
    : text;
}

function plural(count, word) {
  return count === 1 ? word : `${word}s`;
}

/**
 * One value, short enough to sit on a change line: a container by its size, a
 * scalar as its own text, cut short past 80 characters.
 *
 * `null` is a value the document can carry (an unmapped field's `ecs`) and is
 * printed as itself; `undefined` is the absence of one - a key that was not
 * there - and is printed as an em dash rather than as a value nothing wrote.
 *
 * Nothing here is quoted or escaped: the caller decides that, because the
 * merge-request description wants backticks and the review pane draws its own
 * <code> element around the same text.
 */
export function summarizeValue(value) {
  if (value === undefined) {
    return "—";
  }
  if (Array.isArray(value)) {
    return `(${value.length} ${plural(value.length, "item")})`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).length;
    return `(${keys} ${plural(keys, "key")})`;
  }
  return truncate(value === null ? "null" : String(value));
}

// The Markdown form: a scalar is shown in backticks, a summary stands as it
// is - `(2 items)` in backticks would read as a value someone typed.
function render(value) {
  const text = summarizeValue(value);
  if (value === undefined || Array.isArray(value) || isPlainObject(value)) {
    return text;
  }
  return `\`${text}\``;
}

export function describeChanges(changes) {
  return changes.map((change) => {
    if (change.kind === "added") {
      return `- **${change.label}** added`;
    }
    if (change.kind === "removed") {
      return `- **${change.label}** removed`;
    }
    if (change.order) {
      // A list reordering: there is no old/new value to show.
      return `- **${change.label}** changed`;
    }
    return `- **${change.label}** changed: `
      + `${render(change.before)} → ${render(change.after)}`;
  }).join("\n");
}
