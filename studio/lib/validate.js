// Rule-for-rule port of datamaps/schema.py to the browser.
//
// Every message string is copied verbatim from schema.py, including the
// `where` prefixes, and the checks fire in the same order, so Studio shows
// the operator exactly what the Python build would raise.  `validate_profiles`
// is deliberately not ported: the profile file is not editable in Studio.
//
// An issue is {path, message}.  `path` locates the offending key relative to
// the document being validated (a technology document for validateTechnology,
// the catalog document for validateCatalog, the {catalog, technologies}
// bundle for validateAll); a whole-object error carries the object's path.
//
// Which keys each node accepts, and which of them are required, come from
// the published tables (`schema.vocab.key_order` / `schema.vocab.required`,
// written by schema.py's KEY_ORDER / REQUIRED) rather than from copies kept
// here, so a key is added or moved in exactly one place.
//
// Every issue owns its path array outright: a check that reports the object
// it was handed pushes `path.slice()`, never the caller's own array, and a
// check that names a key pushes a fresh `path.concat(key)`.  A caller is
// therefore free to keep, sort or splice an issue's path without one issue's
// path turning into another's.

const SLUG_RE_CACHE = new WeakMap();

function slugRe(schema) {
  let re = SLUG_RE_CACHE.get(schema);
  if (re === undefined) {
    re = new RegExp(schema.vocab.slug_pattern);
    SLUG_RE_CACHE.set(schema, re);
  }
  return re;
}

// {required, optional} for one node of the key tables: the required list in
// the table's own order - which is the order the "missing key" messages come
// out in - and everything else the node allows.  `kind` names the sub-table
// for the two nodes that have one ("hop", "recommendation_side").
//
// Cached per schema object: the arrays are rebuilt for no document.
const KEYS_CACHE = new WeakMap();

function nodeKeys(schema, node, kind) {
  let cache = KEYS_CACHE.get(schema);
  if (cache === undefined) {
    cache = new Map();
    KEYS_CACHE.set(schema, cache);
  }
  const at = kind === undefined ? node : node + "/" + kind;
  let keys = cache.get(at);
  if (keys === undefined) {
    const table = schema.vocab.key_order[node];
    const order = kind === undefined ? table : table[kind];
    const required = schema.vocab.required[node];
    keys = {
      required: required,
      optional: order.filter((key) => !required.includes(key)),
    };
    cache.set(at, keys);
  }
  return keys;
}

function isStr(value) {
  return typeof value === "string";
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return isMapping(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

// Render a value the way Python's %s would, so interpolated non-strings read
// the same in both implementations.
function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (isStr(value)) return value;
  return JSON.stringify(value);
}

// The Python fixtures use `.get(key, "?")`: absent means "?", present-but-None
// means "None".
function nameOf(obj, key) {
  return hasOwn(obj, key) ? pyStr(obj[key]) : "?";
}

function checkKeys(obj, required, optional, where, path, issues) {
  if (!isMapping(obj)) {
    issues.push({ path: path.slice(), message: `${where}: must be a mapping` });
    return false;
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) {
      issues.push({
        path: path.concat(key),
        message: `${where}: unknown key '${key}'`,
      });
    }
  }
  let ok = true;
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      issues.push({
        path: path.slice(),
        message: `${where}: missing key '${key}'`,
      });
      ok = false;
    }
  }
  return ok;
}

function checkStr(obj, key, where, path, issues,
                  { vocab = null, pattern = null, optional = false } = {}) {
  // One array per issue: `at` is rebuilt for each push below.
  const at = path.concat(key);
  if (!hasOwn(obj, key) || obj[key] === null || obj[key] === undefined) {
    if (!optional) {
      issues.push({
        path: at.slice(),
        message: `${where}: '${key}' must be a non-empty string`,
      });
    }
    return;
  }
  const value = obj[key];
  if (!isStr(value) || !value.trim()) {
    issues.push({
      path: at.slice(),
      message: `${where}: '${key}' must be a non-empty string`,
    });
    return;
  }
  if (vocab !== null && !vocab.includes(value)) {
    issues.push({
      path: at.slice(),
      message: `${where}: '${key}' value '${value}' not one of: `
             + `${vocab.join(", ")}`,
    });
  }
  if (pattern !== null && !pattern.test(value)) {
    issues.push({
      path: at.slice(),
      message: `${where}: '${key}' value '${value}' is not a valid slug`,
    });
  }
}

export function isSlug(value, schema) {
  return isStr(value) && slugRe(schema).test(value);
}

export function validateCatalog(doc, schema) {
  const vocab = schema.vocab;
  const issues = [];
  if (!checkKeys(doc, ["technologies"], [], "catalog", [], issues)) {
    return issues;
  }
  const rows = doc.technologies;
  if (!Array.isArray(rows) || rows.length === 0) {
    return [{
      path: ["technologies"],
      message: "catalog: 'technologies' must be a non-empty list",
    }];
  }
  const seen = new Set();
  const keys = nodeKeys(schema, "catalog_row");
  rows.forEach((row, position) => {
    const where = `catalog[${position}]`;
    const path = ["technologies", position];
    if (!checkKeys(row, keys.required, keys.optional, where, path, issues)) {
      return;
    }
    checkStr(row, "id", where, path, issues, { pattern: slugRe(schema) });
    checkStr(row, "name", where, path, issues);
    checkStr(row, "vendor", where, path, issues);
    checkStr(row, "category", where, path, issues,
             { vocab: vocab.categories });
    checkStr(row, "status", where, path, issues, { vocab: vocab.statuses });
    checkStr(row, "priority", where, path, issues,
             { vocab: vocab.priorities });
    const key = row.id;
    if (seen.has(key)) {
      issues.push({
        path: path.concat("id"),
        message: `${where}: duplicate technology id '${pyStr(key)}'`,
      });
    }
    seen.add(key);
  });
  return issues;
}

function validateField(field, whereDs, path, seenVendor, schema, issues) {
  const fw = `${whereDs} field '${nameOf(field, "vendor")}'`;
  const keys = nodeKeys(schema, "field");
  if (!checkKeys(field, keys.required, keys.optional, fw, path, issues)) {
    return;
  }
  checkStr(field, "vendor", fw, path, issues);
  checkStr(field, "status", fw, path, issues,
           { vocab: schema.vocab.field_statuses });
  const vendor = field.vendor;
  if (seenVendor.has(vendor)) {
    issues.push({
      path: path.concat("vendor"),
      message: `${fw}: duplicate vendor field`,
    });
  }
  seenVendor.add(vendor);
  const ecsValue = field.ecs;
  if (ecsValue !== null && ecsValue !== undefined) {
    if (!isStr(ecsValue)) {
      issues.push({
        path: path.concat("ecs"),
        message: `${fw}: 'ecs' must be a string or null`,
      });
    } else if (!hasOwn(schema.ecs, ecsValue)) {
      issues.push({
        path: path.concat("ecs"),
        message: `${fw}: ecs field '${ecsValue}' is not in the vendored ECS `
               + "dictionary",
      });
    }
  }
}

function validateRecommendations(recs, where, path, schema, issues) {
  const sides = schema.vocab.key_order.recommendation_side;
  const keys = nodeKeys(schema, "recommendations");
  const rw = `${where} recommendations`;
  if (!checkKeys(recs, keys.required, keys.optional, rw, path, issues)) return;
  if (Object.keys(recs).length === 0) {
    issues.push({ path: path.slice(), message: `${rw}: must not be empty` });
    return;
  }
  for (const side of Object.keys(recs).sort()) {
    if (!hasOwn(sides, side)) continue;
    const body = recs[side];
    const sw = `${rw}.${side}`;
    const sp = path.concat(side);
    const sideKeys = nodeKeys(schema, "recommendation_side", side);
    if (!checkKeys(body, sideKeys.required, sideKeys.optional, sw, sp,
                   issues)) continue;
    if (Object.keys(body).length === 0) {
      issues.push({
        path: sp.slice(),
        message: `${sw}: must not be empty`,
      });
      continue;
    }
    checkStr(body, "parse_location", sw, sp, issues,
             { vocab: schema.vocab.parse_locations, optional: true });
    for (const key of ["cribl", "elastic", "relay"]) {
      if (sides[side].includes(key)) {
        checkStr(body, key, sw, sp, issues, { optional: true });
      }
    }
  }
}

function validateFormat(entry, whereDs, path, seenFormats, schema, issues) {
  const fw = `${whereDs} format '${nameOf(entry, "format")}'`;
  const keys = nodeKeys(schema, "format");
  if (!checkKeys(entry, keys.required, keys.optional, fw, path, issues)) {
    return;
  }
  checkStr(entry, "format", fw, path, issues,
           { vocab: schema.vocab.source_formats });
  const name = entry.format;
  if (seenFormats.has(name)) {
    issues.push({
      path: path.concat("format"),
      message: `${fw}: duplicate format`,
    });
  }
  seenFormats.add(name);
  let recommended = hasOwn(entry, "recommended") ? entry.recommended : false;
  if (typeof recommended !== "boolean") {
    issues.push({
      path: path.concat("recommended"),
      message: `${fw}: 'recommended' must be true or false`,
    });
    recommended = false;
  }
  if (recommended) {
    checkStr(entry, "recommended_because", fw, path, issues);
  } else if (hasOwn(entry, "recommended_because")) {
    issues.push({
      path: path.concat("recommended_because"),
      message: `${fw}: 'recommended_because' requires 'recommended: true' - `
             + "a reason with nothing to justify",
    });
  }
  checkStr(entry, "enable", fw, path, issues, { optional: true });
  if (hasOwn(entry, "references")
      && !(Array.isArray(entry.references) && entry.references.every(isStr))) {
    issues.push({
      path: path.concat("references"),
      message: `${fw}: 'references' must be a list of strings`,
    });
  }
  const pw = `${fw} parsing`;
  const pp = path.concat("parsing");
  const parsingKeys = nodeKeys(schema, "parsing");
  if (checkKeys(entry.parsing, parsingKeys.required, parsingKeys.optional,
                pw, pp, issues)) {
    checkStr(entry.parsing, "mechanism", pw, pp, issues,
             { vocab: schema.vocab.mechanisms });
  }
  if (hasOwn(entry, "recommendations")) {
    validateRecommendations(entry.recommendations, fw,
                            path.concat("recommendations"), schema, issues);
  }
  const fields = entry.fields;
  if (!Array.isArray(fields)) {
    issues.push({
      path: path.concat("fields"),
      message: `${fw}: 'fields' must be a list`,
    });
  } else {
    const seenVendor = new Set();
    fields.forEach((field, index) => {
      validateField(field, fw, path.concat("fields", index), seenVendor,
                    schema, issues);
    });
  }
  // A deliberately empty inventory says so in prose; the rationale is
  // published in place of the table and silences the format-no-fields flag.
  if (hasOwn(entry, "fields_omitted")) {
    checkStr(entry, "fields_omitted", fw, path, issues);
    if (Array.isArray(fields) && fields.length) {
      issues.push({
        path: path.concat("fields_omitted"),
        message: `${fw}: 'fields_omitted' documents an empty inventory, but `
               + "'fields' is not empty",
      });
    }
  }
}

function validateHops(hops, sw, sp, schema, issues) {
  const vocab = schema.vocab;
  let guardHops = 0;
  hops.forEach((hop, position) => {
    const hw = `${sw}[${position}]`;
    const hp = sp.concat(position);
    if (!isMapping(hop) || !hasOwn(hop, "hop")) {
      issues.push({
        path: hp.slice(),
        message: `${hw}: each hop needs a 'hop' key`,
      });
      return;
    }
    const kind = hop.hop;
    if (!vocab.hops.includes(kind)) {
      issues.push({
        path: hp.concat("hop"),
        message: `${hw}: hop '${pyStr(kind)}' not one of: `
               + `${vocab.hops.join(", ")}`,
      });
      return;
    }
    const keys = nodeKeys(schema, "hop", kind);
    checkKeys(hop, keys.required, keys.optional, hw, hp, issues);
    if (kind === "guard") guardHops += 1;
  });
  return guardHops;
}

function validateRoute(route, where, path, schema, issues) {
  const rw = `${where} route`;
  const keys = nodeKeys(schema, "route");
  if (!checkKeys(route, keys.required, keys.optional, rw, path, issues)) {
    return;
  }
  for (const side of ["guarded", "direct"]) {
    if (!hasOwn(route, side)) continue;
    const hops = route[side];
    const sw = `${rw}.${side}`;
    const sp = path.concat(side);
    if (!Array.isArray(hops) || hops.length === 0) {
      issues.push({
        path: sp.slice(),
        message: `${sw}: must be a non-empty list`,
      });
      continue;
    }
    const guardHops = validateHops(hops, sw, sp, schema, issues);
    if (side === "guarded" && guardHops === 0) {
      issues.push({
        path: sp.slice(),
        message: `${sw}: guarded route has no guard hop`,
      });
    }
    if (side === "direct" && guardHops) {
      issues.push({
        path: sp.slice(),
        message: `${sw}: direct route must not contain a guard hop`,
      });
    }
  }
}

function validateDataset(ds, techId, path, seenDs, schema) {
  const issues = [];
  const where = `${techId} dataset '${nameOf(ds, "id")}'`;
  const keys = nodeKeys(schema, "dataset");
  if (!checkKeys(ds, keys.required, keys.optional, where, path, issues)) {
    return issues;
  }
  checkStr(ds, "id", where, path, issues, { pattern: slugRe(schema) });
  checkStr(ds, "name", where, path, issues);
  if (seenDs.has(ds.id)) {
    issues.push({
      path: path.concat("id"),
      message: `${where}: duplicate dataset id`,
    });
  }
  seenDs.add(ds.id);
  const cats = ds.event_categories;
  if (!Array.isArray(cats) || cats.length === 0) {
    issues.push({
      path: path.concat("event_categories"),
      message: `${where}: 'event_categories' must be a non-empty list`,
    });
  } else {
    cats.forEach((cat, index) => {
      if (!hasOwn(schema.profiles, cat)) {
        issues.push({
          path: path.concat("event_categories", index),
          message: `${where}: event category '${pyStr(cat)}' has no alerting `
                 + "profile",
        });
      }
    });
  }
  validateRoute(ds.route, where, path.concat("route"), schema, issues);
  const formats = ds.formats;
  if (!Array.isArray(formats) || formats.length === 0) {
    issues.push({
      path: path.concat("formats"),
      message: `${where}: 'formats' must be a non-empty list`,
    });
    return issues;
  }
  const route = ds.route;
  const noGuardedRoute = isMapping(route) && !hasOwn(route, "guarded");
  const seenFormats = new Set();
  let overrides = 0;
  formats.forEach((entry, index) => {
    const fp = path.concat("formats", index);
    validateFormat(entry, where, fp, seenFormats, schema, issues);
    if (isMapping(entry) && entry.recommended) overrides += 1;
    const recs = isMapping(entry) ? entry.recommendations : undefined;
    if (noGuardedRoute && isMapping(recs) && hasOwn(recs, "guarded")) {
      issues.push({
        path: fp.concat("recommendations", "guarded"),
        message: `${where} format '${nameOf(entry, "format")}': guarded `
               + "recommendations but route has no guarded side",
      });
    }
  });
  if (overrides > 1) {
    issues.push({
      path: path.slice(),
      message: `${where}: at most one format may set 'recommended: true' `
             + `(found ${overrides})`,
    });
  }
  return issues;
}

export function validateTechnology(doc, expectedId, schema) {
  const issues = [];
  const where = `technology '${expectedId}'`;
  const keys = nodeKeys(schema, "technology");
  if (!checkKeys(doc, keys.required, keys.optional, where, [], issues)) {
    return issues;
  }
  if (doc.id !== expectedId) {
    issues.push({
      path: ["id"],
      message: `${where}: id '${nameOf(doc, "id")}' does not match filename`,
    });
  }
  checkStr(doc, "name", where, [], issues);
  checkStr(doc, "vendor", where, [], issues);
  if (hasOwn(doc, "draft") && typeof doc.draft !== "boolean") {
    issues.push({
      path: ["draft"],
      message: `${where}: 'draft' must be true or false`,
    });
  }
  if (hasOwn(doc, "references")
      && !(Array.isArray(doc.references) && doc.references.every(isStr))) {
    issues.push({
      path: ["references"],
      message: `${where}: 'references' must be a list of strings`,
    });
  }
  checkStr(doc, "versions", where, [], issues, { optional: true });
  const datasets = doc.datasets;
  if (!Array.isArray(datasets) || datasets.length === 0) {
    issues.push({
      path: ["datasets"],
      message: `${where}: 'datasets' must be a non-empty list`,
    });
    return issues;
  }
  const seenDs = new Set();
  datasets.forEach((ds, index) => {
    for (const issue of validateDataset(ds, expectedId,
                                        ["datasets", index], seenDs, schema)) {
      issues.push(issue);
    }
  });
  return issues;
}

// Cross-document checks only - the per-document checks are run by
// validateCatalog / validateTechnology.  `technologies` is {techId: doc}.
// `schema` is accepted for signature symmetry; these two rules do not use it.
export function validateAll({ catalog, technologies } = {}, schema) {
  const issues = [];
  const docs = isMapping(technologies) ? technologies : {};
  const rows = new Map();
  const catRows = isMapping(catalog) && Array.isArray(catalog.technologies)
    ? catalog.technologies : [];
  // Python builds this map with a dict comprehension over the rows, so a
  // duplicated id is the *last* row's, not the first one's.  The duplicate
  // itself is validateCatalog's to report; here the two must simply agree on
  // which row a technology file is checked against.
  catRows.forEach((row, index) => {
    if (isMapping(row) && isStr(row.id)) {
      rows.set(row.id, { row, index });
    }
  });
  for (const techId of Object.keys(docs).sort()) {
    if (!rows.has(techId)) {
      issues.push({
        path: ["technologies", techId],
        message: `technology '${techId}' has a file but no catalog row`,
      });
    }
  }
  for (const techId of Array.from(rows.keys()).sort()) {
    const { row, index } = rows.get(techId);
    if (row.status !== "planned" && !hasOwn(docs, techId)) {
      issues.push({
        path: ["catalog", "technologies", index],
        message: `catalog: '${techId}' is ${pyStr(row.status)} but has no `
               + `data/technologies/${techId}.yml`,
      });
    }
  }
  return issues;
}
