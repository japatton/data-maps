// The Markdown form of an analysis run: the same content the workbench
// panels draw, in one document an admin can paste into a ticket.
//
// Pure string work — no DOM, no network — so the tests can render a whole
// report from a fixture. Everything it renders (except the catalog's own
// names) came out of a language model, so nothing is trusted: values are
// only ever concatenated as text, and table cells are escaped.

const NOT_RUN = "Not run.";

/**
 * The whole report.
 *
 * identify   — the IDENTIFY_SCHEMA result, or null when the step never ran
 * choice     — {technology: {id, name, vendor}, dataset: {id, name}, format}
 *              as finally chosen (the admin may have overridden identify)
 * assess     — the ASSESS_SCHEMA result after `checkEcsNames`, or null
 * elastic    — {dataStream, docCount, targets, extras} or {dataStream, error},
 *              or null/undefined when the sample was never taken; the section
 *              is omitted entirely in that case
 * ecsVersion — the dictionary's version, named when a suggestion is not in it
 */
export function reportMarkdown({ identify, choice, assess, elastic, ecsVersion } = {}) {
  const parts = [
    "# Log sample analysis",
    identification(identify, choice),
    summary(assess),
    observedFields(assess, ecsVersion),
    inventoryNotObserved(assess),
    alertingTargets(assess, ecsVersion),
    parsing(assess),
    catalogEdits(assess),
  ];
  if (elastic) parts.push(elasticSample(elastic));
  return parts.join("\n\n") + "\n";
}

function identification(identify, choice) {
  const lines = ["## Identification", ""];
  if (!identify && !choice) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  if (identify) {
    lines.push(
      "- Technology: " + code(identify.technology_id),
      "- Dataset: " + code(identify.dataset_id),
      "- Format: " + code(identify.format),
      "- Confidence: " + number(identify.confidence),
    );
    if (identify.unknown && (identify.unknown.name || identify.unknown.vendor)) {
      lines.push(
        "- Not in the catalog: " + text(identify.unknown.name) +
        " (" + text(identify.unknown.vendor) + ")",
      );
    }
    const evidence = list(identify.evidence);
    lines.push("", "Evidence:", "");
    if (evidence.length) {
      for (const item of evidence) lines.push("- " + inline(item));
    } else {
      lines.push("- (none given)");
    }
    const alternatives = list(identify.alternatives);
    if (alternatives.length) {
      lines.push("", "Alternatives:", "");
      for (const alt of alternatives) {
        lines.push(
          "- " + code(alt && alt.technology_id) + " / " + code(alt && alt.dataset_id) +
          " — " + inline(alt && alt.reason),
        );
      }
    }
  } else {
    lines.push("The model was not asked; the entry below was chosen by hand.");
  }
  if (choice) {
    lines.push(
      "",
      "Assessed as: " + code(pick(choice.technology, "id")) + " / " +
      code(pick(choice.dataset, "id")) + " / " + code(choice.format),
    );
    const names = [pick(choice.technology, "name"), pick(choice.dataset, "name")]
      .filter(Boolean);
    if (names.length) lines.push("(" + names.map(inline).join(" — ") + ")");
  }
  return lines.join("\n");
}

function summary(assess) {
  const lines = ["## Summary", ""];
  if (!assess) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  lines.push(inline(assess.summary) || "(the model returned no summary)");
  if (assess.confidence !== undefined && assess.confidence !== null) {
    lines.push("", "Confidence: " + number(assess.confidence));
  }
  return lines.join("\n");
}

const OBSERVED_COLUMNS = [
  "field", "example", "in inventory", "inventory field", "suggested ECS",
  "status", "note",
];

function observedFields(assess, ecsVersion) {
  const lines = ["## Observed fields", ""];
  const rows = assess ? list(assess.observed_fields) : [];
  if (!assess) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  if (!rows.length) {
    lines.push("The model reported no fields.");
    return lines.join("\n");
  }
  lines.push(...table(OBSERVED_COLUMNS, rows.map((row) => [
    cellCode(row.name),
    cellCode(row.example),
    row.in_inventory ? "yes" : "no",
    cellCode(row.inventory_vendor),
    ecsCell(row.suggested_ecs, row.ecs_known, ecsVersion, row.ecs_list),
    cell(row.suggested_status),
    cell(row.note),
  ])));
  return lines.join("\n");
}

function inventoryNotObserved(assess) {
  const lines = ["## Inventory fields not observed", ""];
  if (!assess) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  const rows = list(assess.inventory_not_observed);
  if (!rows.length) {
    lines.push("Every inventory field appears in the sample.");
    return lines.join("\n");
  }
  for (const row of rows) {
    lines.push("- " + code(row.vendor) + " — " + inline(row.note));
  }
  return lines.join("\n");
}

const GAP_COLUMNS = ["ECS target", "in sample", "note"];

function alertingTargets(assess, ecsVersion) {
  const lines = ["## Alerting-required targets", ""];
  if (!assess) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  const rows = list(assess.alerting_gaps);
  if (!rows.length) {
    lines.push("This dataset's categories require no targets.");
    return lines.join("\n");
  }
  lines.push(...table(GAP_COLUMNS, rows.map((row) => [
    ecsCell(row.ecs, row.ecs_known, ecsVersion, row.ecs_list),
    row.present_in_log ? "yes" : "no",
    cell(row.note),
  ])));
  return lines.join("\n");
}

function parsing(assess) {
  const lines = ["## Parsing", ""];
  const rec = assess && assess.parsing;
  if (!assess || !rec) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  lines.push(
    "- Mechanism: " + code(rec.mechanism),
    "- Parse location: " + code(rec.parse_location),
    "",
    inline(rec.rationale),
  );
  return lines.join("\n");
}

function catalogEdits(assess) {
  const lines = ["## Suggested catalog edits", ""];
  if (!assess) {
    lines.push(NOT_RUN);
    return lines.join("\n");
  }
  const rows = list(assess.catalog_edits);
  if (!rows.length) {
    lines.push("The model suggested no edits.");
    return lines.join("\n");
  }
  for (const row of rows) {
    lines.push("- " + inline(row.where) + " — " + inline(row.change));
  }
  return lines.join("\n");
}

const PRESENCE_COLUMNS = ["inventory field", "ECS target", "present"];

function elasticSample(elastic) {
  const lines = ["## Elasticsearch sample", ""];
  lines.push("Data stream: " + code(elastic.dataStream));
  if (elastic.error) {
    lines.push("", inline(elastic.error));
    return lines.join("\n");
  }
  const count = Number(elastic.docCount || 0);
  lines.push("", count + (count === 1 ? " document sampled." : " documents sampled."));
  const targets = list(elastic.targets);
  lines.push("");
  if (targets.length) {
    lines.push(...table(PRESENCE_COLUMNS, targets.map((row) => [
      cellCode(row.vendor),
      cellCode(row.ecs),
      row.present ? "yes" : "no",
    ])));
  } else {
    lines.push("The chosen format maps no field to an ECS target.");
  }
  const extras = list(elastic.extras);
  lines.push("", "Populated ECS fields the inventory does not map:", "");
  if (extras.length) {
    for (const name of extras) lines.push("- " + code(name));
  } else {
    lines.push("- (none)");
  }
  return lines.join("\n");
}

// --- dataset facts the prompts and panels quote --------------------------
//
// These two describe a dataset rather than the report, but both the analyze
// view and the assess prompt need them and neither belongs to the other, so
// they live here with the rest of the pure rendering.

/** `flat` is this module's `inline`: one line, whitespace folded. */
const flat = inline;

/** Per side present, the hops joined by an arrow; sides joined by "; ". */
export function routeSummary(route) {
  const sides = [];
  for (const side of ["direct", "guarded"]) {
    const hops = route && Array.isArray(route[side]) ? route[side] : [];
    if (!hops.length) continue;
    sides.push(`${side}: ${hops.map(hopLabel).join(" → ")}`);
  }
  return sides.join("; ");
}

function hopLabel(hop) {
  if (!hop || typeof hop !== "object") return "";
  const detail = flat(hop.location || hop.device || hop.name || hop.data_stream);
  return detail ? `${flat(hop.hop)} (${detail})` : flat(hop.hop);
}

/** The union of the alerting profiles for a dataset's event categories. */
export function requiredEcs(dataset, schema) {
  const profiles = (schema && schema.profiles) || {};
  const seen = new Set();
  const out = [];
  for (const category of (dataset && dataset.event_categories) || []) {
    for (const name of profiles[category] || []) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// --- cells and scalars ---------------------------------------------------

function table(columns, rows) {
  const out = ["| " + columns.join(" | ") + " |"];
  out.push("|" + columns.map(() => " --- ").join("|") + "|");
  for (const row of rows) out.push("| " + row.join(" | ") + " |");
  return out;
}

/** One line of plain text: whitespace folded, nothing else touched. */
function inline(value) {
  return text(value).replace(/\s+/g, " ").trim();
}

function text(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** A table cell: one line, with the column separator escaped. */
function cell(value) {
  const flat = inline(value).replace(/\|/g, "\\|");
  return flat === "" ? "—" : flat;
}

function cellCode(value) {
  const flat = inline(value);
  return flat === "" ? "—" : "`" + flat.replace(/\|/g, "\\|").replace(/`/g, "'") + "`";
}

/** Backticked, or an em dash when the model returned null. */
function code(value) {
  const flat = inline(value);
  return flat === "" ? "—" : "`" + flat.replace(/`/g, "'") + "`";
}

/**
 * An ECS suggestion cell.
 *
 * A model asked for one target sometimes answers with several, and
 * `checkEcsNames` splits those into `list` with one flag per name in
 * `known`; each name is then marked on its own rather than the whole answer
 * being struck through as one unknown string.
 */
function ecsCell(name, known, ecsVersion, list) {
  if (Array.isArray(list) && list.length) {
    const flags = Array.isArray(known) ? known : [];
    return list
      .map((item, index) => ecsName(item, flags[index], ecsVersion))
      .join(", ");
  }
  // A flag array with no list to go with it says nothing about the name.
  return ecsName(name, Array.isArray(known) ? null : known, ecsVersion);
}

/**
 * One ECS name. `known === false` means `checkEcsNames` looked it up and did
 * not find it, so the name is struck through and the version that rejected
 * it is named; `null` means there was nothing to check.
 */
function ecsName(name, known, ecsVersion) {
  const flat = inline(name);
  if (flat === "") return "—";
  const safe = flat.replace(/\|/g, "\\|");
  if (known === false) {
    return "~~" + safe + "~~ (not in ECS " + (inline(ecsVersion) || "?") + ")";
  }
  return "`" + safe.replace(/`/g, "'") + "`";
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

function pick(obj, key) {
  return obj && typeof obj === "object" ? obj[key] : null;
}
